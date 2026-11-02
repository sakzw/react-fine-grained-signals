import { parseSync, traverse, types as t, type NodePath } from "@babel/core";
import { describe, expect, it, onTestFailed } from "vitest";
import { transformReactFineGrainedSignals, type ReactFineGrainedSignalsTransform } from "../src/internal/transform.js";
import { cases, component, hook, hookCases, type Case } from "./read-shapes.js";

// Whether a read is a render read is decided in several places: which
// functions auto mode selects, what the managed pass captures, which parameter
// defaults move, and what the inject pass wraps. Each case (`read-shapes.ts`)
// places one read of `s` in some context; this test checks that those
// decisions agree:
//
// 1. A component whose only read is the target is selected exactly when the
//    same component with an unrelated render read (`o.value`) added captures
//    the target. The two used to disagree for async callbacks and helper calls
//    in parameter defaults, so a component's subscription to `s` depended on
//    whether it happened to read something else. The same holds for a custom
//    Hook, whose unrelated read is a plain `return o.value`.
// 2. Managed and inject select the same components.
//
// Selection is derived from the capture pass (`wouldCaptureRenderRead` in the
// transform), so a disagreement here means one of the shared predicates is
// missing a shape, not that two rule sets drifted apart.

function transform(source: string, transform: ReactFineGrainedSignalsTransform): string | undefined {
  return transformReactFineGrainedSignals(source, "Fixture.tsx", {
    importSource: "react-fine-grained-signals",
    mode: "auto",
    transform,
    reactCompiler: "off",
    reactImportSource: "react",
    warn: () => {},
  })?.code;
}

interface Subject {
  /** The boundary the transform put at the top of the function under test, if any. */
  boundary: "capture" | "tracking" | undefined;
  /** The source of every `capture`/`iterate`/`forIn` argument that function's own store makes. */
  captures: string[];
}

/** Finds the function whose body holds `marker` and reads what the transform did to it. */
function inspect(code: string | undefined): Subject {
  if (code === undefined) return { boundary: undefined, captures: [] };
  const ast = parseSync(code, {
    babelrc: false,
    configFile: false,
    filename: "Out.tsx",
    parserOpts: { plugins: ["jsx", "typescript"] },
  });
  let subject: Subject = { boundary: undefined, captures: [] };
  traverse(ast!, {
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id, { name: "__subject" })) return;
      const fn = path.getFunctionParent()!;
      const statements = (fn.node.body as t.BlockStatement).body;
      let store: string | undefined;
      let boundary: Subject["boundary"];
      for (const statement of statements) {
        if (t.isVariableDeclaration(statement)) {
          const init = statement.declarations[0]?.init;
          if (
            t.isCallExpression(init) &&
            t.isIdentifier(init.callee) &&
            init.callee.name.endsWith("useSignalCapture")
          ) {
            boundary = "capture";
            store = (statement.declarations[0]!.id as t.Identifier).name;
          }
        } else if (
          t.isExpressionStatement(statement) &&
          t.isCallExpression(statement.expression) &&
          t.isIdentifier(statement.expression.callee) &&
          statement.expression.callee.name.endsWith("useSignalTracking")
        ) {
          boundary = "tracking";
        }
      }
      const captures: string[] = [];
      if (store !== undefined) {
        fn.traverse({
          CallExpression(call: NodePath<t.CallExpression>) {
            const callee = call.node.callee;
            if (
              t.isMemberExpression(callee) &&
              t.isIdentifier(callee.object, { name: store }) &&
              t.isIdentifier(callee.property) &&
              ["capture", "iterate", "forIn"].includes(callee.property.name)
            ) {
              const argument = call.node.arguments[0]!;
              captures.push(code.slice(argument.start!, argument.end!));
            }
          },
        });
      }
      subject = { boundary, captures };
      path.stop();
    },
  });
  return subject;
}

interface Observed {
  selected: boolean;
  captured: boolean;
  injectSelected: boolean;
  /** The outputs, for the failure message. */
  outputs: string;
}

/** Transforms `testCase` alone and with its unrelated read, in both transforms, and reads the decisions. */
function observe(testCase: Case, build: (testCase: Case, companion: boolean) => string): Observed {
  const token = testCase.token ?? "s.value";
  const alone = transform(build(testCase, false), "managed");
  const withCompanion = transform(build(testCase, true), "managed");
  const injected = transform(build(testCase, false), "inject");
  return {
    selected: inspect(alone).boundary === "capture",
    captured: inspect(withCompanion).captures.some((argument) => argument.includes(token)),
    injectSelected: inspect(injected).boundary === "tracking",
    outputs: [alone, withCompanion, injected].map((code) => code ?? "(not transformed)").join("\n---\n"),
  };
}

function expected(testCase: Case, { captured }: Observed): { selected: boolean; captured: boolean } {
  const { selected, captured: capturedExpected } = testCase.expected ??
    testCase.knownLimitation ?? { selected: captured, captured };
  return { selected, captured: capturedExpected };
}

describe("selection, capture and inject agree on what a render read is", () => {
  it.each(cases)("$name", (testCase) => {
    const observed = observe(testCase, component);
    onTestFailed(() => console.error(observed.outputs));
    expect({ selected: observed.selected, captured: observed.captured }).toEqual(expected(testCase, observed));
    expect({ injectSelected: observed.injectSelected }).toEqual({ injectSelected: observed.selected });
  });
});

describe("the same agreement holds for a custom Hook", () => {
  it.each(hookCases)("$name", (testCase) => {
    const observed = observe(testCase, hook);
    onTestFailed(() => console.error(observed.outputs));
    expect({ selected: observed.selected, captured: observed.captured }).toEqual(expected(testCase, observed));
    expect({ injectSelected: observed.injectSelected }).toEqual({ injectSelected: observed.selected });
  });
});
