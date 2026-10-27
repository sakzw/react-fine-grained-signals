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

import { transformSync, type PluginItem, type PluginObject } from "@babel/core";
import * as t from "@babel/types";
import reactCompiler, { type LoggerEvent } from "babel-plugin-react-compiler";
import { act, createElement, Suspense, useState, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as reactCompilerRuntime from "react/compiler-runtime";
import * as reactJsxRuntime from "react/jsx-runtime";
import { transformWithOxc } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import * as library from "../../../src/index.js";
import type { Signal } from "../../../src/index.js";
import * as libraryJsxRuntime from "../../../src/jsx/jsx-runtime.js";
import * as libraryLiteJsxRuntime from "../../../src/jsx/lite/jsx-runtime.js";
import * as libraryRuntime from "../../../src/internal.js";
import {
  transformReactFineGrainedSignals,
  type ReactFineGrainedSignalsMode,
  type ReactFineGrainedSignalsReactCompiler,
  type ReactFineGrainedSignalsTransform,
} from "../src/internal/transform.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MODULES = "__modules";
const EXPORTS = "__exports";

const moduleRegistry: Record<string, unknown> = {
  react: { useState },
  "react/jsx-runtime": reactJsxRuntime,
  "react/compiler-runtime": reactCompilerRuntime,
  "react-fine-grained-signals": library,
  "react-fine-grained-signals/internal": libraryRuntime,
  "react-fine-grained-signals/jsx/jsx-runtime": libraryJsxRuntime,
  "react-fine-grained-signals/jsx/lite/jsx-runtime": libraryLiteJsxRuntime,
};

// Rewrites the compiled ES module into something `new Function` can run, so a
// fixture keeps real module scope -- what the compiler's reactivity analysis
// looks at -- without needing a file on disk.
const moduleLinker: PluginObject = {
  name: "test-module-linker",
  visitor: {
    ImportDeclaration(path) {
      const properties = path.node.specifiers.map((specifier) => {
        if (!t.isImportSpecifier(specifier) || !t.isIdentifier(specifier.imported)) {
          throw path.buildCodeFrameError("fixtures only use named imports");
        }
        return t.objectProperty(t.identifier(specifier.imported.name), t.cloneNode(specifier.local));
      });
      path.replaceWith(
        t.variableDeclaration("const", [
          t.variableDeclarator(
            t.objectPattern(properties),
            t.memberExpression(t.identifier(MODULES), t.stringLiteral(path.node.source.value), true),
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
          ),
        ),
      ]);
    },
  },
};

interface PipelineOptions {
  mode?: ReactFineGrainedSignalsMode;
  transform?: ReactFineGrainedSignalsTransform;
  reactCompiler?: ReactFineGrainedSignalsReactCompiler;
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
    transformReactFineGrainedSignals(source, "Fixture.jsx", {
      importSource: "react-fine-grained-signals",
      mode: options.mode ?? "auto",
      transform: options.transform ?? "managed",
      reactCompiler: options.reactCompiler ?? "opt-out",
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

function compilePipeline(source: string, options: PipelineOptions = {}): { code: string; events: LoggerEvent[] } {
  const transformed = options.signalsTransform === false ? source : applySignalsTransform(source, options);
  if (options.compile === false) return { code: transformed, events: [] };
  return applyReactCompiler(transformed);
}

async function loadModule(source: string, options: PipelineOptions = {}): Promise<Record<string, unknown>> {
  const { code } = compilePipeline(source, options);
  const jsx = await transformWithOxc(code, "Fixture.jsx", {
    lang: "jsx",
    jsx: { runtime: "automatic", importSource: options.jsxImportSource ?? "react" },
  });
  const linked = transformSync(jsx.code, {
    babelrc: false,
    configFile: false,
    filename: "Fixture.js",
    // Babel 8 dropped the plain plugin object from `PluginItem`, which the
    // runtime still accepts and this fixture linker relies on.
    plugins: [moduleLinker as PluginItem],
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
import { signal } from "react-fine-grained-signals";

export const count = signal(0);

export function Counter() {
  return <output>{count.value}</output>;
}
`;

const customHookCounter = `
import { signal } from "react-fine-grained-signals";

export const count = signal(0);

function useTotal() {
  return count.value + 1;
}

export function Counter() {
  return <output>{useTotal()}</output>;
}
`;

const leafHookCounter = `
import { signal, useSignalValue } from "react-fine-grained-signals";

export const count = signal(0);

export function Counter() {
  const value = useSignalValue(count);
  return <output>{value}</output>;
}
`;

const managedPropCounter = `
import { signal } from "react-fine-grained-signals";

export const count = signal(0);

function Leaf({ source }) {
  return <output>{source.value}</output>;
}

export function Counter() {
  return <Leaf source={count} />;
}
`;

const managedConditionalCounter = `
import { signal } from "react-fine-grained-signals";

export const chooseLeft = signal(true);
export const left = signal("left");
export const right = signal("right");

export function Counter() {
  return <output>{chooseLeft.value ? left.value : right.value}</output>;
}
`;

const managedSuspendingCounter = `
import { signal } from "react-fine-grained-signals";

export const count = signal(0);
let ready = false;
let release;
const gate = new Promise((resolve) => { release = resolve; });

export function retry() {
  ready = true;
  release();
}

export function Counter() {
  const value = count.value;
  if (!ready) throw gate;
  return <output>{value}</output>;
}
`;

const managedHookOrderCounter = `
import { signal } from "react-fine-grained-signals";
import { useState } from "react";

export const count = signal(0);

export function Counter() {
  const [local, setLocal] = useState(0);
  return <button onClick={() => setLocal(local + 1)}>{count.value}:{local}</button>;
}
`;

const directBindingCounter = `
import { signal } from "react-fine-grained-signals";

export const count = signal(0);

export function Counter() {
  return <output>{count}</output>;
}
`;

describe("React Compiler compiled output", () => {
  it("keeps Lite Signal children reactive under React Compiler", async () => {
    const source = `
import { signal } from "react-fine-grained-signals";
export const count = signal(0);
export function Counter() {
  return <output>{count}</output>;
}
`;
    const module = await loadModule(source, {
      signalsTransform: false,
      jsxImportSource: "react-fine-grained-signals/jsx/lite",
    });
    const container = mount(module.Counter);
    expect(container.textContent).toBe("0");
    write(module, 1);
    expect(container.textContent).toBe("1");
  });

  it("tracks repeated writes when an author opts a managed component into memoization", async () => {
    const source = `
import { signal } from "react-fine-grained-signals";
export const count = signal(0);
export function Counter() {
  "use memo";
  return <output>{count.value}</output>;
}
`;
    const compiled = compilePipeline(source);
    expect(compiled.code).toContain('"use memo";');
    expect(compiled.code).not.toContain('"use no memo";');
    expect(compiled.events.map((event) => event.kind)).toEqual(["CompileSuccess"]);

    const module = await loadModule(source);
    const container = mount(module.Counter);
    expect(container.textContent).toBe("0");
    write(module, 1);
    expect(container.textContent).toBe("1");
    write(module, 2);
    expect(container.textContent).toBe("2");
  });

  it("tracks nested static destructuring through an explicitly memoized component", async () => {
    const source = `
import { deepSignal } from "react-fine-grained-signals";
export const state = deepSignal({ user: { profile: { name: "Ada" } } });
export function Profile() {
  "use memo";
  const { user: { profile: { name } } } = state.value;
  return <output>{name}</output>;
}
`;
    const compiled = compilePipeline(source);
    expect(compiled.events.map((event) => event.kind)).toEqual(["CompileSuccess"]);

    const module = await loadModule(source);
    const container = mount(module.Profile);
    const state = module.state as Signal<{ user: { profile: { name: string } } }>;
    expect(container.textContent).toBe("Ada");
    act(() => {
      state.value.user.profile.name = "Bea";
    });
    expect(container.textContent).toBe("Bea");
    act(() => {
      state.value.user = { profile: { name: "Cleo" } };
    });
    expect(container.textContent).toBe("Cleo");
  });

  it("keeps an authored use no memo component live while the compiler skips it", async () => {
    const source = `
import { signal } from "react-fine-grained-signals";
export const count = signal(0);
export function Counter() {
  "use no memo";
  return <output>{count.value}</output>;
}
`;
    const compiled = compilePipeline(source);
    expect(compiled.code).toContain('"use no memo";');
    expect(compiled.events.map((event) => event.kind)).toEqual(["CompileSkip"]);

    const module = await loadModule(source);
    const container = mount(module.Counter);
    expect(container.textContent).toBe("0");
    write(module, 1);
    expect(container.textContent).toBe("1");
    write(module, 2);
    expect(container.textContent).toBe("2");
  });

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

  it("skips managed output by default and compiles it only when integration is disabled", () => {
    const guarded = compilePipeline(moduleScopeCounter, { transform: "managed" });
    const unguarded = compilePipeline(moduleScopeCounter, {
      transform: "managed",
      reactCompiler: "off",
    });

    expect(guarded.code).not.toContain("react/compiler-runtime");
    expect(guarded.events.map((event) => event.kind)).toEqual(["CompileSkip"]);
    expect(unguarded.code).toContain("react/compiler-runtime");
    expect(unguarded.events.map((event) => event.kind)).toEqual(["CompileSuccess"]);
  });

  it("keeps managed global reads live when the compiler integration is disabled", async () => {
    const compiled = compilePipeline(moduleScopeCounter, { transform: "managed", reactCompiler: "off" });
    expect(compiled.events.map((event) => event.kind)).toEqual(["CompileSuccess"]);
    const module = await loadModule(moduleScopeCounter, { transform: "managed", reactCompiler: "off" });
    const container = mount(module.Counter);
    expect(container.textContent).toBe("0");
    write(module, 1);
    expect(container.textContent).toBe("1");
    write(module, 2);
    expect(container.textContent).toBe("2");
  });

  it("honors panicThreshold for managed output when integration is disabled", () => {
    const guarded = applySignalsTransform(moduleScopeCounter, { transform: "managed" });
    const unguarded = applySignalsTransform(moduleScopeCounter, {
      transform: "managed",
      reactCompiler: "off",
    });

    const compiled = applyReactCompiler(unguarded, { panicThreshold: "all_errors" });
    expect(compiled.code).toContain("react/compiler-runtime");
    expect(compiled.events.map((event) => event.kind)).toEqual(["CompileSuccess"]);
    const guardedCompiled = applyReactCompiler(guarded, { panicThreshold: "all_errors" });
    expect(guardedCompiled.code).not.toContain("react/compiler-runtime");
    expect(guardedCompiled.events.map((event) => event.kind)).toEqual(["CompileSkip"]);
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

  it("updates a managed component compiled with integration disabled", async () => {
    const options = { transform: "managed" as const, reactCompiler: "off" as const };
    const { events } = compilePipeline(moduleScopeCounter, options);
    expect(events.map((event) => event.kind)).toContain("CompileSuccess");
    const module = await loadModule(moduleScopeCounter, options);
    const container = mount(module.Counter);

    expect(container.textContent).toBe("0");
    write(module, 1);
    expect(container.textContent).toBe("1");
    write(module, 2);
    expect(container.textContent).toBe("2");
  });

  it("keeps managed capture fresh when Compiler integration is disabled", async () => {
    const module = await loadModule(moduleScopeCounter, {
      transform: "managed",
      reactCompiler: "off",
    });
    const container = mount(module.Counter);

    expect(container.textContent).toBe("0");
    write(module, 1);
    expect(container.textContent).toBe("1");
    write(module, 2);
    expect(container.textContent).toBe("2");
  });

  it("keeps a prop-held signal read fresh when Compiler integration is disabled", async () => {
    const { events } = compilePipeline(managedPropCounter, {
      transform: "managed",
      reactCompiler: "off",
    });
    expect(events.map((event) => event.kind)).toContain("CompileSuccess");

    const module = await loadModule(managedPropCounter, {
      transform: "managed",
      reactCompiler: "off",
    });
    const container = mount(module.Counter);

    expect(container.textContent).toBe("0");
    write(module, 1);
    expect(container.textContent).toBe("1");
    write(module, 2);
    expect(container.textContent).toBe("2");
  });

  it("switches managed Compiler dependencies and drops the previous branch", async () => {
    const options = { transform: "managed" as const, reactCompiler: "off" as const };
    const { events } = compilePipeline(managedConditionalCounter, options);
    expect(events.map((event) => event.kind)).toEqual(["CompileSuccess"]);

    const module = await loadModule(managedConditionalCounter, options);
    const container = mount(module.Counter);

    expect(container.textContent).toBe("left");
    act(() => {
      (module.chooseLeft as Signal<boolean>).value = false;
    });
    expect(container.textContent).toBe("right");
    act(() => {
      (module.left as Signal<string>).value = "stale";
    });
    expect(container.textContent).toBe("right");
    act(() => {
      (module.right as Signal<string>).value = "fresh";
    });
    expect(container.textContent).toBe("fresh");
  });

  it("retries a suspended managed render after Compiler compilation", async () => {
    const options = { transform: "managed" as const, reactCompiler: "off" as const };
    const { events } = compilePipeline(managedSuspendingCounter, options);
    expect(events.map((event) => event.kind)).toContain("CompileSuccess");

    const module = await loadModule(managedSuspendingCounter, options);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    act(() => {
      root.render(
        createElement(
          Suspense,
          { fallback: createElement("i", null, "waiting") },
          createElement(module.Counter as FunctionComponent),
        ),
      );
    });
    expect(container.textContent).toBe("waiting");

    await act(async () => {
      (module.retry as () => void)();
      await Promise.resolve();
    });
    expect(container.textContent).toBe("0");
    write(module, 1);
    expect(container.textContent).toBe("1");
  });

  it("preserves user Hook order in a compiled managed component", async () => {
    const options = { transform: "managed" as const, reactCompiler: "off" as const };
    const { events } = compilePipeline(managedHookOrderCounter, options);
    expect(events.map((event) => event.kind)).toContain("CompileSuccess");

    const module = await loadModule(managedHookOrderCounter, options);
    const container = mount(module.Counter);
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("0:0");

    act(() => button?.click());
    expect(button?.textContent).toBe("0:1");
    write(module, 1);
    expect(button?.textContent).toBe("1:1");
  });

  it("keeps Hook calls direct and for-of capture live in a compiled managed component", async () => {
    const source = `
import { signal } from "react-fine-grained-signals";
import { useState } from "react";

export const count = signal(0);
const items = signal(["a"]);
function label(prefix, value) { return prefix + value; }
function useCount() { useState(0); return count; }

export function Counter() {
  const text = label(useState("n")[0], count.value);
  let joined = "";
  for (const item of items.value) joined += item;
  return <p>{text + ":" + useCount().value + ":" + joined}</p>;
}
`;
    const options = { transform: "managed" as const, reactCompiler: "off" as const };
    const { events } = compilePipeline(source, options);
    expect(events.map((event) => event.kind)).toContain("CompileSuccess");

    const module = await loadModule(source, options);
    const container = mount(module.Counter);
    expect(container.textContent).toBe("n0:0:a");
    write(module, 1);
    expect(container.textContent).toBe("n1:1:a");
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
      jsxImportSource: "react-fine-grained-signals/jsx",
    });
    const container = mount(module.Counter);

    expect(container.textContent).toBe("0");
    write(module, 1);
    expect(container.textContent).toBe("1");
  });
});
