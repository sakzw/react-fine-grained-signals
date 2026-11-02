import { parseSync, traverse, types as t, type NodePath } from "@babel/core";
import { describe, expect, it, onTestFailed } from "vitest";
import { transformReactFineGrainedSignals, type ReactFineGrainedSignalsTransform } from "../src/internal/transform.js";

// Whether a read is a render read is decided in several places: which
// functions auto mode selects, what the managed pass captures, which parameter
// defaults move, and what the inject pass wraps. Each case below places one
// read of `s` in some context and checks that those decisions agree:
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

type Shape = "function" | "arrow" | "memo" | "forwardRef" | "default" | "async";

interface Case {
  readonly name: string;
  readonly params?: string;
  readonly body?: string;
  readonly jsx?: string;
  /** What a capture of the target contains; defaults to `s.value`. */
  readonly token?: string;
  /** Module-level code placed before the component. */
  readonly module?: string;
  /** How the component is declared; defaults to a plain function declaration. */
  readonly shape?: Shape;
  /**
   * A disagreement that is intentional by documented design, with the
   * citation. Only these cases may differ, and only in the stated way.
   */
  readonly expected?: { readonly selected: boolean; readonly captured: boolean; readonly why: string };
  /**
   * A disagreement that contradicts the documented design but cannot be fixed
   * in the transform alone. Pinned so that it is visible, and so that a fix
   * shows up here as a failure to update.
   */
  readonly knownLimitation?: { readonly selected: boolean; readonly captured: boolean; readonly why: string };
}

const prelude = `import { computed, signal, untracked, useComputed, useSignalEffect } from "react-fine-grained-signals";
import * as rfgs from "react-fine-grained-signals";
import { Show } from "react-fine-grained-signals/utils";
import { forwardRef, memo, use, useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { ext, extStore } from "./ext";
declare function log(value: unknown): void;
declare function List(props: { render: () => unknown }): null;
const s = signal(1);
const o = signal(2);
const st = signal({ a: 1 });
const list = signal([1, 2]);
const readS = () => s.value;
const items = [1, 2];
`;

// README.md, "Managed tracking contract": "Any other call is captured unless
// its callee is proven" -- a precaution, not proof that it reads -- while
// "Runtime key or alias" and "An imported helper body is not inspected to
// select a function in `auto` mode" keep such calls from selecting.
const precaution = { selected: false, captured: true } as const;

const cases: readonly Case[] = [
  { name: "a JSX child", jsx: "{s.value}" },
  { name: "a render-time const", body: "const x = s.value;", jsx: "{x}" },
  { name: "a helper call", body: "const x = readS();", jsx: "{x}", token: "readS(" },
  { name: "a conditional", params: "props: { f?: boolean }", body: "const x = props.f ? s.value : 0;", jsx: "{x}" },
  { name: "a template literal", body: "const x = `${s.value}`;", jsx: "{x}" },
  { name: "a try block", body: "let x = 0; try { x = s.value; } catch {}", jsx: "{x}" },
  { name: "a sync IIFE", body: "const x = (() => s.value)();", jsx: "{x}" },
  {
    name: "a called local function",
    body: "function now() { return s.value; } const x = now();",
    jsx: "{x}",
    token: "now(",
  },
  { name: "an uncalled local function", body: "function later() { return s.value; }", jsx: "{later.name}" },
  { name: "an alias", body: "const t = s; const x = t.value;", jsx: "{x}", token: "t.value" },
  { name: "a computed member", body: 'const x = s["value"];', jsx: "{x}", token: 's["value"]' },
  {
    name: "an object getter",
    body: "const obj = { get v() { return s.value; } }; const x = obj.v;",
    jsx: "{x}",
    token: "obj.v",
  },
  { name: "a sync forEach callback", body: "items.forEach(() => log(s.value));" },
  { name: "a map render callback", jsx: "{items.map((i) => <b key={i}>{s.value}</b>)}" },
  { name: "Array.from with a mapper", body: "const x = Array.from({ length: 1 }, () => s.value);", jsx: "{x}" },
  { name: "a parameter default", params: "{ label = s.value }: { label?: number }", jsx: "{label}" },
  {
    name: "a parameter default through a helper",
    params: "{ label = readS() }: { label?: number }",
    jsx: "{label}",
    token: "readS(",
  },
  { name: "peek", body: "const x = s.peek();", jsx: "{x}", token: "s.peek(" },
  { name: "untracked", body: "const x = untracked(() => s.value);", jsx: "{x}" },
  { name: "a useSignalEffect callback", body: "useSignalEffect(() => { log(s.value); });" },
  { name: "a useEffect callback", body: "useEffect(() => { log(s.value); }, []);" },
  { name: "a useMemo callback", body: "const x = useMemo(() => s.value, []);", jsx: "{x}" },
  { name: "a useCallback callback", body: "const f = useCallback(() => s.value, []);", jsx: "{f.name}" },
  { name: "a useState initializer", body: "const [x] = useState(() => s.value);", jsx: "{x}" },
  { name: "a useComputed getter", body: "const c = useComputed(() => s.value * 2);", jsx: "{c}" },
  { name: "an inline event handler", jsx: "<button onClick={() => log(s.value)} />" },
  { name: "a named event handler", body: "const onClick = () => log(s.value);", jsx: "<button onClick={onClick} />" },
  { name: "a ref callback", jsx: "<div ref={() => log(s.value)} />" },
  { name: "setTimeout", body: "setTimeout(() => log(s.value), 0);" },
  { name: "a promise continuation", body: "Promise.resolve().then(() => log(s.value));" },
  { name: "an async IIFE", body: "(async () => { log(s.value); })();" },
  {
    name: "an async forEach callback",
    body: "items.forEach(async () => { log(s.value); });",
    // Selection follows the design (an async function is outside the render),
    // but `items.forEach(...)` is still captured as a precaution once the
    // component is selected for another read, and forEach runs the callback's
    // synchronous prefix inside that capture. Keeping it out needs the
    // generated code to run the callback untracked, which the capture store
    // offers no way to do.
    knownLimitation: { ...precaution, why: "an async callback inside a captured call" },
  },
  { name: "a called async function", body: "async function load() { log(s.value); } void load();", token: "load(" },
  { name: "a generator", body: "function* g() { yield s.value; } const it = g();", jsx: "{String(it)}", token: "g(" },
  { name: "a render prop of another component", jsx: "<List render={() => s.value} />" },
  { name: "a Show children callback", jsx: "<Show when={o}>{() => s.value}</Show>" },

  // Calls of functions the module defines in other shapes.
  {
    name: "a class method called in render",
    module: "class Box { read() { return s.value; } }\nconst box = new Box();",
    body: "const x = box.read();",
    jsx: "{x}",
    token: "box.read(",
    expected: { ...precaution, why: "a class method is not a proven callee" },
  },
  {
    name: "a class getter",
    module: "class Box { get v() { return s.value; } }\nconst box = new Box();",
    body: "const x = box.v;",
    jsx: "{x}",
    token: "box.v",
  },
  {
    name: "a static class method",
    module: "class Util { static read() { return s.value; } }",
    body: "const x = Util.read();",
    jsx: "{x}",
    token: "Util.read(",
    expected: { ...precaution, why: "a class method is not a proven callee" },
  },
  {
    name: "an object method called in render",
    body: "const api = { read() { return s.value; } }; const x = api.read();",
    jsx: "{x}",
    token: "api.read(",
  },
  { name: "an uncalled object method", body: "const api = { read() { return s.value; } };", jsx: "{api.read.name}" },
  {
    name: "a module object method",
    module: "const api = { read: () => s.value };",
    body: "const x = api.read();",
    jsx: "{x}",
    token: "api.read(",
  },
  {
    name: "a method named peek",
    module: "const stack = { peek: () => s.value };",
    body: "const x = stack.peek();",
    jsx: "{x}",
    token: "stack.peek(",
  },
  {
    name: "a function returned from a helper and called",
    module: "const make = () => () => s.value;",
    body: "const x = make()();",
    jsx: "{x}",
    token: "make()(",
    expected: { ...precaution, why: "a callee that is a call result is chosen at run time" },
  },
  {
    name: "a closure stored in an array and called by index",
    body: "const fs = [() => s.value]; const x = fs[0]!();",
    jsx: "{x}",
    token: "fs[0]",
  },
  {
    name: "a handler picked by a runtime key",
    params: "props: { k: string }",
    body: "const handlers = { a: () => s.value, b() { return 0; } }; const x = handlers[props.k]();",
    jsx: "{x}",
    token: "handlers[props.k]",
  },
  {
    name: "a function chosen by a condition",
    params: "props: { f?: boolean }",
    body: "const pick = props.f ? () => s.value : () => 0; const x = pick();",
    jsx: "{x}",
    token: "pick(",
  },
  {
    name: "a reassigned local function",
    params: "props: { f?: boolean }",
    body: "let pick = () => 0; if (props.f) pick = () => s.value; const x = pick();",
    jsx: "{x}",
    token: "pick(",
  },
  { name: "a callback passed to an imported function", body: "const x = ext(() => s.value);", jsx: "{x}" },
  {
    name: "an options object handed to an imported function",
    body: "const opts = { cb: () => s.value }; const x = ext(opts);",
    jsx: "{x}",
    token: "ext(opts)",
  },
  {
    name: "a local function in an array handed to an imported function",
    body: "const cb = () => s.value; const x = ext([cb]);",
    jsx: "{x}",
    token: "ext([cb])",
  },
  {
    name: "an imported call alone",
    body: "const x = ext(1);",
    jsx: "{x}",
    token: "ext(",
    expected: { ...precaution, why: "an imported helper body is not inspected to select" },
  },
  { name: "a signal passed to an imported function", body: "const x = ext(s.value);", jsx: "{x}" },
  {
    name: "a method of an imported object with a reading callback",
    body: "const x = extStore.map(() => s.value);",
    jsx: "{x}",
  },
  {
    name: ".call",
    module: "function now() { return s.value; }",
    body: "const x = now.call(null);",
    jsx: "{x}",
    token: "now.call(",
  },
  {
    name: ".apply",
    module: "function now() { return s.value; }",
    body: "const x = now.apply(null, []);",
    jsx: "{x}",
    token: "now.apply(",
  },
  {
    name: ".bind then call",
    module: "function now() { return s.value; }",
    body: "const f = now.bind(null); const x = f();",
    jsx: "{x}",
    token: "f(",
    expected: { ...precaution, why: "a bound function held in a variable is not a proven callee" },
  },
  {
    name: "an optional call",
    module: "function now() { return s.value; }",
    body: "const x = now?.();",
    jsx: "{x}",
    token: "now?.(",
  },
  {
    name: "an optional member call",
    body: "const api = { read: () => s.value }; const x = api?.read();",
    jsx: "{x}",
    token: "api?.read(",
  },
  {
    name: "a tagged template whose tag reads",
    module: "const tag = (strings: TemplateStringsArray) => s.value + strings.length;",
    body: "const x = tag`a`;",
    jsx: "{x}",
    token: "tag`",
  },
  { name: "a read inside a tagged template", body: "const x = String.raw`${s.value}`;", jsx: "{x}" },
  {
    name: "a new expression whose class reads",
    module: "class Reader { v = s.value; }",
    body: "const x = new Reader().v;",
    jsx: "{x}",
    token: "new Reader(",
    expected: { ...precaution, why: "only a standard constructor is proven (`new C()`)" },
  },
  { name: "a Promise executor", body: "let x = 0; new Promise(() => { x = s.value; });", jsx: "{x}" },
  {
    name: "a named Promise executor",
    module: "function exec() { log(s.value); }",
    body: "new Promise(exec);",
    token: "new Promise(",
  },
  { name: "queueMicrotask", body: "queueMicrotask(() => log(s.value));" },
  { name: "requestAnimationFrame", body: "requestAnimationFrame(() => log(s.value));" },
  {
    name: "a named setTimeout callback",
    module: "function tick() { log(s.value); }",
    body: "setTimeout(tick, 0);",
    token: "setTimeout(",
  },
  { name: "a promise chain continuation", body: "Promise.resolve(1).then((v) => v).catch(() => log(s.value));" },
  { name: "replace with a reading callback", body: 'const x = "abc".replace("b", () => String(s.value));', jsx: "{x}" },
  {
    name: "filter on local data",
    body: "const local = [1, 2]; const x = local.filter(() => s.value > 0);",
    jsx: "{x}",
  },
  { name: "reduce with a reading callback", body: "const x = items.reduce((a) => a + s.value, 0);", jsx: "{x}" },
  {
    name: "map over useState data",
    body: "const [arr] = useState([1]); const x = arr.map(() => s.value);",
    jsx: "{x}",
  },
  { name: "a useReducer initializer", body: "const [x] = useReducer((a: number) => a, 0, () => s.value);", jsx: "{x}" },
  { name: "use()", body: "const x = use(Promise.resolve(s.value));", jsx: "{x}" },
  { name: "untracked through a namespace", body: "const x = rfgs.untracked(() => s.value);", jsx: "{x}" },
  {
    name: "peek on a computed",
    module: "const doubled = computed(() => s.value * 2);",
    body: "const x = doubled.peek();",
    jsx: "{x}",
    token: "doubled.peek(",
  },
  {
    name: "peek on a useComputed result",
    body: "const c = useComputed(() => 1); const x = c.peek();",
    jsx: "{x}",
    token: "c.peek(",
  },

  // Read shapes.
  { name: "a destructured signal accessor", body: "const { value } = s;", jsx: "{value}", token: "} = s" },
  { name: "a destructured signal value", body: "const { a } = st.value;", jsx: "{a}", token: "st.value" },
  { name: "an optional member read", body: "const x = s?.value;", jsx: "{x}", token: "s?.value" },
  { name: "a non-null read", body: "const x = s!.value;", jsx: "{x}", token: "s!.value" },
  { name: "an in check", body: 'const x = "a" in st.value;', jsx: "{String(x)}", token: "st.value" },
  { name: "a comma expression", body: "const x = (log(0), s.value);", jsx: "{x}" },
  { name: "a logical assignment", body: "let x: number | undefined; x ??= s.value;", jsx: "{x}" },
  { name: "a JSX attribute", jsx: "<b title={String(s.value)} />" },
  { name: "a key", jsx: "<b key={s.value} />" },
  { name: "a key in a map callback", jsx: "{items.map((i) => <b key={s.value + i} />)}" },
  {
    name: "spread props of a signal value",
    module: "const props = signal({ title: 'x' });",
    jsx: "<b {...props.value} />",
    token: "props.value",
  },
  { name: "spread props of an object literal", jsx: "<b {...{ title: s.value }} />" },
  {
    name: "for...of over a signal array",
    body: "let n = 0; for (const i of list.value) n += i;",
    jsx: "{n}",
    token: "list.value",
  },
  {
    name: "for...of over a reading generator",
    module: "function* gen() { yield s.value; }",
    body: "let n = 0; for (const v of gen()) n += v;",
    jsx: "{n}",
    token: "gen(",
  },
  {
    name: "for...in over a signal object",
    body: 'let k = ""; for (const key in st.value) k += key;',
    jsx: "{k}",
    token: "st.value",
  },

  // Control flow.
  {
    name: "a read after an early return",
    params: "props: { f?: boolean }",
    body: "if (props.f) return null; const x = s.value;",
    jsx: "{x}",
  },
  {
    name: "a switch case",
    params: "props: { k?: number }",
    body: "let x = 0; switch (props.k) { case 1: x = s.value; break; default: break; }",
    jsx: "{x}",
  },
  { name: "a labeled block", body: "let x = 0; done: { x = s.value; break done; }", jsx: "{x}" },
  { name: "a loop body", body: "let x = 0; for (let i = 0; i < 2; i++) x += s.value;", jsx: "{x}" },

  // Nested functions that own their own boundary.
  { name: "a nested component", body: "function Inner() { return <b>{s.value}</b>; }", jsx: "<Inner />" },
  {
    name: "a custom Hook called in render",
    module: "function useReadS() { return s.value; }",
    body: "const x = useReadS();",
    jsx: "{x}",
    token: "useReadS(",
  },
  {
    name: "a nested custom Hook",
    body: "function useInner() { return s.value; } const x = useInner();",
    jsx: "{x}",
    token: "useInner(",
  },
  {
    name: "a plain-called component",
    module: "function Title() { return <b>{s.value}</b>; }",
    jsx: "{Title()}",
    token: "Title(",
  },

  // Component shapes.
  { name: "an arrow component", shape: "arrow", jsx: "{s.value}" },
  { name: "a memo component", shape: "memo", jsx: "{s.value}" },
  { name: "a forwardRef component", shape: "forwardRef", params: "props: object, ref: unknown", jsx: "{s.value}" },
  { name: "a default export", shape: "default", jsx: "{s.value}" },
  {
    name: "a default export with a helper call",
    shape: "default",
    body: "const x = readS();",
    jsx: "{x}",
    token: "readS(",
  },
  // README "mode" and "Managed tracking contract": async and generator
  // functions are never selected, so neither side does anything.
  { name: "an async component", shape: "async", body: "await null; const x = s.value;", jsx: "{x}" },
];

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

/** Marks the body of the function under test, so its output can be found again. */
const marker = "const __subject = 0;";

function component(
  { params = "", body = "", jsx = "", module = "", shape = "function" }: Case,
  companion: boolean,
): string {
  const block = `{\n${marker}\n${body}\nreturn <p>${jsx}${companion ? "<i>{o.value}</i>" : ""}</p>;\n}`;
  const declaration = {
    function: `export function C(${params}) ${block}`,
    arrow: `export const C = (${params}) => ${block};`,
    memo: `export const C = memo(function C(${params}) ${block});`,
    forwardRef: `export const C = forwardRef(function C(${params}) ${block});`,
    default: `export default function C(${params}) ${block}`,
    async: `export async function C(${params}) ${block}`,
  }[shape];
  return `${prelude}${module}\n${declaration}\n`;
}

function hook({ params = "", body = "", module = "" }: Case, companion: boolean): string {
  return `${prelude}${module}\nexport function useX(${params}) {\n${marker}\n${body}\nreturn ${companion ? "o.value" : "0"};\n}\n`;
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

// The custom-Hook variant: no JSX, and the unrelated read is the Hook's return.
const hookCases = cases.filter(
  (testCase) =>
    (testCase.shape ?? "function") === "function" &&
    (testCase.body !== undefined || testCase.params !== undefined) &&
    !(testCase.jsx ?? "").includes("<") &&
    !(testCase.module ?? "").includes("<") &&
    !(testCase.body ?? "").includes("<"),
);

describe("the same agreement holds for a custom Hook", () => {
  it.each(hookCases)("$name", (testCase) => {
    const observed = observe(testCase, hook);
    onTestFailed(() => console.error(observed.outputs));
    expect({ selected: observed.selected, captured: observed.captured }).toEqual(expected(testCase, observed));
    expect({ injectSelected: observed.injectSelected }).toEqual({ injectSelected: observed.selected });
  });
});
