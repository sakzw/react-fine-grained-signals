// @vitest-environment jsdom
/// <reference lib="dom" />

/**
 * React Compiler compatibility, measured rather than assumed.
 *
 * The compiler caches a component's JSX in its memo cache. A `signal.value`
 * read it classifies as non-reactive (a module-scope binding) therefore runs
 * once and never again, which starves this library's render collector: the
 * next commit sees zero dependencies and drops every subscription. These tests
 * run the real pipeline (this package's transform, then
 * babel-plugin-react-compiler, then a JSX transform) and drive the result
 * through mount -> signal write -> DOM assertion, with `reactCompiler: "off"`
 * pinning the unguarded behavior the default now prevents.
 */

import { transformSync, type PluginObj } from "@babel/core";
import * as t from "@babel/types";
import reactCompiler, { type LoggerEvent } from "babel-plugin-react-compiler";
import { act, createElement, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as reactCompilerRuntime from "react/compiler-runtime";
import * as reactJsxRuntime from "react/jsx-runtime";
import { transformWithOxc } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import * as library from "../../../src/index.js";
import type { Signal } from "../../../src/index.js";
import * as libraryJsxRuntime from "../../../src/jsx-runtime.js";
import * as libraryRuntime from "../../../src/runtime.js";
import {
  transformReactAlienSignals,
  type ReactAlienSignalsMode,
  type ReactAlienSignalsReactCompiler,
  type ReactAlienSignalsTransform,
} from "../src/internal/transform.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const MODULES = "__modules";
const EXPORTS = "__exports";

const moduleRegistry: Record<string, unknown> = {
  "react/jsx-runtime": reactJsxRuntime,
  "react/compiler-runtime": reactCompilerRuntime,
  "react-alien-signals": library,
  "react-alien-signals/runtime": libraryRuntime,
  "react-alien-signals/jsx-runtime": libraryJsxRuntime,
};

// Rewrites the compiled ES module into something `new Function` can run, so a
// fixture keeps real module scope -- what the compiler's reactivity analysis
// looks at -- without needing a file on disk.
const moduleLinker: PluginObj = {
  name: "test-module-linker",
  visitor: {
    ImportDeclaration(path) {
      const properties = path.node.specifiers.map((specifier) => {
        if (!t.isImportSpecifier(specifier) || !t.isIdentifier(specifier.imported)) {
          throw path.buildCodeFrameError("fixtures only use named imports");
        }
        return t.objectProperty(
          t.identifier(specifier.imported.name),
          t.cloneNode(specifier.local),
        );
      });
      path.replaceWith(
        t.variableDeclaration("const", [
          t.variableDeclarator(
            t.objectPattern(properties),
            t.memberExpression(
              t.identifier(MODULES),
              t.stringLiteral(path.node.source.value),
              true,
            ),
          ),
        ]),
      );
    },
    ExportNamedDeclaration(path) {
      const declaration = path.node.declaration;
      if (declaration === null || declaration === undefined) {
        throw path.buildCodeFrameError("fixtures only use declaration exports");
      }
      const names: string[] = [];
      if (t.isVariableDeclaration(declaration)) {
        for (const declarator of declaration.declarations) {
          if (t.isIdentifier(declarator.id)) names.push(declarator.id.name);
        }
      } else if (
        (t.isFunctionDeclaration(declaration) || t.isClassDeclaration(declaration)) &&
        declaration.id !== null &&
        declaration.id !== undefined
      ) {
        names.push(declaration.id.name);
      }
      path.replaceWithMultiple([
        declaration,
        ...names.map((name) =>
          t.expressionStatement(
            t.assignmentExpression(
              "=",
              t.memberExpression(t.identifier(EXPORTS), t.identifier(name)),
              t.identifier(name),
            ),
          )
        ),
      ]);
    },
  },
};

interface PipelineOptions {
  mode?: ReactAlienSignalsMode;
  transform?: ReactAlienSignalsTransform;
  reactCompiler?: ReactAlienSignalsReactCompiler;
  /** Whether babel-plugin-react-compiler runs on this package's output. */
  compile?: boolean;
  /**
   * Whether this package's own transform runs at all. `false` measures a
   * hand-authored source exactly as the developer wrote it, which is the point
   * of the runtime-import cases below.
   */
  signalsTransform?: boolean;
  jsxImportSource?: string;
}

function applySignalsTransform(source: string, options: PipelineOptions): string {
  return (
    transformReactAlienSignals(source, "Fixture.jsx", {
      importSource: "react-alien-signals",
      mode: options.mode ?? "auto",
      transform: options.transform ?? "managed",
      reactCompiler: options.reactCompiler ?? "auto",
      reactImportSource: "react",
    })?.code ?? source
  );
}

function applyReactCompiler(
  source: string,
  compilerOptions: Record<string, unknown> = {},
): { code: string; events: LoggerEvent[] } {
  const events: LoggerEvent[] = [];
  const result = transformSync(source, {
    babelrc: false,
    configFile: false,
    filename: "Fixture.jsx",
    parserOpts: { plugins: ["jsx"] },
    plugins: [
      [
        reactCompiler,
        {
          ...compilerOptions,
          logger: {
            logEvent(_filename: string | null, event: LoggerEvent) {
              events.push(event);
            },
          },
        },
      ],
    ],
  });
  if (typeof result?.code !== "string") throw new Error("react compiler emitted no code");
  return { code: result.code, events };
}

function compilePipeline(
  source: string,
  options: PipelineOptions = {},
): { code: string; events: LoggerEvent[] } {
  const transformed = options.signalsTransform === false
    ? source
    : applySignalsTransform(source, options);
  if (options.compile === false) return { code: transformed, events: [] };
  return applyReactCompiler(transformed);
}

async function loadModule(
  source: string,
  options: PipelineOptions = {},
): Promise<Record<string, unknown>> {
  const { code } = compilePipeline(source, options);
  const jsx = await transformWithOxc(code, "Fixture.jsx", {
    lang: "jsx",
    jsx: { runtime: "automatic", importSource: options.jsxImportSource ?? "react" },
  });
  const linked = transformSync(jsx.code, {
    babelrc: false,
    configFile: false,
    filename: "Fixture.js",
    plugins: [moduleLinker],
  });
  if (typeof linked?.code !== "string") throw new Error("module linking emitted no code");
  const moduleExports: Record<string, unknown> = {};
  new Function(MODULES, EXPORTS, linked.code)(moduleRegistry, moduleExports);
  return moduleExports;
}

const mounted: { root: Root; container: HTMLElement }[] = [];

function mount(component: unknown): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(component as FunctionComponent));
  });
  mounted.push({ root, container });
  return container;
}

function write(module: Record<string, unknown>, next: number): void {
  act(() => {
    (module.count as Signal<number>).value = next;
  });
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});

const moduleScopeCounter = `
import { signal } from "react-alien-signals";

export const count = signal(0);

export function Counter() {
  return <output>{count.value}</output>;
}
`;

const customHookCounter = `
import { signal } from "react-alien-signals";

export const count = signal(0);

function useTotal() {
  return count.value + 1;
}

export function Counter() {
  return <output>{useTotal()}</output>;
}
`;

const leafHookCounter = `
import { signal, useSignalValue } from "react-alien-signals";

export const count = signal(0);

export function Counter() {
  const value = useSignalValue(count);
  return <output>{value}</output>;
}
`;

const directBindingCounter = `
import { signal } from "react-alien-signals";

export const count = signal(0);

export function Counter() {
  return <output>{count}</output>;
}
`;

// The manual boundary pattern published in docs/hooks.md, hand-authored. It
// never goes through this package's transform (`signalsTransform: false`), so
// nothing inserts an opt-out directive for it -- which is exactly the case
// under measurement.
const handWrittenRuntimeCounter = `
import { signal } from "react-alien-signals";
import { useSignals } from "react-alien-signals/runtime";

export const count = signal(0);

export function Counter() {
  const store = useSignals();
  try {
    return <output>{count.value}</output>;
  } finally {
    store.f();
  }
}
`;

// The control: the same hand-authored shape with the directive written by hand.
const handWrittenRuntimeCounterWithDirective = `
import { signal } from "react-alien-signals";
import { useSignals } from "react-alien-signals/runtime";

export const count = signal(0);

export function Counter() {
  "use no memo";

  const store = useSignals();
  try {
    return <output>{count.value}</output>;
  } finally {
    store.f();
  }
}
`;

const TRY_WITHOUT_CATCH = "(BuildHIR::lowerStatement) Handle TryStatement without a catch clause";

describe("React Compiler compiled output", () => {
  it("caches an unguarded inject-transformed component behind the memo sentinel", () => {
    const { code } = compilePipeline(moduleScopeCounter, {
      transform: "inject",
      reactCompiler: "off",
    });

    expect(code).toContain(`from "react/compiler-runtime"`);
    const memoBlock = code.slice(code.indexOf("memo_cache_sentinel"), code.indexOf("} else {"));
    expect(memoBlock).toContain("count.value");
  });

  it("makes the compiler skip an inject-transformed component by default", () => {
    const { code, events } = compilePipeline(moduleScopeCounter, { transform: "inject" });

    expect(code).toContain(`"use no memo";`);
    expect(code).not.toContain("react/compiler-runtime");
    expect(events.map((event) => event.kind)).toEqual(["CompileSkip"]);
  });

  it("leaves a managed-transformed component uncompiled either way", () => {
    const guarded = compilePipeline(moduleScopeCounter, { transform: "managed" });
    const unguarded = compilePipeline(moduleScopeCounter, {
      transform: "managed",
      reactCompiler: "off",
    });

    expect(guarded.code).not.toContain("react/compiler-runtime");
    expect(unguarded.code).not.toContain("react/compiler-runtime");
    // The try/finally scope cannot be lowered to the compiler's IR, so managed
    // output is skipped even without the directive -- but only as a logged
    // compile error, which a `panicThreshold: "all_errors"` build turns fatal.
    expect(unguarded.events.map((event) => event.kind)).toEqual(["CompileError"]);
  });

  it("panics on managed output under panicThreshold only without the directive", () => {
    // The directive leaves the error event logged, so it does not look like it
    // should help -- but measured, it is what keeps the panic from firing.
    const guarded = applySignalsTransform(moduleScopeCounter, { transform: "managed" });
    const unguarded = applySignalsTransform(moduleScopeCounter, {
      transform: "managed",
      reactCompiler: "off",
    });

    expect(() => applyReactCompiler(unguarded, { panicThreshold: "all_errors" })).toThrow(
      TRY_WITHOUT_CATCH,
    );
    const compiled = applyReactCompiler(guarded, { panicThreshold: "all_errors" });
    expect(compiled.events.map((event) => event.kind)).toEqual(["CompileError"]);
  });

  it("leaves a hand-written runtime-import component uncompiled, directive or not", () => {
    // The manual `react-alien-signals/runtime` boundary is the transform's own
    // managed shape, hand-authored. The compiler cannot lower `try` without
    // `catch` whoever wrote it, so it bails on the syntax alone -- the same
    // `CompileError` the transform-generated managed output produces, and the
    // directive does not change it into a `CompileSkip`.
    const plain = compilePipeline(handWrittenRuntimeCounter, { signalsTransform: false });
    const directive = compilePipeline(handWrittenRuntimeCounterWithDirective, {
      signalsTransform: false,
    });

    for (const { code, events } of [plain, directive]) {
      expect(code).not.toContain("react/compiler-runtime");
      expect(code).not.toContain("memo_cache_sentinel");
      expect(events.map((event) => event.kind)).toEqual(["CompileError"]);
      expect(JSON.stringify(events)).toContain(TRY_WITHOUT_CATCH);
    }
  });

  it("leaves a hand-written runtime-import component untransformed by this package", () => {
    // The build plugin has no automation to offer here even when it is in the
    // build: the function already calls `useSignals()`, so the transform skips
    // it and never reaches the point where it would add the directive.
    expect(
      transformReactAlienSignals(handWrittenRuntimeCounter, "Fixture.jsx", {
        importSource: "react-alien-signals",
        mode: "auto",
        transform: "managed",
        reactCompiler: "auto",
        reactImportSource: "react",
      }),
    ).toBeNull();
  });

  it("panics on a hand-written runtime-import component under panicThreshold", () => {
    // `panicThreshold: "all_errors"` is the real hazard for this shape: the
    // same bail-out that protects the runtime becomes a fatal build error.
    expect(() =>
      applyReactCompiler(handWrittenRuntimeCounter, { panicThreshold: "all_errors" })
    ).toThrow(TRY_WITHOUT_CATCH);
  });

  it("survives panicThreshold when the directive is written by hand", () => {
    // The directive does not silence the logged event, but it does keep the
    // panic from firing -- which is the one thing writing it by hand buys.
    const { code, events } = applyReactCompiler(handWrittenRuntimeCounterWithDirective, {
      panicThreshold: "all_errors",
    });

    expect(code).not.toContain("react/compiler-runtime");
    expect(events.map((event) => event.kind)).toEqual(["CompileError"]);
    expect(JSON.stringify(events)).toContain(TRY_WITHOUT_CATCH);
  });

  it("keeps a prop-held signal's read as a reactive memo dependency", () => {
    // The hazard is specific to reads the compiler classifies as non-reactive.
    // A signal reached through props is a reactive input, so the compiler emits
    // the `.value` read as the cache key and it runs on every render. This needs
    // the inject transform: managed output is not lowerable to the compiler's IR,
    // so nothing would be compiled and there would be no memo cache to inspect.
    const { code } = compilePipeline(
      `
export function Counter({ counter }) {
  return <output>{counter.value}</output>;
}
`,
      { transform: "inject", reactCompiler: "off" },
    );

    expect(code).toContain("$[0] !== counter.value");
  });

  it("keeps the leaf hook's value as a reactive memo dependency", () => {
    const { code } = compilePipeline(leafHookCounter);

    expect(code).toContain(`from "react/compiler-runtime"`);
    expect(code).toContain("$[0] !== value");
  });
});

describe("React Compiler runtime behavior", () => {
  it("updates an inject-transformed component when the compiler is not used", async () => {
    const module = await loadModule(moduleScopeCounter, { transform: "inject", compile: false });
    const container = mount(module.Counter);

    expect(container.textContent).toBe("0");
    write(module, 1);
    expect(container.textContent).toBe("1");
  });

  it("freezes an unguarded inject-transformed component compiled by the compiler", async () => {
    const module = await loadModule(moduleScopeCounter, {
      transform: "inject",
      reactCompiler: "off",
    });
    const container = mount(module.Counter);

    expect(container.textContent).toBe("0");
    // The first write still notifies (the mount render populated the cache and
    // recorded the dependency), but the cached JSX is returned unchanged and
    // that render reads nothing, so the commit drops the subscription.
    write(module, 1);
    expect(container.textContent).toBe("0");
    write(module, 2);
    expect(container.textContent).toBe("0");
  });

  it("updates an inject-transformed component compiled by the compiler", async () => {
    const module = await loadModule(moduleScopeCounter, { transform: "inject" });
    const container = mount(module.Counter);

    expect(container.textContent).toBe("0");
    write(module, 1);
    expect(container.textContent).toBe("1");
    write(module, 2);
    expect(container.textContent).toBe("2");
  });

  it("updates a component whose custom hook holds the signal read", async () => {
    const module = await loadModule(customHookCounter, { transform: "inject" });
    const container = mount(module.Counter);

    expect(container.textContent).toBe("1");
    write(module, 1);
    expect(container.textContent).toBe("2");
  });

  it("updates a managed-transformed component compiled by the compiler", async () => {
    const module = await loadModule(moduleScopeCounter, { transform: "managed" });
    const container = mount(module.Counter);

    expect(container.textContent).toBe("0");
    write(module, 1);
    expect(container.textContent).toBe("1");
  });

  it("updates a hand-written runtime-import component compiled by the compiler", async () => {
    // No directive anywhere: the bail-out on `try` without `catch` is enough on
    // its own to keep every render re-reading the signal.
    const module = await loadModule(handWrittenRuntimeCounter, { signalsTransform: false });
    const container = mount(module.Counter);

    expect(container.textContent).toBe("0");
    write(module, 1);
    expect(container.textContent).toBe("1");
    write(module, 2);
    expect(container.textContent).toBe("2");
  });

  it("updates a hand-written runtime-import component carrying the directive", async () => {
    const module = await loadModule(handWrittenRuntimeCounterWithDirective, {
      signalsTransform: false,
    });
    const container = mount(module.Counter);

    expect(container.textContent).toBe("0");
    write(module, 1);
    expect(container.textContent).toBe("1");
    write(module, 2);
    expect(container.textContent).toBe("2");
  });

  it("updates a leaf-hook component compiled by the compiler", async () => {
    const module = await loadModule(leafHookCounter);
    const container = mount(module.Counter);

    expect(container.textContent).toBe("0");
    write(module, 1);
    expect(container.textContent).toBe("1");
  });

  it("updates a direct JSX signal binding compiled by the compiler", async () => {
    const module = await loadModule(directBindingCounter, {
      jsxImportSource: "react-alien-signals",
    });
    const container = mount(module.Counter);

    expect(container.textContent).toBe("0");
    write(module, 1);
    expect(container.textContent).toBe("1");
  });
});
