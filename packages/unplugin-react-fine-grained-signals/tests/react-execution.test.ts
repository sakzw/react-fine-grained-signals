// @vitest-environment jsdom
/// <reference lib="dom" />

/**
 * Transform shapes whose correctness only shows up when React actually runs
 * the output: a hook boundary in the wrong function is a Rules-of-Hooks crash
 * on a later render, and a read that happens outside the boundary is a stale
 * UI rather than any error at all. Each case runs this package's transform,
 * lowers JSX, links the module in memory, and drives it through mount ->
 * signal write -> DOM assertion. The hand-written controls pin the output the
 * transform used to produce, so each regression is shown to be real.
 */

import { parseSync, transformSync, traverse, type PluginItem, type PluginObject } from "@babel/core";
import * as t from "@babel/types";
import { act, createElement, Suspense, useCallback, useState, type FunctionComponent } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import * as reactJsxRuntime from "react/jsx-runtime";
import { transformWithOxc } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as library from "../../../src/index.js";
import type { Signal } from "../../../src/index.js";
import * as libraryJsxRuntime from "../../../src/jsx-runtime.js";
import * as libraryRuntime from "../../../src/runtime.js";
import * as libraryUtils from "../../../src/utils.js";
import {
  transformReactFineGrainedSignals,
  type ReactFineGrainedSignalsMode,
  type ReactFineGrainedSignalsTransform,
} from "../src/internal/transform.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const MODULES = "__modules";
const EXPORTS = "__exports";

const moduleRegistry: Record<string, unknown> = {
  react: { Suspense, useCallback, useState },
  "react/jsx-runtime": reactJsxRuntime,
  "react-fine-grained-signals": library,
  "react-fine-grained-signals/jsx-runtime": libraryJsxRuntime,
  "react-fine-grained-signals/runtime": libraryRuntime,
  "react-fine-grained-signals/utils": libraryUtils,
};

// The same in-memory linker `react-compiler.test.ts` uses: named imports
// become reads from a registry, declaration exports become assignments.
const moduleLinker: PluginObject = {
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
      } else if (t.isFunctionDeclaration(declaration) && declaration.id) {
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

async function loadModule(
  source: string,
  {
    transform = true,
    mode = "auto",
    codegen = "managed",
    experimentalCapture = false,
    modules = {},
    typescript = false,
  }: {
    transform?: boolean;
    mode?: ReactFineGrainedSignalsMode;
    codegen?: ReactFineGrainedSignalsTransform;
    experimentalCapture?: boolean;
    modules?: Record<string, unknown>;
    typescript?: boolean;
  } = {},
): Promise<Record<string, unknown>> {
  const fixtureName = typescript ? "Fixture.tsx" : "Fixture.jsx";
  const transformed = transform
    ? transformReactFineGrainedSignals(source, fixtureName, {
      importSource: "react-fine-grained-signals",
      mode,
      transform: codegen,
      reactCompiler: "auto",
      reactImportSource: "react",
      experimentalCapture,
    })?.code ?? source
    : source;
  // `importSource: "react"` is the project-wide default a per-file
  // `@jsxImportSource` pragma overrides, exactly as under Vite.
  const jsx = await transformWithOxc(transformed, fixtureName, {
    lang: typescript ? "tsx" : "jsx",
    jsx: { runtime: "automatic", importSource: "react" },
  });
  const linked = transformSync(jsx.code, {
    babelrc: false,
    configFile: false,
    filename: "Fixture.js",
    plugins: [moduleLinker as PluginItem],
  });
  if (typeof linked?.code !== "string") throw new Error("module linking emitted no code");
  const moduleExports: Record<string, unknown> = {};
  new Function(MODULES, EXPORTS, linked.code)({ ...moduleRegistry, ...modules }, moduleExports);
  return moduleExports;
}

describe("experimental per-read capture codegen", () => {
  it("commits the transformed per-read capture attempt during hydration", async () => {
    const module = await loadModule(`
import { signal } from "react-fine-grained-signals";
export const source = signal("server");
export const unrelated = signal("unchanged");
let renders = 0;
export function getRenders() { return renders; }
export function App() {
  renders += 1;
  return <span data-testid="captured-hydration">{source.value}</span>;
}
`, { mode: "all", experimentalCapture: true });
    const App = module.App as FunctionComponent;
    const getRenders = module.getRenders as () => number;
    const source = module.source as Signal<string>;
    const unrelated = module.unrelated as Signal<string>;

    const html = renderToString(createElement(App));
    expect(html).toContain("server");
    expect(getRenders()).toBe(1);

    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = hydrateRoot(container, createElement(App));

    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector("[data-testid=captured-hydration]")?.textContent).toBe("server");
    expect(getRenders()).toBe(2);

    await act(async () => { unrelated.value = "ignored"; });
    expect(getRenders()).toBe(2);
    expect(container.querySelector("[data-testid=captured-hydration]")?.textContent).toBe("server");

    await act(async () => { source.value = "client"; });
    expect(getRenders()).toBe(3);
    expect(container.querySelector("[data-testid=captured-hydration]")?.textContent).toBe("client");
    expect(consoleError).not.toHaveBeenCalled();

    root.unmount();
    container.remove();
    consoleError.mockRestore();
  });

  it("keeps Hooks at function top level and subscribes shallow and deep read chains", async () => {
    const source = `
import { deepSignal, signal } from "react-fine-grained-signals";
import { useState } from "react";

export const shallow = signal("before");
export const deep = deepSignal({ profile: { name: "Ada" } });

export function App() {
  const [count, setCount] = useState(0);
  const label = shallow.value;
  const profile = deep.value.profile;
  const alias = profile.name;
  const name = [0].map(() => deep.value.profile.name)[0];
  return <button onClick={() => setCount(count + 1)}>{label + "/" + alias + "/" + name + "/" + count}</button>;
}
`;
    const transformed = transformReactFineGrainedSignals(source, "Fixture.jsx", {
      importSource: "react-fine-grained-signals",
      mode: "all",
      transform: "managed",
      reactCompiler: "auto",
      reactImportSource: "react",
      experimentalCapture: true,
    })?.code;
    expect(transformed).toContain("useSignalCapture");
    expect(transformed).toMatch(/useSignalCapture\(\);[\s\S]*useState\(0\)/);
    expect(transformed).toContain(".capture(() => shallow.value)");
    expect(transformed).toContain(".capture(() => deep.value.profile)");
    expect(transformed).toContain(".capture(() => profile.name)");
    expect(transformed).not.toMatch(/\btry\s*\{/);

    const module = await loadModule(source, { experimentalCapture: true });
    const container = mount(module.App);
    expect(container.textContent).toBe("before/Ada/Ada/0");
    write(module, "shallow", "after");
    expect(container.textContent).toBe("after/Ada/Ada/0");
    act(() => { (module.deep as { value: { profile: { name: string } } }).value.profile.name = "Grace"; });
    expect(container.textContent).toBe("after/Grace/Grace/0");
  });

  it("tracks nested signals stored under ref-like property names and constant computed keys", async () => {
    const module = await loadModule(`
import { signal } from "react-fine-grained-signals";
const valueKey = "value";
export const inner = signal("before");
export const holder = signal({ current: inner });
export function HolderApp() {
  return <output>{holder.value.current.value}/{inner[valueKey]}</output>;
}
export function KeyApp() { return <output>{inner[valueKey]}</output>; }
`);
    const holderContainer = mount(module.HolderApp);
    const keyContainer = mount(module.KeyApp);
    expect(holderContainer.textContent).toBe("before/before");
    expect(keyContainer.textContent).toBe("before");

    write(module, "inner", "after");
    expect(holderContainer.textContent).toBe("after/after");
    expect(keyContainer.textContent).toBe("after");
  });

  it("preserves explicit ambient tracking for deep proxy reads inside keyed rows", async () => {
    const module = await loadModule(`
import { deepSignal, useSignalTracking } from "react-fine-grained-signals";
import { For } from "react-fine-grained-signals/utils";

export const state = deepSignal({ tasks: [
  { id: "task-1", title: "Write the test", done: false },
] });

function TaskRow({ task }) {
  useSignalTracking();
  return <li className={task.done ? "task-row done" : "task-row"}>{task.title}</li>;
}

export function App() {
  return <ul><For each={state.value.tasks} by={(task) => task.id}>
    {(task) => <TaskRow task={task} />}
  </For></ul>;
}
`);
    const container = mount(module.App);
    const row = container.querySelector("li");
    expect(row?.className).toBe("task-row");
    expect(row?.textContent).toBe("Write the test");

    act(() => {
      (module.state as { value: { tasks: Array<{ done: boolean }> } }).value.tasks[0]!.done = true;
    });

    expect(container.querySelector("li")?.className).toBe("task-row done");
  });

  it.each(["auto", "all"] as const)("keeps a component's explicit useSignalTracking() window open after a compiled custom hook (mode %s)", async (mode) => {
    const module = await loadModule(`
import { signal, useSignalTracking } from "react-fine-grained-signals";
export const count = signal(1);
export const other = signal("o0");
export function useCount() { return count.value; }
export function Comp() {
  useSignalTracking();
  const n = useCount();
  return <b>{n}:{other.value}</b>;
}
`, { mode });
    const container = mount(module.Comp);
    expect(container.textContent).toBe("1:o0");
    write(module, "other", "o1");
    expect(container.textContent).toBe("1:o1");
    write(module, "count", 2);
    expect(container.textContent).toBe("2:o1");
    write(module, "other", "o2");
    expect(container.textContent).toBe("2:o2");
  });

  it("tracks a computed signal accessor with a runtime key", async () => {
    const module = await loadModule(`
import { signal } from "react-fine-grained-signals";
export const source = signal("before");
export const key = signal("value");
export function App() { return <output>{source[key.value]}</output>; }
`);
    const container = mount(module.App);
    expect(container.textContent).toBe("before");

    write(module, "source", "after");
    expect(container.textContent).toBe("after");
    write(module, "key", "other");
    write(module, "source", "unused");
    expect(container.textContent).toBe("");
    write(module, "key", "value");
    expect(container.textContent).toBe("unused");
    write(module, "source", "final");
    expect(container.textContent).toBe("final");
  });

  it("captures a synchronous signal read performed by an imported helper", async () => {
    const count = library.signal("before") as Signal<string>;
    const module = await loadModule(`
import { readCount } from "./counter-store";
export function App() { return <output>{readCount()}</output>; }
`, {
      mode: "all",
      modules: { "./counter-store": { readCount: () => count.value } },
    });
    const container = mount(module.App);
    expect(container.textContent).toBe("before");

    act(() => { count.value = "after"; });
    expect(container.textContent).toBe("after");
  });

  it("captures known module-scope helper and render-callback reads at their synchronous call", async () => {
    const module = await loadModule(`
import { deepSignal } from "react-fine-grained-signals";
export const state = deepSignal({ profile: { name: "Ada" } });
function readName() { return state.value.profile.name; }
export function App() {
  const direct = readName();
  const mapped = [0].map(readName)[0];
  return <output>{direct + "/" + mapped}</output>;
}
`, { mode: "all", experimentalCapture: true });
    const container = mount(module.App);
    expect(container.textContent).toBe("Ada/Ada");
    act(() => {
      (module.state as { value: { profile: { name: string } } }).value.profile.name = "Grace";
    });
    expect(container.textContent).toBe("Grace/Grace");
  });

  it("auto-detects reads in a statically resolved synchronous module helper", async () => {
    const module = await loadModule(`
import { deepSignal } from "react-fine-grained-signals";
export const state = deepSignal({ profile: { name: "Ada" } });
function readName() { return state.value.profile.name; }
export function App() {
  const name = readName();
  return <output>{name}</output>;
}
`, { mode: "auto", experimentalCapture: true });
    const container = mount(module.App);
    expect(container.textContent).toBe("Ada");
    act(() => {
      (module.state as { value: { profile: { name: string } } }).value.profile.name = "Grace";
    });
    expect(container.textContent).toBe("Grace");
  });

  it("does not fold async or generator callbacks into a synchronous render capture", () => {
    const source = `
import { signal } from "react-fine-grained-signals";
const state = signal("value");
export function App() {
  const pending = [0].map(async () => { await Promise.resolve(); return state.value; });
  const deferred = [0].map(function* () { yield state.value; });
  return <output>{String(pending.length + deferred.length)}</output>;
}
`;
    const transformed = transformReactFineGrainedSignals(source, "DeferredCallbacks.jsx", {
      importSource: "react-fine-grained-signals",
      mode: "all",
      transform: "managed",
      reactCompiler: "auto",
      reactImportSource: "react",
      experimentalCapture: true,
    })?.code;
    expect(transformed).not.toContain(".capture(() => state.value)");
    expect(transformed).toContain("map(async () => {");
    expect(transformed).toContain("map(function* ()");
  });

  it("captures a nested synchronous helper at its callsite instead of retaining a render handle", async () => {
    const module = await loadModule(`
import { deepSignal } from "react-fine-grained-signals";
export const state = deepSignal({ profile: { name: "Ada" } });
export function App() {
  function readLocal() { return state.value.profile.name; }
  return <output>{readLocal()}</output>;
}
`, { mode: "auto", experimentalCapture: true });
    const container = mount(module.App);
    expect(container.textContent).toBe("Ada");
    act(() => {
      (module.state as { value: { profile: { name: string } } }).value.profile.name = "Grace";
    });
    expect(container.textContent).toBe("Grace");
  });

  it("keeps a suspended attempt separate from the fallback and its later retry", async () => {
    const module = await loadModule(`
import { signal } from "react-fine-grained-signals";

export const source = signal("before");
export const fallbackSource = signal("loading");
export const renderCounts = { reader: 0 };
let ready = false;
let release;
const gate = new Promise((resolve) => { release = resolve; });
export const retry = () => { ready = true; release(); };

export function Reader() {
  renderCounts.reader += 1;
  const value = source.value;
  if (!ready) throw gate;
  return <output>{value}</output>;
}

export function Fallback() {
  return <output>{fallbackSource.value}</output>;
}
`, { experimentalCapture: true });
    const Reader = module.Reader as FunctionComponent;
    const Fallback = module.Fallback as FunctionComponent;
    const container = mount(() => createElement(
      Suspense,
      { fallback: createElement(Fallback) },
      createElement(Reader),
    ));
    expect(container.textContent).toBe("loading");
    const counts = module.renderCounts as { reader: number };
    expect(counts.reader).toBeGreaterThan(0);
    const abandonedRenderCount = counts.reader;

    write(module, "fallbackSource", "still waiting");
    expect(container.textContent).toBe("still waiting");
    expect(counts.reader).toBe(abandonedRenderCount);
    write(module, "source", "while suspended");
    expect(container.textContent).toBe("still waiting");
    expect(counts.reader).toBe(abandonedRenderCount);

    await act(async () => {
      (module.retry as () => void)();
      await Promise.resolve();
    });
    expect(container.textContent).toBe("while suspended");
    write(module, "source", "committed update");
    expect(container.textContent).toBe("committed update");
  });

  it("keeps suspended capture ownership isolated across React roots", async () => {
    const module = await loadModule(`
import { signal } from "react-fine-grained-signals";

export const suspendedSource = signal("pending");
export const otherRootSource = signal("other root");
let ready = false;
let release;
const gate = new Promise((resolve) => { release = resolve; });
export const retry = () => { ready = true; release(); };

export function SuspendedReader() {
  const value = suspendedSource.value;
  if (!ready) throw gate;
  return <output>{value}</output>;
}

export function OtherRootReader() {
  return <output>{otherRootSource.value}</output>;
}
`, { experimentalCapture: true });
    const suspendedRoot = mount(() => createElement(
      Suspense,
      { fallback: createElement("output", null, "fallback") },
      createElement(module.SuspendedReader as FunctionComponent),
    ));
    const otherRoot = mount(module.OtherRootReader);

    expect(suspendedRoot.textContent).toBe("fallback");
    expect(otherRoot.textContent).toBe("other root");
    write(module, "suspendedSource", "new pending value");
    expect(suspendedRoot.textContent).toBe("fallback");
    expect(otherRoot.textContent).toBe("other root");

    await act(async () => {
      (module.retry as () => void)();
      await Promise.resolve();
    });
    expect(suspendedRoot.textContent).toBe("new pending value");
    write(module, "otherRootSource", "updated other root");
    expect(otherRoot.textContent).toBe("updated other root");
    expect(suspendedRoot.textContent).toBe("new pending value");
  });

  it("preserves assignment targets, optional reads, constructor calls, and tagged receivers", () => {
    const transformed = transformReactFineGrainedSignals(`
import { deepSignal } from "react-fine-grained-signals";
const state = deepSignal({ nested: { value: 1 }, Ctor: class {}, tag() { return this.nested.value; } });
function View(next) {
  const read = state.value.nested?.value;
  state.value.nested.value = next;
  state.value.nested.value++;
  delete state.value.nested.value;
  ({ nested: state.value.nested.value } = next);
  const instance = new state.value.Ctor();
  const tagged = state.value.tag\`read\`;
  return <output>{read + instance + tagged}</output>;
}
`, "Fixture.jsx", {
      importSource: "react-fine-grained-signals",
      mode: "auto",
      transform: "managed",
      reactCompiler: "auto",
      reactImportSource: "react",
      experimentalCapture: true,
    })?.code;
    expect(transformed).toContain(".capture(() => state.value.nested?.value)");
    expect(transformed).toContain(".capture(() => new state.value.Ctor())");
    expect(transformed).toContain(".capture(() => state.value.tag`read`)");
    expect(transformed).toContain("state.value.nested.value = next");
    expect(transformed).toContain("state.value.nested.value++");
    expect(transformed).toContain("delete state.value.nested.value");
    expect(transformed).toContain("nested: state.value.nested.value");
  });

  it("captures member reads after calls and preserves nested constructor callee evaluation", () => {
    const transformed = transformReactFineGrainedSignals(`
import { deepSignal } from "react-fine-grained-signals";
const state = deepSignal({ getChild() { return { name: "Ada" }; }, makeCtor() { return class {} } });
function View() {
  const name = state.value.getChild().name;
  const instance = new (state.value.makeCtor())();
  return <output>{name + instance}</output>;
}
`, "Fixture.jsx", {
      importSource: "react-fine-grained-signals",
      mode: "auto",
      transform: "managed",
      reactCompiler: "auto",
      reactImportSource: "react",
      experimentalCapture: true,
    })?.code;
    expect(transformed).toContain(".capture(() => state.value.getChild().name)");
    expect(transformed).toContain(".capture(() => new (state.value.makeCtor())())");
  });

  it("does not wrap TypeScript assertions on assignment targets", () => {
    const transformed = transformReactFineGrainedSignals(`
import { deepSignal } from "react-fine-grained-signals";
const state = deepSignal({ nested: { value: 1 } });
function View(next: number) {
  state.value.nested.value! = next;
  (state.value.nested.value as number) = next;
  return <output>{state.value.nested.value}</output>;
}
`, "Fixture.tsx", {
      importSource: "react-fine-grained-signals",
      mode: "auto",
      transform: "managed",
      reactCompiler: "auto",
      reactImportSource: "react",
      experimentalCapture: true,
    })?.code;
    expect(transformed).toContain("state.value.nested.value! = next");
    expect(transformed).toContain("state.value.nested.value as number");
    expect(transformed).not.toContain(".capture(() => state.value.nested.value!");
    expect(transformed).not.toContain(".capture(() => state.value.nested.value as number");
  });
});

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

function write<T>(module: Record<string, unknown>, name: string, next: T): void {
  act(() => {
    (module[name] as Signal<T>).value = next;
  });
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  vi.restoreAllMocks();
});

describe("a component-named function called as a plain function", () => {
  const source = `
import { signal } from "react-fine-grained-signals";

export const count = signal(0);
export const show = signal(false);

function Title() {
  return <h1>{count.value}</h1>;
}

export function App() {
  return <div>{show.value && Title()}</div>;
}
`;

  // What the transform used to emit for `source`: a boundary inside Title,
  // whose hooks then belong to App and run only while `show` is true.
  const previousOutput = `
import { signal } from "react-fine-grained-signals";
import { useManagedSignals } from "react-fine-grained-signals/runtime";

export const count = signal(0);
export const show = signal(false);

function Title() {
  "use no memo";
  const store = useManagedSignals();
  try {
    return <h1>{count.value}</h1>;
  } finally {
    store.finish();
  }
}

export function App() {
  "use no memo";
  const store = useManagedSignals();
  try {
    return <div>{show.value && Title()}</div>;
  } finally {
    store.finish();
  }
}
`;

  it("control: a boundary inside the called function breaks the caller's hook order", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const module = await loadModule(previousOutput, { transform: false });
    mount(module.App);

    expect(() => write(module, "show", true)).toThrow(/hooks/i);
  });

  it("renders conditionally and keeps the inline read subscribed through the caller", async () => {
    const module = await loadModule(source);
    const container = mount(module.App);
    expect(container.textContent).toBe("");

    write(module, "show", true);
    expect(container.textContent).toBe("0");

    write(module, "count", 1);
    expect(container.textContent).toBe("1");

    write(module, "show", false);
    expect(container.textContent).toBe("");
    write(module, "show", true);
    write(module, "count", 2);
    expect(container.textContent).toBe("2");
  });
});

describe("a signal read in a parameter default", () => {
  const source = `
import { signal } from "react-fine-grained-signals";

export const count = signal(0);

export function Label({ v = count.value }) {
  return <output>{v}</output>;
}
`;

  it("control: a default evaluated before the boundary opens is never tracked", async () => {
    const module = await loadModule(`
import { signal } from "react-fine-grained-signals";
import { useManagedSignals } from "react-fine-grained-signals/runtime";

export const count = signal(0);

export function Label({ v = count.value }) {
  "use no memo";
  const store = useManagedSignals();
  try {
    return <output>{v}</output>;
  } finally {
    store.finish();
  }
}
`, { transform: false });
    const container = mount(module.Label);

    write(module, "count", 1);
    expect(container.textContent).toBe("0");
  });

  it("re-renders when the signal read by the default changes", async () => {
    const module = await loadModule(source);
    const container = mount(module.Label);
    expect(container.textContent).toBe("0");

    write(module, "count", 1);
    expect(container.textContent).toBe("1");
  });
});

describe("object-method shorthand components", () => {
  const source = `
import { signal } from "react-fine-grained-signals";

export const count = signal(0);

export const ns = {
  Home() {
    return <output>{count.value}</output>;
  },
  Inline() {
    return <b>{count.value}</b>;
  },
};

export function Page() {
  return <main>{ns.Inline()}</main>;
}
`;

  it("subscribes a method mounted through JSX", async () => {
    const module = await loadModule(source);
    const container = mount((module.ns as Record<string, unknown>).Home);
    expect(container.textContent).toBe("0");

    write(module, "count", 3);
    expect(container.textContent).toBe("3");
  });

  it("tracks a method called through its slot in the calling component", async () => {
    const module = await loadModule(source);
    const container = mount(module.Page);
    expect(container.textContent).toBe("0");

    write(module, "count", 4);
    expect(container.textContent).toBe("4");
  });
});

describe("a component-named function handed to Array.from as its mapFn", () => {
  const source = `
import { signal } from "react-fine-grained-signals";

export const count = signal(0);
export const length = signal(2);

function Star() {
  return <span>{count.value}</span>;
}

export function Rating() {
  return <div>{Array.from({ length: length.value }, Star)}</div>;
}
`;

  it("does not give the mapFn a hook boundary that runs once per item", async () => {
    const transformed = transformReactFineGrainedSignals(source, "Fixture.jsx", {
      importSource: "react-fine-grained-signals",
      mode: "auto",
      transform: "managed",
      reactCompiler: "auto",
      reactImportSource: "react",
    })?.code ?? source;
    expect(transformed.match(/useSignalCapture\(\)/g)).toHaveLength(1);
    expect(transformed).toMatch(/function Star\(\) \{\s+return <span>/);
  });

  it("renders, survives a length change, and stays subscribed through the caller", async () => {
    const module = await loadModule(source);
    const container = mount(module.Rating);
    expect(container.textContent).toBe("00");

    write(module, "length", 3);
    expect(container.textContent).toBe("000");
    write(module, "count", 1);
    expect(container.textContent).toBe("111");
    write(module, "length", 1);
    expect(container.textContent).toBe("1");
  });
});

describe("a keyed component destructured and handed to map", () => {
  const source = `
import { signal } from "react-fine-grained-signals";

export const count = signal(0);
export const items = signal([1, 2]);

const parts = {
  Row: (item) => <li>{count.value}:{item}</li>,
};

export function List() {
  const { Row } = parts;
  return <ul>{items.value.map(Row)}</ul>;
}
`;

  it("does not give the keyed function a hook boundary that runs once per item", async () => {
    const transformed = transformReactFineGrainedSignals(source, "Fixture.jsx", {
      importSource: "react-fine-grained-signals",
      mode: "auto",
      transform: "managed",
      reactCompiler: "auto",
      reactImportSource: "react",
    })?.code ?? source;
    expect(transformed.match(/useSignalCapture\(\)/g)).toHaveLength(1);
    expect(transformed).toMatch(/Row: \(?item\)? => <li>/);
  });

  it("renders, survives an item-count change, and stays subscribed through the caller", async () => {
    const module = await loadModule(source);
    const container = mount(module.List);
    expect(container.textContent).toBe("0:10:2");

    write(module, "items", [1, 2, 3]);
    expect(container.textContent).toBe("0:10:20:3");
    write(module, "count", 1);
    expect(container.textContent).toBe("1:11:21:3");
  });
});

function writeSignal<T>(target: Signal<T>, next: T): void {
  act(() => {
    target.value = next;
  });
}

interface BadgeProps {
  count: Signal<number>;
  label: Signal<string>;
}

describe("an import-free file opted into the JSX runtime by a first-line pragma", () => {
  // Signals arrive through props, so the file has no import for the transform
  // to put its own after.
  const source = `/** @jsxImportSource react-fine-grained-signals */
export function Badge({ count, label }) {
  return <p title={label}>{count.value > 9 ? "many" : "few"}: {label}</p>;
}
`;

  it("control: a generated import above the pragma hands the signal child to React's runtime", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const module = await loadModule(
      `import { useSignalTracking } from "react-fine-grained-signals";\n${source.replace(
        "{\n  return",
        '{\n  "use no memo";\n  useSignalTracking();\n  return',
      )}`,
      { transform: false },
    );
    const count = library.signal(1);
    const label = library.signal("hello");

    expect(() => mount(() => createElement(module.Badge as FunctionComponent<BadgeProps>, { count, label })))
      .toThrow(/not valid as a React child/);
  });

  for (const codegen of ["managed", "inject"] as const) {
    it(`binds the signal child and host prop through the pragma's runtime (${codegen})`, async () => {
      const module = await loadModule(source, { codegen });
      const count = library.signal(1);
      const label = library.signal("hello");
      const container = mount(() =>
        createElement(module.Badge as FunctionComponent<BadgeProps>, { count, label })
      );
      const paragraph = container.querySelector("p")!;
      expect(paragraph.textContent).toBe("few: hello");
      expect(paragraph.title).toBe("hello");

      writeSignal(label, "world");
      expect(paragraph.textContent).toBe("few: world");
      expect(paragraph.title).toBe("world");

      // The boundary the transform added still tracks the `.value` read.
      writeSignal(count, 10);
      expect(container.querySelector("p")!.textContent).toBe("many: world");
    });
  }
});

describe("object-method components reached through dynamic member dispatch", () => {
  const source = `
import { signal } from "react-fine-grained-signals";

export const suffix = signal("!");
export const nodes = signal([
  { id: 1, type: "User", name: "ada" },
  { id: 2, type: "Repo", name: "rfgs" },
]);
export const show = signal(false);
export const kind = signal("Details");

const renderers = {
  User(node) {
    return <li key={node.id}>{node.name}{suffix.value}</li>;
  },
  Repo(node) {
    return <li key={node.id}>{node.name}</li>;
  },
};

export function Feed() {
  return <ul>{nodes.value.map((node) => renderers[node.type](node))}</ul>;
}

const panels = {
  Details(arg) {
    return <p>{arg}{suffix.value}</p>;
  },
};

export function Panel() {
  return <div>{show.value && panels[kind.value]("x")}</div>;
}
`;

  // What the transform emitted for `User` before dynamic dispatch was
  // recognized: a boundary that runs once per matching item inside Feed.
  const previousOutput = `
import { signal } from "react-fine-grained-signals";
import { useManagedSignals } from "react-fine-grained-signals/runtime";

export const suffix = signal("!");
export const nodes = signal([
  { id: 1, type: "User", name: "ada" },
  { id: 2, type: "Repo", name: "rfgs" },
]);

const renderers = {
  User(node) {
    "use no memo";
    const store = useManagedSignals();
    try {
      return <li key={node.id}>{node.name}{suffix.value}</li>;
    } finally {
      store.finish();
    }
  },
  Repo(node) {
    return <li key={node.id}>{node.name}</li>;
  },
};

export function Feed() {
  "use no memo";
  const store = useManagedSignals();
  try {
    return <ul>{nodes.value.map((node) => renderers[node.type](node))}</ul>;
  } finally {
    store.finish();
  }
}
`;

  const grown = [
    { id: 1, type: "User", name: "ada" },
    { id: 2, type: "Repo", name: "rfgs" },
    { id: 3, type: "User", name: "bob" },
  ];

  it("control: a boundary inside the dispatched method breaks Feed's hook count", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const module = await loadModule(previousOutput, { transform: false });
    mount(module.Feed);

    expect(() => write(module, "nodes", grown)).toThrow(/hooks/i);
  });

  for (const mode of ["auto", "all"] as const) {
    for (const codegen of ["managed", "inject"] as const) {
      it(`survives list-length changes and conditional dispatch (${mode}, ${codegen})`, async () => {
        const module = await loadModule(source, { mode, codegen });
        const feed = mount(module.Feed);
        expect(feed.textContent).toBe("ada!rfgs");

        write(module, "nodes", grown);
        expect(feed.textContent).toBe("ada!rfgsbob!");
        write(module, "nodes", grown.slice(0, 1));
        expect(feed.textContent).toBe("ada!");

        const panel = mount(module.Panel);
        expect(panel.textContent).toBe("");
        write(module, "show", true);
        expect(panel.textContent).toBe("x!");
        write(module, "show", false);
        expect(panel.textContent).toBe("");
        write(module, "show", true);
        expect(panel.textContent).toBe("x!");
      });
    }
  }
});

describe("managed destructured signal reads", () => {
  it("preserves getter order and neighboring declarator order", async () => {
    const module = await loadModule(`
      export const events = [];
      const mark = (name) => (events.push(name), name);
      const state = {
        get value() {
          events.push("source");
          return {
            get first() {
              events.push("first");
              return { get nested() { events.push("nested"); return "A"; } };
            },
            get second() { events.push("second"); return "B"; },
          };
        },
      };
      export function Profile() {
        const before = mark("before"), { first: { nested }, second } = state.value, after = mark("after");
        return <p>{before + nested + second + after}</p>;
      }
    `, {
      modules: {
        "react-fine-grained-signals/runtime": {
          useSignalCapture: () => ({ capture: (read: () => unknown) => read() }),
        },
      },
    });

    const element = (module.Profile as () => { props: { children: string } })();
    expect(element.props.children).toBe("beforeABafter");
    expect(module.events).toEqual(["before", "source", "first", "nested", "second", "after"]);
  });

  it("preserves nullish errors and TDZ when a property getter reads its own binding", async () => {
    const module = await loadModule(`
      const nullSource = { value: null };
      const undefinedSource = { value: undefined };
      export function ReadNull() {
        const { child } = nullSource.value;
        return <p>{child}</p>;
      }
      export function ReadUndefined() {
        const { child } = undefinedSource.value;
        return <p>{child}</p>;
      }
      export function ReadTDZ() {
        const source = { value: { get chosen() { return chosen; } } };
        const { chosen } = source.value;
        return <p>{chosen}</p>;
      }
    `, {
      modules: {
        "react-fine-grained-signals/runtime": {
          useSignalCapture: () => ({ capture: (read: () => unknown) => read() }),
        },
      },
    });
    const readNull = module.ReadNull as () => unknown;
    const readUndefined = module.ReadUndefined as () => unknown;
    const readTDZ = module.ReadTDZ as () => unknown;
    const nativeDestructure = (value: unknown) => {
      const { child } = value as { child: string };
      return child;
    };

    expect(() => readNull()).toThrow(TypeError);
    expect(() => nativeDestructure(null)).toThrow(TypeError);
    expect(() => readUndefined()).toThrow(TypeError);
    expect(() => nativeDestructure(undefined)).toThrow(TypeError);
    expect(() => readTDZ()).toThrow(ReferenceError);
  });

  it("stops property evaluation at the same throwing getter", async () => {
    const module = await loadModule(`
      export const events = [];
      const failure = new Error("first getter failed");
      const state = {
        get value() {
          events.push("source");
          return {
            get first() { events.push("first"); throw failure; },
            get second() { events.push("second"); return "unreachable"; },
          };
        },
      };
      export function Read() {
        const { first, second } = state.value;
        return <p>{first + second}</p>;
      }
    `, {
      modules: {
        "react-fine-grained-signals/runtime": {
          useSignalCapture: () => ({ capture: (read: () => unknown) => read() }),
        },
      },
    });

    expect(() => (module.Read as () => unknown)()).toThrow("first getter failed");
    expect(module.events).toEqual(["source", "first"]);
  });

  it("evaluates the source and extracted getter once each", async () => {
    const module = await loadModule(`
      export const reads = { source: 0, user: 0 };
      const state = {
        get value() {
          reads.source++;
          return {
            get user() {
              reads.user++;
              return { name: "Ada" };
            },
          };
        },
      };
      export function Profile() {
        const { user } = state.value;
        return <p>{user.name}</p>;
      }
    `);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(module.Profile as FunctionComponent));
      });
      expect(container.textContent).toBe("Ada");
      expect(module.reads).toEqual({ source: 1, user: 1 });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("tracks the destructured property and later nested writes in React", async () => {
    const module = await loadModule(`
      import { deepSignal } from "react-fine-grained-signals";
      export const state = deepSignal({ user: { name: "Ada" } });
      export function Profile() {
        const { user } = state.value;
        return <p>{user.name}</p>;
      }
    `);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const state = module.state as Signal<{ user: { name: string } }>;
    try {
      await act(async () => {
        root.render(createElement(module.Profile as FunctionComponent));
      });
      expect(container.textContent).toBe("Ada");

      await act(async () => {
        state.value.user.name = "Bea";
      });
      expect(container.textContent).toBe("Bea");

      await act(async () => {
        state.value.user = { name: "Cleo" };
      });
      expect(container.textContent).toBe("Cleo");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("tracks nested const destructuring through a later alias", async () => {
    const module = await loadModule(`
      import { deepSignal } from "react-fine-grained-signals";
      export const state = deepSignal({ user: { profile: { name: "Ada" } } });
      export function Profile() {
        const { user } = state.value;
        const alias = user;
        const { profile } = alias;
        const { name } = profile;
        return <p>{name}</p>;
      }
    `);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const state = module.state as Signal<{ user: { profile: { name: string } } }>;
    try {
      await act(async () => {
        root.render(createElement(module.Profile as FunctionComponent));
      });
      expect(container.textContent).toBe("Ada");

      await act(async () => {
        state.value.user.profile.name = "Bea";
      });
      expect(container.textContent).toBe("Bea");

      await act(async () => {
        state.value.user = { profile: { name: "Cleo" } };
      });
      expect(container.textContent).toBe("Cleo");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("tracks nested static object patterns through deep writes and replacement", async () => {
    const module = await loadModule(`
      import { deepSignal } from "react-fine-grained-signals";
      export const state = deepSignal({ user: { profile: { name: "Ada" } } });
      export function Profile() {
        const { user: { profile: { name } } } = state.value;
        return <p>{name}</p>;
      }
    `);
    const container = mount(module.Profile);
    const state = module.state as Signal<{ user: { profile: { name: string } } }>;
    expect(container.textContent).toBe("Ada");

    act(() => { state.value.user.profile.name = "Bea"; });
    expect(container.textContent).toBe("Bea");

    act(() => { state.value.user = { profile: { name: "Cleo" } }; });
    expect(container.textContent).toBe("Cleo");
  });

  it("tracks a valid multi-stage destructuring chain through deep writes and replacement", async () => {
    const depth = 8;
    type Node = { name?: string; child?: Node };
    const sourceObject = (name: string) => {
      let value: Node = { name };
      for (let index = 0; index < depth; index += 1) value = { child: value };
      return value;
    };
    const module = await loadModule(`
      import { deepSignal } from "react-fine-grained-signals";
      export const state = deepSignal(${JSON.stringify(sourceObject("Ada"))});
      export function Profile() {
        const { child: value0 } = state.value;
        const { child: value1 } = value0;
        const { child: value2 } = value1;
        const { child: value3 } = value2;
        const { child: value4 } = value3;
        const { child: value5 } = value4;
        const { child: value6 } = value5;
        const { child: value7 } = value6;
        return <p>{value7.name}</p>;
      }
    `);
    const container = mount(module.Profile);
    const state = module.state as Signal<Node>;
    expect(container.textContent).toBe("Ada");

    act(() => {
      let target = state.value;
      for (let index = 0; index < depth; index += 1) target = target.child!;
      target.name = "Bea";
    });
    expect(container.textContent).toBe("Bea");

    act(() => { state.value = sourceObject("Cleo"); });
    expect(container.textContent).toBe("Cleo");
  });

  it("hydrates a nested static pattern and keeps its capture live", async () => {
    const module = await loadModule(`
      import { deepSignal } from "react-fine-grained-signals";
      export const state = deepSignal({ user: { profile: { name: "Server" } } });
      export function Profile() {
        const { user: { profile: { name } } } = state.value;
        return <p>{name}</p>;
      }
    `);
    const Profile = module.Profile as FunctionComponent;
    const state = module.state as Signal<{ user: { profile: { name: string } } }>;
    const container = document.createElement("div");
    container.innerHTML = renderToString(createElement(Profile));
    document.body.append(container);
    let root: Root | undefined;
    try {
      expect(container.textContent).toBe("Server");
      await act(async () => { root = hydrateRoot(container, createElement(Profile)); });
      await act(async () => { state.value.user.profile.name = "Client"; });
      expect(container.textContent).toBe("Client");
    } finally {
      if (root !== undefined) await act(async () => root?.unmount());
      container.remove();
    }
  });

  it("keeps same-named aliases in separate conditional scopes bound to their own source", async () => {
    const module = await loadModule(`
      import { deepSignal } from "react-fine-grained-signals";
      export const state = deepSignal({ primary: { name: "Ada" }, secondary: { name: "Grace" } });
      export function Profile({ alternate }) {
        if (alternate) {
          const { secondary: person } = state.value;
          return <p>{person.name}</p>;
        }
        const { primary: person } = state.value;
        return <p>{person.name}</p>;
      }
    `);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const state = module.state as Signal<{ primary: { name: string }; secondary: { name: string } }>;
    await act(async () => root.render(createElement(
      module.Profile as FunctionComponent<{ alternate: boolean }>,
      { alternate: false },
    )));
    expect(container.textContent).toBe("Ada");
    await act(async () => root.render(createElement(
      module.Profile as FunctionComponent<{ alternate: boolean }>,
      { alternate: true },
    )));
    expect(container.textContent).toBe("Grace");
    await act(async () => { state.value.secondary.name = "Lin"; });
    expect(container.textContent).toBe("Lin");
  });
});

function transformedCode(
  source: string,
  mode: ReactFineGrainedSignalsMode,
  codegen: ReactFineGrainedSignalsTransform,
): string {
  return transformReactFineGrainedSignals(source, "Fixture.jsx", {
    importSource: "react-fine-grained-signals",
    mode,
    transform: codegen,
    reactCompiler: "auto",
    reactImportSource: "react",
  })?.code ?? source;
}

/**
 * The emitted text of the member that starts with `head` inside
 * `const object = {`, up to the next member at the same indentation.
 */
function memberSource(code: string, object: string, head: string): string {
  const start = code.indexOf(head, code.indexOf(`const ${object} = {`));
  const indent = code.slice(code.lastIndexOf("\n", start) + 1, start);
  const end = code.indexOf(`\n${indent}}`, start);
  return code.slice(start, end === -1 ? undefined : end);
}

const HOOK = /_useSignalCapture\(\)|_useSignalTracking\(\)/;

const THIS_LISTS = ["L", "O", "D", "Q", "M", "F"];
const OPTIONAL_ROWS = ["R", "r"];

/** The text of the toggled block in the optional-path fixture's `Calls`. */
function optionalCallsText(suffix: string): string {
  return `1${["H", "H", "H", "G", "G", "G", "D", "A", "g", "g"].map((prefix) => prefix + suffix).join("")}`;
}

/** `${prefix}${index}${suffix}` for each of `count` items, list after list. */
function itemText(prefixes: string[], count: number, suffix: string): string {
  return prefixes
    .map((prefix) => Array.from({ length: count }, (_, i) => `${prefix}${i}${suffix}`).join(""))
    .join("");
}

describe("object-literal members reached through a sibling's `this`", () => {
  const source = `
import { signal } from "react-fine-grained-signals";

export const suffix = signal("!");
export const count = signal(1);
export const show = signal(false);
export const kind = signal("Leaf");

const plain = {
  Leaf(i) { return <li key={i}>L{i}{suffix.value}</li>; },
  Tree(n) { return <ul>{Array.from({ length: n }, (_, i) => this.Leaf(i))}</ul>; },
};
const optional = {
  Leaf(i) { return <li key={i}>O{i}{suffix.value}</li>; },
  Tree(n) { return <ul>{Array.from({ length: n }, (_, i) => this?.Leaf(i))}</ul>; },
};
const dynamic = {
  Leaf(i) { return <li key={i}>D{i}{suffix.value}</li>; },
  Tree(n, k) { return <ul>{Array.from({ length: n }, (_, i) => this[k](i))}</ul>; },
};
const optionalDynamic = {
  Leaf(i) { return <li key={i}>Q{i}{suffix.value}</li>; },
  Tree(n, k) { return <ul>{Array.from({ length: n }, (_, i) => this?.[k]?.(i))}</ul>; },
};
const mapped = {
  Row: (i) => <li key={i}>M{i}{suffix.value}</li>,
  List(n) { return <ul>{Array.from({ length: n }, (_, i) => i).map(this.Row)}</ul>; },
};
const fromed = {
  Row(_, i) { return <li key={i}>F{i}{suffix.value}</li>; },
  List(n) { return <ul>{Array.from({ length: n }, this.Row)}</ul>; },
};
const conditional = {
  Badge() { return <b>B{suffix.value}</b>; },
  Card() { return <p>{show.value && this.Badge()}</p>; },
};

export function Lists() {
  return (
    <div>
      {plain.Tree(count.value)}
      {optional.Tree(count.value)}
      {dynamic.Tree(count.value, kind.value)}
      {optionalDynamic.Tree(count.value, kind.value)}
      {mapped.List(count.value)}
      {fromed.List(count.value)}
    </div>
  );
}

export function Conditional() {
  return <div>{conditional.Card()}</div>;
}
`;

  // What the transform emitted for `plain.Leaf` before `this` was followed.
  const previousOutput = `
import { signal } from "react-fine-grained-signals";
import { useManagedSignals } from "react-fine-grained-signals/runtime";

export const suffix = signal("!");
export const count = signal(1);

const plain = {
  Leaf(i) {
    "use no memo";
    const store = useManagedSignals();
    try {
      return <li key={i}>L{i}{suffix.value}</li>;
    } finally {
      store.finish();
    }
  },
  Tree(n) { return <ul>{Array.from({ length: n }, (_, i) => this.Leaf(i))}</ul>; },
};

export function Lists() {
  "use no memo";
  const store = useManagedSignals();
  try {
    return <div>{plain.Tree(count.value)}</div>;
  } finally {
    store.finish();
  }
}
`;


  it("control: a boundary in the member a sibling calls through this breaks the caller's hook count", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const module = await loadModule(previousOutput, { transform: false });
    mount(module.Lists);

    expect(() => write(module, "count", 3)).toThrow(/hooks/i);
  });

  for (const mode of ["auto", "all"] as const) {
    for (const codegen of ["managed", "inject"] as const) {
      it(`keeps every this-reached member off a boundary (${mode}, ${codegen})`, async () => {
        const code = transformedCode(source, mode, codegen);
        for (const [object, head] of [
          ["plain", "Leaf("],
          ["optional", "Leaf("],
          ["dynamic", "Leaf("],
          ["optionalDynamic", "Leaf("],
          ["mapped", "Row:"],
          ["fromed", "Row("],
          ["conditional", "Badge("],
        ] as const) {
          expect(memberSource(code, object, head)).not.toMatch(HOOK);
        }

        const module = await loadModule(source, { mode, codegen });
        const container = mount(module.Lists);
        expect(container.textContent).toBe(itemText(THIS_LISTS, 1, "!"));
        write(module, "count", 3);
        expect(container.textContent).toBe(itemText(THIS_LISTS, 3, "!"));
        write(module, "suffix", "?");
        expect(container.textContent).toBe(itemText(THIS_LISTS, 3, "?"));
        write(module, "count", 1);
        expect(container.textContent).toBe(itemText(THIS_LISTS, 1, "?"));

        const card = mount(module.Conditional);
        expect(card.textContent).toBe("");
        write(module, "show", true);
        expect(card.textContent).toBe("B?");
        write(module, "show", false);
        expect(card.textContent).toBe("");
        write(module, "show", true);
        expect(card.textContent).toBe("B?");
      });
    }
  }

  const isolation = `
import { signal } from "react-fine-grained-signals";

export const suffix = signal("!");

const outer = {
  inner: {
    Leaf() { return <i>I{suffix.value}</i>; },
  },
  Leaf() { return <b>X{suffix.value}</b>; },
  Panel() { return <u>P{suffix.value}</u>; },
  Tree() { return <p>{this.inner.Leaf()}<this.Panel /></p>; },
};
const rebinding = {
  Leaf() { return <s>R{suffix.value}</s>; },
  Tree() { return [0].map(function () { return this.Leaf; }); },
};
const unrelated = {
  Leaf() { return <em>U{suffix.value}</em>; },
};

export function Tree() {
  return <div>{outer.Tree()}</div>;
}

export function Shell() {
  return <div><outer.Leaf /><outer.Panel /><rebinding.Leaf /><unrelated.Leaf /></div>;
}
`;

  for (const mode of ["auto", "all"] as const) {
    for (const codegen of ["managed", "inject"] as const) {
      it(`limits this to its own object literal and keeps JSX-only members reactive (${mode}, ${codegen})`, async () => {
        const code = transformedCode(isolation, mode, codegen);
        // `this.inner.Leaf()` reaches the nested slot only.
        expect(memberSource(code, "outer", "inner:")).not.toMatch(HOOK);
        // The outer `Leaf`, the JSX-only `Panel`, a member a nested `function`
        // names through its own `this`, and a same-named slot in another
        // object keep their boundaries.
        expect(memberSource(code, "outer", "\n  Leaf(")).toMatch(HOOK);
        expect(memberSource(code, "outer", "Panel(")).toMatch(HOOK);
        expect(memberSource(code, "rebinding", "Leaf(")).toMatch(HOOK);
        expect(memberSource(code, "unrelated", "Leaf(")).toMatch(HOOK);

        const module = await loadModule(isolation, { mode, codegen });
        const tree = mount(module.Tree);
        const shell = mount(module.Shell);
        expect(tree.textContent).toBe("I!P!");
        expect(shell.textContent).toBe("X!P!R!U!");
        write(module, "suffix", "?");
        expect(tree.textContent).toBe("I?P?");
        expect(shell.textContent).toBe("X?P?R?U?");
      });
    }
  }
});

describe("a this-using member rewritten before its sibling is decided", () => {
  // `useRows` is a keyed hook, so it keeps its own boundary and is rewritten --
  // and it is visited before `Leaf`. The rewrite moves the statements holding
  // `this` under a new block; `Leaf` must still see both reads through `this`.
  const source = `
import { signal } from "react-fine-grained-signals";

export const suffix = signal("!");
export const count = signal(1);

const parts = {
  useRows() {
    const { Leaf } = this;
    const items = Array.from({ length: count.value }, (_, i) => i);
    return [...items.map(Leaf), ...items.map((i) => this.Leaf(i + 10))];
  },
  Leaf(i) { return <li key={i}>{i}{suffix.value}</li>; },
};

export function Page() {
  return <ul>{parts.useRows()}</ul>;
}
`;

  for (const mode of ["auto", "all"] as const) {
    for (const codegen of ["managed", "inject"] as const) {
      it(`keeps the sibling off a boundary (${mode}, ${codegen})`, async () => {
        const code = transformedCode(source, mode, codegen);
        expect(memberSource(code, "parts", "useRows(")).toMatch(HOOK);
        expect(memberSource(code, "parts", "\n  Leaf(")).not.toMatch(HOOK);

        const module = await loadModule(source, { mode, codegen });
        const page = mount(module.Page);
        expect(page.textContent).toBe("0!10!");
        write(module, "count", 3);
        expect(page.textContent).toBe("0!1!2!10!11!12!");
        write(module, "suffix", "?");
        expect(page.textContent).toBe("0?1?2?10?11?12?");
        write(module, "count", 1);
        expect(page.textContent).toBe("0?10?");
      });
    }
  }
});

describe("object-literal members called through an optional static key path", () => {
  const source = `
import { signal } from "react-fine-grained-signals";

export const suffix = signal("!");
export const count = signal(1);
export const show = signal(false);

const ns = {
  Home() { return <b>H{suffix.value}</b>; },
  group: {
    Home: () => <i>G{suffix.value}</i>,
    Deep() { return <s>D{suffix.value}</s>; },
  },
  Row(i) { return <li key={i}>R{i}{suffix.value}</li>; },
};
const arrows = {
  Home: () => <b>A{suffix.value}</b>,
  group: { Home() { return <i>g{suffix.value}</i>; } },
  Row: (i) => <li key={i}>r{i}{suffix.value}</li>,
};
const solo = {
  Home() { return <em>S{suffix.value}</em>; },
};
const jsxOnly = {
  Panel() { return <u>P{suffix.value}</u>; },
  Other() { return null; },
};

export function Calls() {
  return (
    <div>
      {count.value}
      {show.value && (
        <>
          {ns?.Home()}{ns.Home?.()}{ns?.Home?.()}
          {ns.group?.Home()}{ns?.group.Home()}{ns?.group?.Home()}{ns?.group?.Deep?.()}
          {arrows?.Home()}{arrows.group?.Home()}{arrows?.group?.Home?.()}
        </>
      )}
    </div>
  );
}

export function Rows() {
  const items = Array.from({ length: count.value }, (_, i) => i);
  return <ul>{items.map(ns?.Row)}{items.map(arrows?.Row)}</ul>;
}

export function Credited() {
  return <div>{solo?.Home()}</div>;
}

export function Guard() {
  return <div><jsxOnly.Panel />{jsxOnly?.Other()}</div>;
}
`;

  // What the transform emitted for `ns.Home` before optional static links were matched.
  const previousOutput = `
import { signal } from "react-fine-grained-signals";
import { useManagedSignals } from "react-fine-grained-signals/runtime";

export const suffix = signal("!");
export const show = signal(false);

const ns = {
  Home() {
    "use no memo";
    const store = useManagedSignals();
    try {
      return <b>H{suffix.value}</b>;
    } finally {
      store.finish();
    }
  },
};

export function Calls() {
  "use no memo";
  const store = useManagedSignals();
  try {
    return <div>{show.value && ns?.Home()}</div>;
  } finally {
    store.finish();
  }
}
`;

  it("control: a boundary in an optional-called member is a conditional hook in the caller", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const module = await loadModule(previousOutput, { transform: false });
    mount(module.Calls);

    expect(() => write(module, "show", true)).toThrow(/hooks/i);
  });


  for (const mode of ["auto", "all"] as const) {
    for (const codegen of ["managed", "inject"] as const) {
      it(`survives toggled optional calls and per-item optional callbacks (${mode}, ${codegen})`, async () => {
        const code = transformedCode(source, mode, codegen);
        for (const [object, head] of [
          ["ns", "Home("],
          ["ns", "Home:"],
          ["ns", "Deep("],
          ["ns", "Row("],
          ["arrows", "Home:"],
          ["arrows", "group:"],
          ["arrows", "Row:"],
        ] as const) {
          expect(memberSource(code, object, head)).not.toMatch(HOOK);
        }
        expect(memberSource(code, "jsxOnly", "Panel(")).toMatch(HOOK);

        const module = await loadModule(source, { mode, codegen });
        const calls = mount(module.Calls);
        expect(calls.textContent).toBe("1");
        write(module, "show", true);
        expect(calls.textContent).toBe(optionalCallsText("!"));
        write(module, "suffix", "?");
        expect(calls.textContent).toBe(optionalCallsText("?"));
        write(module, "show", false);
        expect(calls.textContent).toBe("1");
        write(module, "show", true);
        expect(calls.textContent).toBe(optionalCallsText("?"));

        const list = mount(module.Rows);
        expect(list.textContent).toBe(itemText(OPTIONAL_ROWS, 1, "?"));
        write(module, "count", 3);
        expect(list.textContent).toBe(itemText(OPTIONAL_ROWS, 3, "?"));
        write(module, "count", 1);
        expect(list.textContent).toBe(itemText(OPTIONAL_ROWS, 1, "?"));

        // `Credited` reads no signal of its own: it subscribes only because the
        // optional call's reads are credited to it.
        const credited = mount(module.Credited);
        const guard = mount(module.Guard);
        expect(credited.textContent).toBe("S?");
        expect(guard.textContent).toBe("P?");
        write(module, "suffix", "#");
        expect(credited.textContent).toBe("S#");
        expect(guard.textContent).toBe("P#");
      });
    }
  }
});

describe("a member reached through both a sibling's this and an optional root path", () => {
  const source = `
import { signal } from "react-fine-grained-signals";

export const suffix = signal("!");
export const count = signal(1);
export const show = signal(false);

const ns = {
  Leaf(i) { return <li key={i}>L{i}{suffix.value}</li>; },
  Tree(n) { return <ul>{Array.from({ length: n }, (_, i) => this.Leaf(i))}</ul>; },
};

export function Both() {
  return <div>{ns?.Tree(count.value)}{show.value && ns?.Leaf(9)}</div>;
}
`;

  for (const mode of ["auto", "all"] as const) {
    for (const codegen of ["managed", "inject"] as const) {
      it(`stays off a boundary and keeps the caller subscribed (${mode}, ${codegen})`, async () => {
        expect(memberSource(transformedCode(source, mode, codegen), "ns", "Leaf(")).not.toMatch(HOOK);
        const module = await loadModule(source, { mode, codegen });
        const both = mount(module.Both);
        expect(both.textContent).toBe("L0!");
        write(module, "count", 3);
        write(module, "show", true);
        expect(both.textContent).toBe("L0!L1!L2!L9!");
        write(module, "suffix", "?");
        expect(both.textContent).toBe("L0?L1?L2?L9?");
        write(module, "show", false);
        write(module, "count", 1);
        expect(both.textContent).toBe("L0?");
      });
    }
  }
});

describe("an inline render prop the receiving component calls in its own render", () => {
  const source = `
import { signal } from "react-fine-grained-signals";

export const label = signal("a");

function List({ render }) {
  return render();
}

export function Owner() {
  return <List render={() => <b>{label.value}</b>} />;
}
`;

  // The owner is transformed for the callback's read, but the callback runs in
  // List's render, after the owner's managed boundary has closed.
  it("control: the managed owner's boundary does not cover the receiver's call", async () => {
    const module = await loadModule(source);
    const container = mount(module.Owner);
    write(module, "label", "b");
    expect(container.textContent).toBe("a");
  });

  for (const codegen of ["managed", "inject"] as const) {
    it(`updates once the receiver carries its own boundary (${codegen})`, async () => {
      const module = await loadModule(source.replace("function List", "/** @signalTracking */\nfunction List"), { codegen });
      const container = mount(module.Owner);
      expect(container.textContent).toBe("a");
      write(module, "label", "b");
      expect(container.textContent).toBe("b");
    });
  }
});

describe("@noSignalTracking on an object member the transform cannot follow", () => {
  // The member is reached only through a parameter, which no use-site walk
  // follows, so without the annotation it gets a boundary of its own.
  const source = `
import { signal } from "react-fine-grained-signals";

export const suffix = signal("!");
export const count = signal(1);
export const show = signal(false);

const icons = {
  /** @noSignalTracking */
  Check() { return <i>C{suffix.value}</i>; },
  /** @noSignalTracking */
  Cross() { return <i>X{suffix.value}</i>; },
};
const columns = [
  {
    /** @noSignalTracking */
    Cell(i) { return <td key={i}>{i}{suffix.value}</td>; },
  },
];

function render(set, key) {
  return set[key]();
}

export function Toolbar() {
  const key = "Cr" + "oss";
  const Alias = icons[key];
  return <p>{count.value}{show.value && render(icons, "Check")}{show.value && Alias()}</p>;
}

export function Table() {
  const rows = Array.from({ length: count.value }, (_, i) => i);
  return <table><tbody><tr>{rows.map((r) => columns.map((c) => c.Cell(r)))}</tr></tbody></table>;
}
`;

  it("control: without the annotation the unfollowed members get conditional or per-item hooks", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const unannotated = source.replaceAll("/** @noSignalTracking */", "");
    const toolbar = await loadModule(unannotated);
    mount(toolbar.Toolbar);
    expect(() => write(toolbar, "show", true)).toThrow(/hooks/i);

    const table = await loadModule(unannotated);
    mount(table.Table);
    expect(() => write(table, "count", 3)).toThrow(/hooks/i);
  });

  for (const mode of ["auto", "all"] as const) {
    for (const codegen of ["managed", "inject"] as const) {
      it(`keeps the members off a boundary while the caller tracks their reads (${mode}, ${codegen})`, async () => {
        const module = await loadModule(source, { mode, codegen });
        const toolbar = mount(module.Toolbar);
        const table = mount(module.Table);
        expect(toolbar.textContent).toBe("1");
        expect(table.textContent).toBe("0!");
        write(module, "show", true);
        expect(toolbar.textContent).toBe("1C!X!");
        write(module, "count", 3);
        expect(table.textContent).toBe("0!1!2!");
        write(module, "suffix", "?");
        expect(toolbar.textContent).toBe("3C?X?");
        expect(table.textContent).toBe("0?1?2?");
        write(module, "show", false);
        write(module, "count", 1);
        expect(toolbar.textContent).toBe("1");
        expect(table.textContent).toBe("0?");
      });
    }
  }
});

describe("managed reads performed inside a synchronous expression", () => {
  const deepState = `
import { deepSignal, signal } from "react-fine-grained-signals";

export const items = [signal(false), signal(true)];
export const deep = deepSignal({ profile: { name: "Ada" }, tasks: [{ title: "a" }] });
`;
  type DeepState = { value: { profile: Record<string, string>; tasks: Array<{ title: string }> } };
  const updateDeep = (module: Record<string, unknown>, update: (state: DeepState["value"]) => void): void => {
    act(() => { update((module.deep as DeepState).value); });
  };

  it("captures reads made by inline callbacks of any synchronous call", async () => {
    const module = await loadModule(`${deepState}
export function App() {
  const done = items.filter((item) => item.value).length;
  const total = items.reduce((sum, item) => sum + (item.value ? 1 : 0), 0);
  const first = (() => items[0].value)();
  const nested = [items].map((row) => row.filter((item) => item.value).length)[0];
  return <p>{done + "/" + total + "/" + String(first) + "/" + nested}</p>;
}
`);
    const container = mount(module.App);
    expect(container.textContent).toBe("1/1/false/1");
    act(() => { (module.items as Array<Signal<boolean>>)[0]!.value = true; });
    expect(container.textContent).toBe("2/2/true/2");
  });

  it("captures deep reads that a call, `in`, spread, or for-of performs after the source read", async () => {
    const module = await loadModule(`${deepState}
function nameOf(profile) { return profile.name; }
export function App() {
  const json = JSON.stringify(deep.value.profile);
  const hasAge = "age" in deep.value.profile;
  const copy = { ...deep.value.profile };
  const helper = nameOf(deep.value.profile);
  let titles = "";
  for (const task of deep.value.tasks) titles += task.title;
  return <p>{json + "|" + String(hasAge) + "|" + copy.name + "|" + helper + "|" + titles}</p>;
}
`);
    const container = mount(module.App);
    expect(container.textContent).toBe('{"name":"Ada"}|false|Ada|Ada|a');
    updateDeep(module, (state) => { state.profile.name = "Grace"; });
    expect(container.textContent).toBe('{"name":"Grace"}|false|Grace|Grace|a');
    updateDeep(module, (state) => { state.profile.age = "36"; });
    expect(container.textContent).toBe('{"name":"Grace","age":"36"}|true|Grace|Grace|a');
    updateDeep(module, (state) => { state.tasks[0]!.title = "b"; });
    expect(container.textContent).toBe('{"name":"Grace","age":"36"}|true|Grace|Grace|b');
    updateDeep(module, (state) => { state.tasks.push({ title: "c" }); });
    expect(container.textContent).toBe('{"name":"Grace","age":"36"}|true|Grace|Grace|bc');
  });

  it("keeps Hook calls out of a widened capture", () => {
    const transformed = transformReactFineGrainedSignals(`
import { signal } from "react-fine-grained-signals";
import { useMemo } from "react";
const items = [signal(false)];
export function App() {
  const memo = useMemo(() => items.filter((item) => item.value), []);
  const label = String(useMemo(() => 1, []), items.filter((item) => item.value).length);
  return <p>{memo.length + label}</p>;
}
`, "Fixture.jsx", {
      importSource: "react-fine-grained-signals",
      mode: "auto",
      transform: "managed",
      reactCompiler: "auto",
      reactImportSource: "react",
    })?.code;
    expect(transformed).toContain("useMemo(() => items.filter(item => item.value), [])");
    expect(transformed).toContain("String(useMemo(() => 1, []), _signals.capture(() => items.filter(item => item.value)).length)");
  });

  const managedOutput = (source: string): string => transformReactFineGrainedSignals(source, "Fixture.jsx", {
    importSource: "react-fine-grained-signals",
    mode: "auto",
    transform: "managed",
    reactCompiler: "auto",
    reactImportSource: "react",
  })?.code ?? "";

  it("iterates a tracked for-of source lazily with native control flow and closing", async () => {
    const source = `
import { signal } from "react-fine-grained-signals";
export const log = [];
const lazy = ["a", "b", "c"];
Object.defineProperty(lazy, 2, { get() { log.push("read 2"); return "c"; }, enumerable: true });
export const list = signal(lazy);
export const growing = signal(["x"]);
export const closing = signal({
  [Symbol.iterator]() {
    let index = 0;
    return {
      next() { log.push("next"); index += 1; return { done: index > 3, value: index }; },
      return() { log.push("return"); return { done: true }; },
    };
  },
});
const Array = { isArray() { throw new Error("shadowed Array was consulted"); } };
export function App() {
  let out = "";
  for (const item of list.value) { if (item === "b") break; out += item; }
  for (const item of growing.value) { out += item; if (item === "x" && growing.peek().length < 3) growing.peek().push("y"); }
  for (const step of closing.value) { if (step === 2) break; out += step; }
  return <p>{out + String(Array.length)}</p>;
}
`;
    const transformed = managedOutput(source);
    expect(transformed).not.toContain("[..._iterable]");
    const module = await loadModule(source);
    const container = mount(module.App);
    expect(container.textContent).toBe("axy1undefined");
    // No element after the break was read; the custom iterator was closed.
    expect(module.log).toEqual(["next", "next", "return"]);
  });

  it("propagates throws from the loop body and closes the iterator once", async () => {
    const source = `
import { signal } from "react-fine-grained-signals";
export const log = [];
export const values = signal({
  [Symbol.iterator]() {
    return {
      next() { log.push("next"); return { done: false, value: 1 }; },
      return() { log.push("return"); return {}; },
    };
  },
});
export function read() {
  return values.value;
}
export function useFirst() {
  for (const value of values.value) {
    if (value === 1) throw new Error("body threw");
  }
  return 0;
}
`;
    const module = await loadModule(source);
    function Probe() {
      try { (module.useFirst as () => number)(); } catch (error) { (module.log as string[]).push((error as Error).message); }
      return null;
    }
    mount(Probe);
    expect((module.log as string[]).slice(0, 3)).toEqual(["next", "return", "body threw"]);
  });

  it("tracks for-of over reactive collections and Iterator helpers", async () => {
    const source = `
import { deepSignal } from "react-fine-grained-signals";
export const state = deepSignal({ map: new Map([["a", 1]]), set: new Set(["x"]) });
export function App() {
  let out = "";
  for (const [key, value] of state.value.map) out += key + value;
  for (const key of state.value.map.keys().map((key) => key.toUpperCase())) out += key;
  for (const member of state.value.set) out += member;
  return <p>{out}</p>;
}
`;
    const module = await loadModule(source);
    const container = mount(module.App);
    expect(container.textContent).toBe("a1Ax");
    type State = { value: { map: Map<string, number>; set: Set<string> } };
    act(() => { (module.state as State).value.map.set("b", 2); });
    expect(container.textContent).toBe("a1b2ABx");
    act(() => { (module.state as State).value.map.set("a", 3); });
    expect(container.textContent).toBe("a3b2ABx");
    act(() => { (module.state as State).value.set.add("y"); });
    expect(container.textContent).toBe("a3b2ABxy");
  });

  it("tracks signal reads in iterator next/return getters and result done/value getters", async () => {
    const source = `
import { signal } from "react-fine-grained-signals";
export const nextTag = signal("n0");
export const doneLimit = signal(2);
export const valueTag = signal("v");
export const returnTag = signal("r0");
let closedWith = "";
const iterable = signal({
  [Symbol.iterator]() {
    let index = 0;
    return {
      get next() {
        const tag = nextTag.value;
        return () => {
          index += 1;
          const step = index;
          return {
            get done() { return step > doneLimit.value; },
            get value() { return valueTag.value + step + tag; },
          };
        };
      },
      get return() {
        closedWith = returnTag.value;
        return () => ({ done: true });
      },
    };
  },
});
export function App() {
  let out = "";
  for (const item of iterable.value) out += item;
  for (const item of iterable.value) { out += "|" + item; break; }
  return <p>{out + "/" + closedWith}</p>;
}
`;
    const module = await loadModule(source);
    const container = mount(module.App);
    expect(container.textContent).toBe("v1n0v2n0|v1n0/r0");
    write(module, "nextTag", "n1");
    expect(container.textContent).toBe("v1n1v2n1|v1n1/r0");
    write(module, "doneLimit", 3);
    expect(container.textContent).toBe("v1n1v2n1v3n1|v1n1/r0");
    write(module, "valueTag", "w");
    expect(container.textContent).toBe("w1n1w2n1w3n1|w1n1/r0");
    write(module, "returnTag", "r1");
    expect(container.textContent).toBe("w1n1w2n1w3n1|w1n1/r1");
  });

  it("matches native for-of order, laziness, closing, and getter exceptions", async () => {
    const source = `
import { signal } from "react-fine-grained-signals";
const tick = signal(0);
function makeIterable(log, mode) {
  return {
    [Symbol.iterator]() {
      log.push("iterator");
      let index = 0;
      return {
        get next() {
          log.push("get next");
          if (mode === "next getter") throw new Error("next getter");
          return function () {
            log.push("next:" + (this === undefined ? "no this" : "this"));
            index += 1;
            const step = index;
            return {
              get done() {
                log.push("done " + step);
                if (mode === "done getter" && step === 2) throw new Error("done getter");
                return step > 3;
              },
              get value() {
                log.push("value " + step);
                if (mode === "value getter" && step === 2) throw new Error("value getter");
                return step;
              },
            };
          };
        },
        get return() {
          log.push("get return");
          if (mode === "return getter") throw new Error("return getter");
          return () => { log.push("return"); return {}; };
        },
      };
    },
  };
}
export function useScenarios() {
  void tick.value;
  const results = [];
  for (const mode of ["complete", "break", "continue", "throw", "next getter", "done getter", "value getter", "return getter", "return getter + throw"]) {
    const log = [];
    try {
      for (const item of tick.value >= 0 ? makeIterable(log, mode === "return getter + throw" ? "return getter" : mode) : []) {
        log.push("body " + item);
        if (mode === "continue" && item === 1) continue;
        if ((mode === "break" || mode === "return getter") && item === 2) break;
        if ((mode === "throw" || mode === "return getter + throw") && item === 2) throw new Error("body");
      }
    } catch (error) {
      log.push("caught " + error.message);
    }
    results.push(mode + ": " + log.join(", "));
  }
  return results;
}
`;
    const transformed = await loadModule(source);
    const native = await loadModule(source, { transform: false });
    expect(managedOutput(source)).toContain("_signals.iterate(");
    let transformedResults: string[] = [];
    let nativeResults: string[] = [];
    function Probe() {
      transformedResults = (transformed.useScenarios as () => string[])();
      nativeResults = (native.useScenarios as () => string[])();
      return null;
    }
    mount(Probe);
    expect(transformedResults).toEqual(nativeResults);
    expect(nativeResults.find((line) => line.startsWith("complete:"))).not.toContain("value 4");
  });

  it("tracks reads performed by a custom iterator while the loop pulls it", async () => {
    const source = `
import { signal } from "react-fine-grained-signals";
export const limit = signal(2);
export const list = signal(["a"]);
export const source = signal({
  *[Symbol.iterator]() { for (let index = 0; index < limit.value; index += 1) yield index; },
});
export function App() {
  let out = "";
  for (const index of source.value) out += index;
  for (const item of list.value) out += item;
  return <p>{out}</p>;
}
`;
    const module = await loadModule(source);
    const container = mount(module.App);
    expect(container.textContent).toBe("01a");
    write(module, "limit", 3);
    expect(container.textContent).toBe("012a");
    write(module, "list", ["a", "b"]);
    expect(container.textContent).toBe("012ab");
  });

  it("does not move Hook calls into a capture closure", () => {
    const shapes = [
      `import { format } from "./format";\nconst text = format(useContext(Ctx), count.value);`,
      `function format(a, b) { return String(a) + b; }\nconst text = format(useContext(Ctx), count.value);`,
      `import { helpers } from "./format";\nconst text = helpers.format(useContext(Ctx), count.value);`,
      `import { format } from "./format";\nconst text = format(React.useContext(Ctx), count.value);`,
      `import { format } from "./format";\nconst text = format(useAppContext(), count.value);`,
      `import { format } from "./format";\nconst text = format(use(promise), count.value);`,
      `const text = [count].map((item) => item.value + useContext(Ctx)).join("");`,
      `const text = useCountSignal().value;`,
      `const text = \`\${useContext(Ctx)}\${count.value}\`;`,
    ];
    /** Hook calls whose enclosing function is the callback of a `.capture(...)` call. */
    const hooksInsideCapture = (code: string): string[] => {
      const ast = parseSync(code, { babelrc: false, configFile: false, filename: "Out.jsx", parserOpts: { plugins: ["jsx"] } });
      const found: string[] = [];
      traverse(ast!, {
        CallExpression(path) {
          const callee = path.node.callee;
          const name = t.isIdentifier(callee) ? callee.name
            : t.isMemberExpression(callee) && t.isIdentifier(callee.property) ? callee.property.name : "";
          if (!/^use(?:[A-Z]|$)/.test(name) || name === "useSignalCapture") return;
          for (let fn = path.getFunctionParent(); fn !== null; fn = fn.getFunctionParent()) {
            const call = fn.parentPath;
            if (call?.isCallExpression() && t.isMemberExpression(call.node.callee) &&
              t.isIdentifier(call.node.callee.property, { name: "capture" })) found.push(name);
          }
        },
      });
      return found;
    };
    for (const shape of shapes) {
      const lines = shape.split("\n");
      const statement = lines.pop()!;
      const imports = lines.join("\n");
      const transformed = managedOutput(`
import * as React from "react";
import { useContext, use } from "react";
import { signal } from "react-fine-grained-signals";
${imports}
const count = signal(1);
const Ctx = React.createContext(0);
const promise = Promise.resolve(0);
function useAppContext() { return useContext(Ctx); }
function useCountSignal() { return count; }
export function App() {
  ${statement}
  return <p>{text}</p>;
}
`);
      // Every Hook stays a direct call in the component body.
      expect({ shape, hooks: hooksInsideCapture(transformed), selected: transformed.includes("useSignalCapture()") })
        .toEqual({ shape, hooks: [], selected: true });
    }
  });

  it("keeps separable reads tracked when a Hook shares the call", async () => {
    const source = `
import { signal } from "react-fine-grained-signals";
import { useState } from "react";
export const count = signal(1);
function format(state, value) { return state + ":" + value; }
export function App() {
  const text = format(useState("s")[0], count.value);
  return <p>{text}</p>;
}
`;
    const transformed = managedOutput(source);
    expect(transformed).toContain("_signals.capture(() => count.value)");
    const module = await loadModule(source);
    const container = mount(module.App);
    expect(container.textContent).toBe("s:1");
    write(module, "count", 2);
    expect(container.textContent).toBe("s:2");
  });

  it("captures the read after a Hook result and warns when a Hook hides a call's own reads", async () => {
    const source = `
import { signal } from "react-fine-grained-signals";
import { useState } from "react";
export const count = signal(1);
function useCount() { useState(0); return count; }
export function App() {
  const value = useCount().value;
  return <p>{value}</p>;
}
`;
    const transformed = managedOutput(source);
    expect(transformed).toMatch(/\(_hookResult => _signals\.capture\(\(\) => _hookResult\.value\)\)\(useCount\(\)\)/);
    const module = await loadModule(source);
    const container = mount(module.App);
    expect(container.textContent).toBe("1");
    write(module, "count", 2);
    expect(container.textContent).toBe("2");

    const warnings: string[] = [];
    transformReactFineGrainedSignals(`
import { useContext } from "react";
import { signal } from "react-fine-grained-signals";
import { format } from "./format";
const count = signal(1);
export function App() {
  const text = format(useContext(Ctx), count.value);
  return <p>{text}</p>;
}
`, "Fixture.jsx", {
      importSource: "react-fine-grained-signals",
      mode: "auto",
      transform: "managed",
      reactCompiler: "auto",
      reactImportSource: "react",
      warn: (warning) => warnings.push(warning.message),
    });
    expect(warnings.some((message) => message.includes("Hook call shares this call"))).toBe(true);
  });
});

describe("M17.4 transform review fixes", () => {
  const transformWithWarnings = (source: string, file = "Fixture.jsx") => {
    const warnings: string[] = [];
    const code = transformReactFineGrainedSignals(source, file, {
      importSource: "react-fine-grained-signals",
      mode: "auto",
      transform: "managed",
      reactCompiler: "auto",
      reactImportSource: "react",
      warn: (warning) => warnings.push(warning.message),
    })?.code ?? "";
    return { code, warnings };
  };
  type Deep<T> = { value: T };

  it("keeps transform time linear on long call chains", () => {
    const chain = ".opt(x)".repeat(40);
    const started = performance.now();
    transformWithWarnings(`
import { signal } from "react-fine-grained-signals";
import { z } from "z";
const count = signal(1);
export function App({ x }) { const r = z.schema()${chain}; return <p>{String(count.value)}{r}</p>; }
`);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it("keeps optional chains and method receivers intact through TypeScript wrappers", () => {
    const { code } = transformWithWarnings(`
import { signal } from "react-fine-grained-signals";
const count = signal(1);
const box = signal({ label: "b", get() { return this.label; } });
export function App({ user }: { user?: { value: { name: string } } }) {
  return <p>{user?.value!.name}{box.value.get!()}{(box.value.get as () => string)()}{count.value}</p>;
}
`, "Fixture.tsx");
    expect(code).toContain("_signals.capture(() => user?.value!.name)");
    expect(code).toContain("_signals.capture(() => box.value.get!())");
    expect(code).toContain("_signals.capture(() => (box.value.get as () => string)())");
  });

  it("tracks destructuring loop heads, named predicates, JSX spread, let aliases, getters, and Hook results", async () => {
    const source = `
import { deepSignal, signal } from "react-fine-grained-signals";
import { useState } from "react";
export const state = deepSignal({ items: [{ a: 1 }], map: { k: { n: 1 } }, props: { title: "a" }, todos: [1] });
export const limit = signal(1);
export const count = signal(1);
const isSmallModule = (value) => value <= limit.value;
function useTodos() { useState(0); return state; }
export function App() {
  function isSmall(value) { return value <= limit.value; }
  let out = "";
  for (const { a } of state.value.items) out += a;
  for (const [key, entry] of Object.entries(state.value.map)) out += key + entry.n;
  out += "|" + [1, 2, 3].filter(isSmall).length + [1, 2, 3].filter(isSmallModule).length;
  let items;
  items = state.value.items;
  out += "|" + items.length;
  const view = { get doubled() { return count.value * 2; } };
  out += "|" + view.doubled;
  for (const todo of useTodos().value.todos) out += "|" + todo;
  return <p {...state.value.props}>{out}</p>;
}
`;
    const module = await loadModule(source);
    const container = mount(module.App);
    const text = () => container.querySelector("p")!.textContent;
    const title = () => container.querySelector("p")!.getAttribute("title");
    expect(text()).toBe("1k1|11|1|2|1");
    expect(title()).toBe("a");
    type State = { items: Array<{ a: number }>; map: Record<string, { n: number }>; props: { title: string }; todos: number[] };
    const state = () => (module.state as Deep<State>).value;
    act(() => { state().items[0]!.a = 5; });
    expect(text()).toBe("5k1|11|1|2|1");
    act(() => { state().map.k!.n = 7; });
    expect(text()).toBe("5k7|11|1|2|1");
    write(module, "limit", 2);
    expect(text()).toBe("5k7|22|1|2|1");
    act(() => { state().items.push({ a: 2 }); });
    expect(text()).toBe("52k7|22|2|2|1");
    write(module, "count", 5);
    expect(text()).toBe("52k7|22|2|10|1");
    act(() => { state().todos.push(2); });
    expect(text()).toBe("52k7|22|2|10|1|2");
    act(() => { state().props.title = "b"; });
    expect(title()).toBe("b");
  });

  it("captures reading assignments and warns for Hook-calling helpers", () => {
    const { code, warnings } = transformWithWarnings(`
import { deepSignal } from "react-fine-grained-signals";
import { useState } from "react";
const state = deepSignal({ x: undefined, n: 1 });
function Title() { useState(0); return <b>{state.value.n}</b>; }
export function App() {
  state.value.x ??= 1;
  return <p>{Title()}{state.value.n}</p>;
}
`);
    expect(code).toContain("_signals.capture(() => state.value.x ??= 1)");
    expect(warnings.some((message) => message.includes("calls a Hook and reads signals"))).toBe(true);
  });

  it("does not warn for valid Hook callbacks, closure defaults, or captured helper destructuring", () => {
    const { warnings } = transformWithWarnings(`
import { deepSignal, signal } from "react-fine-grained-signals";
import { useCallback, useEffect } from "react";
const count = signal(1);
const state = deepSignal({ list: [1] });
function util() { const [first] = state.value.list; return first; }
export function App({ onPick = () => count.value }) {
  useEffect(() => { document.title = String(count.value); }, []);
  const log = useCallback(() => console.log(count.value), []);
  return <p onClick={log}>{util()}{onPick()}{count.value}</p>;
}
`);
    expect(warnings).toEqual([]);
  });

  it("reports a render-prop read once even when nested functions are inspected again", () => {
    const { warnings } = transformWithWarnings(`
import { signal } from "react-fine-grained-signals";
const count = signal(1);
function List({ renderItem }) { return renderItem(); }
export function App({ items }) {
  return <ul>{items.map((item) => <List key={item} renderItem={() => count.value} />)}{count.value}</ul>;
}
`);
    expect(warnings.filter((message) => message.includes("JSX callback prop"))).toHaveLength(1);
  });

  it("tracks for-of heads that assign through a pattern to existing variables", async () => {
    const source = `
import { deepSignal } from "react-fine-grained-signals";
export const state = deepSignal({ items: [{ a: 1 }, { a: 5 }], pairs: [[1, 2]] });
export const log = [];
export function App() {
  let a = 0;
  let first = 0;
  let count = 0;
  for ({ a } of state.value.items) { count += 1; break; }
  for ([first] of state.value.pairs) continue;
  return <p>{a + ":" + first + ":" + count}</p>;
}
`;
    const module = await loadModule(source);
    const container = mount(module.App);
    expect(container.textContent).toBe("1:1:1");
    type State = { items: Array<{ a: number }>; pairs: number[][] };
    act(() => { (module.state as Deep<State>).value.items[0]!.a = 2; });
    expect(container.textContent).toBe("2:1:1");
    act(() => { (module.state as Deep<State>).value.pairs[0]![0] = 9; });
    expect(container.textContent).toBe("2:9:1");
  });
});

describe("managed coercion, for-in, Hook arguments and loop-head scope", () => {
  type Deep<T> = { value: T };
  for (const mode of ["auto", "all"] as const) {
    describe(`mode ${mode}`, () => {
      it("tracks for...in key enumeration over a tracked object", async () => {
        const module = await loadModule(`
import { deepSignal } from "react-fine-grained-signals";
export const st = deepSignal({ errors: { a: 1 }, obj: { p: 1 } });
export function App() {
  const keys = [];
  for (const k in st.value.errors) keys.push(k);
  const o = st.value.obj;
  const aliased = [];
  for (const k in o) aliased.push(k);
  return <p>{keys.join(",") + "|" + aliased.join(",")}</p>;
}
`, { mode });
        const container = mount(module.App);
        expect(container.textContent).toBe("a|p");
        type S = { errors: Record<string, number>; obj: Record<string, number> };
        act(() => { (module.st as Deep<S>).value.errors.x = 1; });
        expect(container.textContent).toBe("a,x|p");
        act(() => { (module.st as Deep<S>).value.obj.q = 1; });
        expect(container.textContent).toBe("a,x|p,q");
      });

      it("keeps for...in semantics: inherited keys, deletion during iteration, break", async () => {
        const module = await loadModule(`
import { signal } from "react-fine-grained-signals";
export const base = signal({ own: 1, gone: 2, last: 3 });
export function App() {
  const proto = { inherited: 1 };
  const obj = Object.create(proto);
  obj.a = 1; obj.b = 2; obj.c = 3;
  const seen = [];
  for (const k in obj) { seen.push(k); if (k === "a") delete obj.b; }
  const seen2 = [];
  for (const k in base.value) { seen2.push(k); if (k === "own") delete base.peek().gone; if (k === "last") break; }
  return <p>{seen.join(",") + "|" + seen2.join(",")}</p>;
}
`, { mode });
        const container = mount(module.App);
        expect(container.textContent).toBe("a,c,inherited|own,last");
      });

      it("runs for...in over a signal holding a Proxy with the native loop's traps", async () => {
        const module = await loadModule(`
import { signal } from "react-fine-grained-signals";
export const log = [];
// Every trap the engine calls lands in \`log\`; the descriptor of \`throwOn\`
// throws, which a native loop that breaks before that key never sees.
export function make(keys, throwOn) {
  const target = {};
  for (const key of keys) target[key] = 1;
  return new Proxy(target, {
    ownKeys(t) { log.push("ownKeys"); return Reflect.ownKeys(t); },
    getOwnPropertyDescriptor(t, k) {
      log.push("gOPD " + k);
      if (k === throwOn) throw new Error("gOPD " + k);
      return Reflect.getOwnPropertyDescriptor(t, k);
    },
    getPrototypeOf(t) { log.push("getPrototypeOf"); return Reflect.getPrototypeOf(t); },
    has(t, k) { log.push("has " + k); return Reflect.has(t, k); },
  });
}
export const box = signal(make(["a", "b", "c"], "b"));
export function App() {
  const firstOnly = [];
  for (const k in box.value) { firstOnly.push(k); break; }
  return <p>{firstOnly.join(",")}</p>;
}
`, { mode });
        type M = { log: string[]; make: (keys: string[], throwOn?: string) => object; box: { value: object } };
        const m = module as unknown as M;
        // The trap sequence of one native \`for...in\` that breaks after its first key.
        const nativeLog = (source: object): string[] => {
          m.log.length = 0;
          for (const key in source) { void key; break; }
          return [...m.log];
        };
        const once = nativeLog(m.make(["a", "b", "c"], "b"));
        m.log.length = 0;
        const container = mount(module.App);
        expect(container.textContent).toBe("a");
        expect(m.log.length % once.length).toBe(0);
        expect(m.log).toEqual(Array.from({ length: m.log.length / once.length }, () => once).flat());
        act(() => { m.box.value = m.make(["z", "y"]); });
        expect(container.textContent).toBe("z");
      });

      it("tracks reads in the arguments of a Hook whose result is read", async () => {
        const module = await loadModule(`
import { signal } from "react-fine-grained-signals";
export const id = signal("a");
export const filter = signal("x");
const stores = { a: signal({ name: "A" }), b: signal({ name: "B" }) };
const rows = { x: signal({ items: [1, 2] }), y: signal({ items: [3] }) };
function useStore(key) { return stores[key]; }
function useRows(key) { return rows[key]; }
export function App() {
  let sum = 0;
  for (const r of useRows(filter.value).value.items) sum += r;
  return <p>{useStore(id.value).value.name + ":" + sum}</p>;
}
`, { mode });
        const container = mount(module.App);
        expect(container.textContent).toBe("A:3");
        write(module, "id", "b");
        expect(container.textContent).toBe("B:3");
        write(module, "filter", "y");
        expect(container.textContent).toBe("B:3");
      });

      it("tracks ToPrimitive coercion of tracked values", async () => {
        const module = await loadModule(`
import { deepSignal } from "react-fine-grained-signals";
export const st = deepSignal({ tags: ["a"], n: { v: 1 } });
export function App() {
  const t = \`tags: \${st.value.tags}\`;
  const c = "" + st.value.tags;
  const lt = st.value.tags < "b" ? "lt" : "ge";
  const num = st.value.n + 1;
  return <p>{t + "|" + c + "|" + lt + "|" + num}</p>;
}
`, { mode });
        const container = mount(module.App);
        expect(container.textContent).toBe("tags: a|a|lt|[object Object]1");
        type S = { tags: string[] };
        act(() => { (module.st as Deep<S>).value.tags.push("x"); });
        expect(container.textContent).toBe("tags: a,x|a,x|lt|[object Object]1");
      });

      it("keeps the loop-head default's outer scope when the body redeclares a name", async () => {
        const module = await loadModule(`
import { deepSignal } from "react-fine-grained-signals";
export const st = deepSignal({ items: [{ id: 1 }, { id: 2, label: "two" }] });
export function App() {
  const label = "none";
  const out = [];
  for (const { id, label: l = label } of st.value.items) { const label = l + "!"; out.push(id + label); }
  const outB = [];
  for (const { id: b } of st.value.items) { const b2 = 1; outB.push(b + b2); }
  for (const { id: b } of st.value.items) { const b = 1; outB.push(b); }
  return <p>{out.join(",") + "|" + outB.join(",")}</p>;
}
`, { mode });
        const container = mount(module.App);
        expect(container.textContent).toBe("1none!,2two!|2,3,1,1");
        type S = { items: Array<{ id: number; label?: string }> };
        act(() => { (module.st as Deep<S>).value.items[0]!.label = "one"; });
        expect(container.textContent).toBe("1one!,2two!|2,3,1,1");
      });

      it("keeps an assignment-target loop head's scope when the body redeclares a name", async () => {
        const module = await loadModule(`
import { deepSignal } from "react-fine-grained-signals";
export const st = deepSignal({ items: [{ a: 1 }] });
export function App() {
  let a = 0;
  let seen = "";
  for ({ a } of st.value.items) { const _item = "shadow"; seen += _item; }
  return <p>{a + ":" + seen}</p>;
}
`, { mode });
        const container = mount(module.App);
        expect(container.textContent).toBe("1:shadow");
        act(() => { (module.st as Deep<{ items: Array<{ a: number }> }>).value.items[0]!.a = 5; });
        expect(container.textContent).toBe("5:shadow");
      });
    });
  }
});

describe("stale-render regressions in the managed transform (per-read capture)", () => {
  interface Step {
    run?: (module: Record<string, any>) => void;
    text: string;
  }
  interface Scenario {
    name: string;
    body: string;
    steps: Step[];
    typescript?: boolean;
    prelude?: string;
    modules?: Record<string, unknown>;
  }
  const prelude = `
import { deepSignal, signal } from "react-fine-grained-signals";
export const st = deepSignal({ user: { name: "a" }, tasks: [{ t: "a", done: false }], flag: true });
export const q = signal("a");
export const s = signal(1);
export const tick = signal(0);
`;
  const items = `const items = ["ab", "b", "c"];`;
  const rename = (module: Record<string, any>): void => { module.st.value.user.name = "b"; };
  const bumpS = (module: Record<string, any>): void => { module.s.value = 5; };
  const setQ = (module: Record<string, any>): void => { module.q.value = "b"; };
  const push = (module: Record<string, any>): void => { module.st.value.tasks.push({ t: "b", done: false }); };
  const retitle = (module: Record<string, any>): void => { module.st.value.tasks[0].t = "z"; };

  /** The text the component shows at every step, in each selection mode. */
  function scenario(definition: Scenario): { observe: () => Promise<Record<string, string[]>>; expected: Record<string, string[]> } {
    const texts = definition.steps.map((step) => step.text);
    return {
      expected: { auto: texts, all: texts },
      async observe() {
        const observed: Record<string, string[]> = {};
        for (const mode of ["auto", "all"] as const) {
          const module = await loadModule(`${prelude}${definition.prelude ?? ""}\n${definition.body}`, {
            mode,
            typescript: definition.typescript === true,
            modules: definition.modules ?? {},
          });
          const container = mount(module.App);
          observed[mode] = definition.steps.map((step) => {
            if (step.run !== undefined) act(() => { step.run!(module); });
            return container.textContent ?? "";
          });
        }
        return observed;
      },
    };
  }

  describe("T1: a tracked alias inside a larger expression is a read", () => {
    const aliasCases: Scenario[] = [
      {
        name: "for-of over `alias ?? []`",
        body: `export function App() {
  const tasks = st.value.tasks; const out = [];
  for (const x of tasks ?? []) out.push(x.t);
  return <p>{out.join()}</p>;
}`,
        steps: [{ text: "a" }, { run: push, text: "a,b" }],
      },
      {
        name: "destructuring `alias ?? {}`",
        body: `export function App() {
  const user = st.value.user; const { name } = user ?? {};
  return <p>{name}</p>;
}`,
        steps: [{ text: "a" }, { run: rename, text: "b" }],
      },
      {
        name: "TS `as` of an alias",
        typescript: true,
        body: `export function App() {
  const u = st.value.user; const v = u as { name: string };
  return <p>{v.name}</p>;
}`,
        steps: [{ text: "a" }, { run: rename, text: "b" }],
      },
      {
        name: "TS non-null alias passed to a helper",
        typescript: true,
        body: `function show(x: { name: string }) { return x.name; }
export function App() {
  const u = st.value.user;
  return <p>{show(u!)}</p>;
}`,
        steps: [{ text: "a" }, { run: rename, text: "b" }],
      },
      {
        name: "TS satisfies of an alias",
        typescript: true,
        body: `export function App() {
  const u = st.value.user; const v = u satisfies { name: string };
  return <p>{v.name}</p>;
}`,
        steps: [{ text: "a" }, { run: rename, text: "b" }],
      },
      {
        name: "shorthand property in an object literal handed to a call",
        body: `export function App() {
  const user = st.value.user;
  return <p>{JSON.stringify({ user })}</p>;
}`,
        steps: [{ text: '{"user":{"name":"a"}}' }, { run: rename, text: '{"user":{"name":"b"}}' }],
      },
      {
        name: "conditional alias",
        body: `export function App() {
  const u = st.value.user; const other = { name: "o" };
  const cur = other.name === "o" ? u : other;
  return <p>{cur.name}</p>;
}`,
        steps: [{ text: "a" }, { run: rename, text: "b" }],
      },
      {
        name: "array literal holding an alias",
        body: `export function App() {
  const u = st.value.user; const list = [u];
  return <p>{list.map((x) => x.name).join()}</p>;
}`,
        steps: [{ text: "a" }, { run: rename, text: "b" }],
      },
      {
        name: "sequence expression",
        body: `export function App() {
  const u = st.value.user; const w = (0, u);
  return <p>{w.name}</p>;
}`,
        steps: [{ text: "a" }, { run: rename, text: "b" }],
      },
      {
        name: "logical `||` alias",
        body: `export function App() {
  const u = st.value.user; const w = null || u;
  return <p>{w.name}</p>;
}`,
        steps: [{ text: "a" }, { run: rename, text: "b" }],
      },
      {
        name: "logical `&&` alias",
        body: `export function App() {
  const u = st.value.user; const other = { name: "o" }; const w = other.name === "o" && u;
  return <p>{w.name}</p>;
}`,
        steps: [{ text: "a" }, { run: rename, text: "b" }],
      },
      {
        name: "object literal property holding an alias",
        body: `export function App() {
  const u = st.value.user; const box = { inner: u };
  return <p>{box.inner.name}</p>;
}`,
        steps: [{ text: "a" }, { run: rename, text: "b" }],
      },
    ];
    for (const definition of aliasCases) {
      it(`${definition.name}`, async () => {
        const run = scenario(definition);
        expect(await run.observe()).toEqual(run.expected);
      });
    }
  });

  describe("T6: aliases from capturing helper calls and local containers", () => {
    it("treats the result of a capturing helper call as an alias", async () => {
      const run = scenario({
        name: "helper result",
        body: `function getUser() { return st.value.user; }
  export function App() {
    const u = getUser();
    return <p>{u.name}</p>;
  }`,
        steps: [{ text: "a" }, { run: rename, text: "b" }],
      });
      expect(await run.observe()).toEqual(run.expected);
    });
    it("treats a local array filled with aliases as an alias", async () => {
      const run = scenario({
        name: "visible.push(alias)",
        body: `export function App() {
    const visible = [];
    for (const task of st.value.tasks) if (!task.done) visible.push(task);
    return <ul>{visible.map((t) => <li key={t.t}>{t.t}</li>)}</ul>;
  }`,
        steps: [{ text: "a" }, { run: retitle, text: "z" }],
      });
      expect(await run.observe()).toEqual(run.expected);
    });
    it("covers unshift and index assignment into a local container", async () => {
      const run = scenario({
        name: "unshift/index",
        body: `export function App() {
    const first = []; const second = {};
    for (const task of st.value.tasks) { first.unshift(task); second[0] = task; }
    return <p>{first[0].t + "/" + second[0].t}</p>;
  }`,
        steps: [{ text: "a/a" }, { run: retitle, text: "z/z" }],
      });
      expect(await run.observe()).toEqual(run.expected);
    });
  });

  describe("T2: same-module helpers called from inline callbacks and getters", () => {
    const matches = `function matches(x) { return x.includes(q.value); }\n${items}\n`;
    const text = (body: string): string => `${matches}export function App() {\n${body}\n}`;
    const cases: Array<[string, string, string, string]> = [
      ["filter", "return <p>{items.filter((x) => matches(x)).join()}</p>;", "ab", "ab,b"],
      ["reduce", "return <p>{items.reduce((n, x) => n + (matches(x) ? 1 : 0), 0)}</p>;", "1", "2"],
      ["find", "return <p>{String(items.find((x) => matches(x) && x !== 'ab'))}</p>;", "undefined", "b"],
      ["some", "return <p>{String(items.some((x) => matches(x) && x === 'b'))}</p>;", "false", "true"],
      ["every", "return <p>{String(items.every((x) => !matches(x) || x === 'ab'))}</p>;", "true", "false"],
      ["sort comparator", "return <p>{[...items].sort((a, b) => Number(matches(a)) - Number(matches(b))).join()}</p>;", "b,c,ab", "c,ab,b"],
      ["IIFE", "return <p>{(() => String(matches('b')))()}</p>;", "false", "true"],
      [
        "component-local arrow",
        "const hit = (x) => x.includes(q.value);\nreturn <p>{items.filter((x) => hit(x)).join()}</p>;",
        "ab",
        "ab,b",
      ],
      [
        "object getter calling a reading helper",
        "const o = { get hits() { return matches('b'); } };\nreturn <p>{String(o.hits)}</p>;",
        "false",
        "true",
      ],
    ];
    for (const [name, body, before, after] of cases) {
      it(`captures ${name}`, async () => {
        const run = scenario({
          name,
          body: text(body),
          steps: [{ text: before }, { run: setQ, text: after }],
        });
        expect(await run.observe()).toEqual(run.expected);
      });
    }
  });

  describe("T7: synchronous calls with an unresolvable callee", () => {
    const extSignal = library.signal(1);
    const bumpExt = (): void => { extSignal.value = 5; };
    const readsS: Step[] = [{ text: "0:1" }, { run: bumpS, text: "0:5" }];
    it("captures a method of an imported object", async () => {
      const run = scenario({
        name: "imported store",
        prelude: `import { extStore } from "./ext";\n`,
        modules: { "./ext": { extStore: { total: () => extSignal.value } } },
        body: `export function App() { return <p>{tick.value}:{extStore.total()}</p>; }`,
        steps: [{ run: () => { extSignal.value = 1; }, text: "0:1" }, { run: bumpExt, text: "0:5" }],
      });
      expect(await run.observe()).toEqual(run.expected);
    });
    // A builtin-looking method name says nothing about the receiver: an
    // imported or module-level object can define `map`/`filter`/`toString`
    // that read signals.
    for (const method of ["map", "filter", "toString", "join", "valueOf"]) {
      it(`captures an imported object's \`${method}\` method`, async () => {
        const run = scenario({
          name: `imported ${method}`,
          prelude: `import { extStore } from "./ext";\n`,
          modules: { "./ext": { extStore: { [method]: () => extSignal.value } } },
          body: `export function App() { return <p>{tick.value}:{extStore.${method}()}</p>; }`,
          steps: [{ run: () => { extSignal.value = 1; }, text: "0:1" }, { run: bumpExt, text: "0:5" }],
        });
        expect(await run.observe()).toEqual(run.expected);
      });
      it(`captures a module-level object's \`${method}\` method`, async () => {
        const run = scenario({
          name: `module ${method}`,
          prelude: `const store = { ${method}() { return s.value; } };\n`,
          body: `export function App() { return <p>{tick.value}:{store.${method}()}</p>; }`,
          steps: readsS,
        });
        expect(await run.observe()).toEqual(run.expected);
      });
    }
    // A local name for such an object is still that object: where the
    // receiver came from, not that it is a local, decides.
    const aliasShapes: Array<[string, string]> = [
      ["a local alias", "const localStore = extStore;\n    return <p>{tick.value}:{localStore.METHOD()}</p>;"],
      ["a two-step local alias", "const first = extStore;\n    const second = first;\n    return <p>{tick.value}:{second.METHOD()}</p>;"],
      ["a conditional", "const picked = tick.value >= 0 ? extStore : null;\n    return <p>{tick.value}:{picked.METHOD()}</p>;"],
      ["an object property", "const holder = { store: extStore };\n    return <p>{tick.value}:{holder.store.METHOD()}</p>;"],
      ["a destructured property", "const { store } = { store: extStore };\n    return <p>{tick.value}:{store.METHOD()}</p>;"],
      ["an array element", "const [store] = [extStore];\n    return <p>{tick.value}:{store.METHOD()}</p>;"],
      ["a reassigned let", "let target = [];\n    target = extStore;\n    return <p>{tick.value}:{target.METHOD()}</p>;"],
      ["an element of a local array", "const box = [extStore];\n    return <p>{tick.value}:{box[0].METHOD()}</p>;"],
      ["an element of an array literal", "return <p>{tick.value}:{[extStore][0].METHOD()}</p>;"],
      ["a local taken from an array element", "const box = [extStore];\n    const item = box[0];\n    return <p>{tick.value}:{item.METHOD()}</p>;"],
      ["an element of a builtin method result", "const box = [extStore];\n    return <p>{tick.value}:{box.filter(Boolean)[0].METHOD()}</p>;"],
      ["an element removed from a local array", "const box = [extStore];\n    return <p>{tick.value}:{box.slice().pop().METHOD()}</p>;"],
      ["an element of a mapped array", "const ids = [1];\n    return <p>{tick.value}:{ids.map(() => extStore)[0].METHOD()}</p>;"],
      ["a props reduce result", "return <p>{tick.value}:{items.reduce(() => extStore, extStore).METHOD()}</p>;"],
      ["a props reduce initial value", "return <p>{tick.value}:{empty.reduce((acc) => acc, extStore).METHOD()}</p>;"],
      ["a props reduceRight result", "return <p>{tick.value}:{items.reduceRight(() => extStore, extStore).METHOD()}</p>;"],
      ["a local holding a props reduce result", "const acc = items.reduce(() => extStore, null);\n    return <p>{tick.value}:{acc.METHOD()}</p>;"],
    ];
    for (const method of ["map", "filter", "toString"]) {
      for (const [shape, body] of aliasShapes) {
        it(`captures an imported object's \`${method}\` through ${shape}`, async () => {
          const run = scenario({
            name: `${shape} ${method}`,
            prelude: `import { extStore } from "./ext";\n`,
            modules: { "./ext": { extStore: { [method]: () => extSignal.value } } },
            body: `export function App({ items = [1, 2], empty = [] } = {}) {\n    ${body.replaceAll("METHOD", method)}\n  }`,
            steps: [{ run: () => { extSignal.value = 1; }, text: "0:1" }, { run: bumpExt, text: "0:5" }],
          });
          expect(await run.observe()).toEqual(run.expected);
        });
      }
    }
    it("captures a callback returned by a Hook", async () => {
      const run = scenario({
        name: "useCallback",
        prelude: `import { useCallback } from "react";\n`,
        body: `export function App() {
    const get = useCallback(() => s.value, []);
    return <p>{tick.value}:{get()}</p>;
  }`,
        steps: readsS,
      });
      expect(await run.observe()).toEqual(run.expected);
    });
    it("captures a method of a custom Hook result", async () => {
      const run = scenario({
        name: "custom hook result",
        prelude: `function useReader() { return { read: () => s.value }; }\n`,
        body: `export function App() {
    const c = useReader();
    return <p>{tick.value}:{c.read()}</p>;
  }`,
        steps: readsS,
      });
      expect(await run.observe()).toEqual(run.expected);
    });
    it("captures a method of a module-level class instance", async () => {
      const run = scenario({
        name: "class instance",
        prelude: `class Store { total() { return s.value; } }\nconst store = new Store();\n`,
        body: `export function App() { return <p>{tick.value}:{store.total()}</p>; }`,
        steps: readsS,
      });
      expect(await run.observe()).toEqual(run.expected);
    });
    it("captures an alias of a reading function", async () => {
      const run = scenario({
        name: "alias call",
        prelude: `function readS() { return s.value; }\n`,
        body: `export function App() {
    const r = readS;
    return <p>{tick.value}:{r()}</p>;
  }`,
        steps: readsS,
      });
      expect(await run.observe()).toEqual(run.expected);
    });
    it("captures a method reached through a shorthand property", async () => {
      const run = scenario({
        name: "shorthand",
        prelude: `function readS() { return s.value; }\n`,
        body: `export function App() {
    const o = { readS };
    return <p>{tick.value}:{o.readS()}</p>;
  }`,
        steps: readsS,
      });
      expect(await run.observe()).toEqual(run.expected);
    });
    it("captures an optional call", async () => {
      const run = scenario({
        name: "optional call",
        prelude: `function readS() { return s.value; }\n`,
        body: `export function App() {
    const f = tick.value >= 0 ? readS : null;
    return <p>{tick.value}:{f?.()}</p>;
  }`,
        steps: readsS,
      });
      expect(await run.observe()).toEqual(run.expected);
    });
    it("iterates a generator helper lazily inside the capture", async () => {
      const run = scenario({
        name: "generator",
        prelude: `function* gen() { yield s.value; yield 2; }\n`,
        body: `export function App() {
    const out = [];
    for (const v of gen()) out.push(v);
    return <p>{tick.value}:{out.join()}</p>;
  }`,
        steps: [{ text: "0:1,2" }, { run: bumpS, text: "0:5,2" }],
      });
      expect(await run.observe()).toEqual(run.expected);
    });
    it("keeps Hook calls out of capture closures", () => {
      const code = transformReactFineGrainedSignals(`
import { signal } from "react-fine-grained-signals";
import { useCallback } from "react";
const s = signal(1);
export function App() {
  const get = useCallback(() => s.value, []);
  return <p>{s.value}{get()}</p>;
}
`, "Fixture.jsx", {
        importSource: "react-fine-grained-signals",
        mode: "auto",
        transform: "managed",
        reactCompiler: "auto",
        reactImportSource: "react",
      })?.code ?? "";
      expect(code).not.toMatch(/capture\(\(\) => [^)]*useCallback/);
      expect(code).toMatch(/const get = useCallback\(/);
    });
  });

  describe("more alias flows", () => {
    const flowCases: Scenario[] = [
      {
        name: "getter that reads through an alias",
        body: `export function App() {
  const u = st.value.user;
  const o = { get n() { return u.name; }, plain: 1, m() { return 2; } };
  return <p>{o.n}</p>;
}`,
        steps: [{ text: "a" }, { run: rename, text: "b" }],
      },
      {
        name: "a Set and a Map that receive aliases",
        body: `export function App() {
  const seen = new Set(); const byKey = new Map();
  for (const task of st.value.tasks) { seen.add(task); byKey.set("k", task); }
  return <p>{[...seen].map((x) => x.t).join() + "/" + byKey.get("k").t}</p>;
}`,
        steps: [{ text: "a/a" }, { run: retitle, text: "z/z" }],
      },
      {
        name: "for-of into an existing variable",
        body: `export function App() {
  let task;
  for (task of st.value.tasks) { /* last one wins */ }
  return <p>{task.t}</p>;
}`,
        steps: [{ text: "a" }, { run: retitle, text: "z" }],
      },
      {
        name: "logical assignment and spread push",
        body: `export function App() {
  let w; w ||= st.value.tasks;
  const out = []; out.push(...w);
  return <p>{out[0].t}</p>;
}`,
        steps: [{ text: "a" }, { run: retitle, text: "z" }],
      },
      {
        name: "TS-wrapped container and member write into it",
        typescript: true,
        body: `export function App() {
  const list: Array<{ t: string }> = []; const box: Record<string, { t: string }> = {};
  for (const task of st.value.tasks) { (list as Array<{ t: string }>).push(task); box.first = task; }
  return <p>{list[0]!.t + "/" + box.first!.t}</p>;
}`,
        steps: [{ text: "a/a" }, { run: retitle, text: "z/z" }],
      },
    ];
    for (const definition of flowCases) {
      it(`${definition.name}`, async () => {
        const run = scenario(definition);
        expect(await run.observe()).toEqual(run.expected);
      });
    }
  });

  describe("scalability", () => {
    const run = (source: string): number => {
      const started = performance.now();
      transformReactFineGrainedSignals(source, "Fixture.jsx", {
        importSource: "react-fine-grained-signals",
        mode: "auto",
        transform: "managed",
        reactCompiler: "auto",
        reactImportSource: "react",
      });
      return performance.now() - started;
    };
    // The fastest of a few runs keeps a GC pause from skewing the ratios.
    const fastest = (source: string): number => Math.min(run(source), run(source), run(source));
    const helperChain = (n: number): string => {
      const lines = [`import { signal } from "react-fine-grained-signals";`, `const s = signal(1);`];
      for (let i = 0; i < n; i += 1) lines.push(`function h${i}(x) { return h${i + 1}(x); }`);
      lines.push(`function h${n}(x) { return s.value + x; }`);
      lines.push(`export function Comp() { return <p>{h0(1)}</p>; }`);
      return lines.join("\n");
    };
    const aliasChain = (n: number): string => {
      const lines = [
        `import { deepSignal } from "react-fine-grained-signals";`,
        `const st = deepSignal({ x: { y: 1 } });`,
        `export function Comp() {`,
        `  let ${Array.from({ length: n + 1 }, (_, i) => `a${i}`).join(", ")};`,
      ];
      // Each alias is learned only from the statement after it.
      for (let i = 0; i < n; i += 1) lines.push(`  a${i} = a${i + 1};`);
      lines.push(`  a${n} = st.value.x;`, `  return <p>{a0.y}</p>;`, `}`);
      return lines.join("\n");
    };
    it("handles a deep chain of same-module helpers without stack overflow or quadratic time", () => {
      run(helperChain(20));
      const small = fastest(helperChain(50));
      const large = fastest(helperChain(600));
      expect(large).toBeLessThan(5000);
      // Linear growth would be 12x; allow generous headroom, quadratic is 144x.
      expect(large / Math.max(small, 1)).toBeLessThan(48);
    });
    it("handles a long reverse-ordered alias chain in near-linear time", () => {
      run(aliasChain(20));
      const small = fastest(aliasChain(100));
      const large = fastest(aliasChain(800));
      // About 0.2s when linear; the per-pass relearning took several seconds.
      expect(large).toBeLessThan(2000);
      // Linear growth would be 8x; quadratic is 64x.
      expect(large / Math.max(small, 1)).toBeLessThan(40);
    });
  });
});

describe("capture decisions for aliases, unresolved calls, and folded helpers", () => {
  const shape = (
    source: string,
    mode: ReactFineGrainedSignalsMode = "auto",
    file = "Fixture.jsx",
  ): { code: string; warnings: string[] } => {
    const warnings: string[] = [];
    const code = transformReactFineGrainedSignals(source, file, {
      importSource: "react-fine-grained-signals",
      mode,
      transform: "managed",
      reactCompiler: "auto",
      reactImportSource: "react",
      warn: (warning) => warnings.push(warning.message),
    })?.code ?? "";
    return { code, warnings };
  };
  const head = `import { signal } from "react-fine-grained-signals";\nconst s = signal(1);\n`;

  it("trusts a builtin method name only on data the function owns", () => {
    const { code } = shape(`${head}
import { useState } from "react";
import { store } from "./store";
const moduleStore = makeStore();
function useReader() { return { map: () => s.value }; }
export function App(p) {
  const r = useReader();
  const local = [1, 2];
  const label = p.title;
  const [rows] = useState([1]);
  const visible = p.items.filter(Boolean);
  const keep = [p.items.map((x) => x), local.map((x) => x), label.toString(), "a b".split(" "), [3].join(), rows.map((x) => x), visible.map((x) => x)];
  return <p>{s.value}{store.map()}{store.list.filter(Boolean)}{moduleStore.toString()}{r.map()}{keep}</p>;
}
`);
    for (const reads of ["store.map()", "store.list.filter(Boolean)", "moduleStore.toString()", "r.map()"]) {
      expect(code).toContain(`capture(() => ${reads})`);
    }
    for (const builtin of ["p.items.map", "local.map", "label.toString", "split(", ".join(", "rows.map", "visible.map"]) {
      const captured = new RegExp(`capture\\(\\(\\) => [^\\n]*${builtin.replace(/[.()|]/g, "\\$&")}`).test(code);
      expect(`${builtin} captured: ${captured}`).toBe(`${builtin} captured: false`);
    }
  });

  it("judges a builtin method name by where the receiver came from, not by its being a local", () => {
    for (const mode of ["auto", "all"] as const) {
      const { code } = shape(`${head}
import { store } from "./store";
export function List({ items, title }) {
  const visible = items.filter(Boolean);
  const label = title ?? "none";
  const names = ["a", "b"];
  const first = items.filter(Boolean)[0];
  const last = items.slice().pop();
  const picked = items.reduce(() => store, store);
  return <p>{s.value}{visible.map(String).join(",")}{label.toString()}{names.map((n) => n).join()}{first.trim()}{[1, 2].at(0)}{last.trim()}{picked.map()}</p>;
}
export function Elements() {
  const box = [store];
  const item = box[0];
  return <p>{s.value}{box.map(String)}{item.map()}{[store][0].filter(Boolean)}{box.slice().pop().toString()}{[store][0].total()}</p>;
}
export function Aliased() {
  const first = store;
  const second = first;
  const holder = { store };
  return <p>{s.value}{second.map()}{holder.store.filter(Boolean)}{first.toString()}</p>;
}
`, mode);
      for (const builtin of ["visible.map", "label.toString", "names.map", "items.filter", "first.trim", "[1, 2].at", "box.map", "last.trim"]) {
        const captured = code.includes(`capture(() => ${builtin}`);
        expect(`${mode} ${builtin} captured: ${captured}`).toBe(`${mode} ${builtin} captured: false`);
      }
      for (const reads of [
        "second.map()", "holder.store.filter(Boolean)", "first.toString()",
        "item.map()", "[store][0].filter(Boolean)", "box.slice().pop().toString()", "[store][0].total()", "picked.map()",
      ]) {
        expect(code).toContain(`capture(() => ${reads})`);
      }
    }
  });

  it("captures calls into code it cannot see and leaves provably unrelated calls alone", () => {
    const { code, warnings } = shape(`${head}
import * as ns from "./ns";
import ext, { named } from "./ext";
function getFn() { return ext; }
export function App(p) {
  const a = ns.f(1);
  const b = named.g(2);
  const c = getFn()(3);
  const keep = [
    Math.max(1, 2), JSON.stringify(p), signal(2), [1, 2].at(0), p.items.map((x) => x),
    named.Header(), (p.a || p.b)(), p.name.trim(), new Intl.NumberFormat().format(1),
  ];
  return <p>{s.value}{a}{b}{c}{keep}</p>;
}
`);
    expect(code).toContain("capture(() => ns.f(1))");
    expect(code).toContain("capture(() => named.g(2))");
    expect(code).toContain("capture(() => getFn()(3))");
    for (const unrelated of ["Math.max", "JSON.stringify", "signal(2)", ".at(0)", "named.Header", "p.a || p.b", "trim()", "Intl.NumberFormat"]) {
      const captured = new RegExp(`capture\\(\\(\\) => [^\\n]*${unrelated.replace(/[.()|]/g, "\\$&")}`).test(code);
      expect(`${unrelated} captured: ${captured}`).toBe(`${unrelated} captured: false`);
    }
    expect(warnings).toEqual([]);
  });

  it("captures an unresolved call through `this` in an object-literal component", () => {
    const { code } = shape(`${head}
export const holder = {
  Panel() { return <p>{s.value}{this.missing()}</p>; },
};
`);
    expect(code).toContain("capture(() => this.missing())");
  });

  it("leaves a Hook that shares an unresolved call alone without a warning", () => {
    const { code, warnings } = shape(`${head}
import { useId } from "react";
import ext from "./ext";
export function App() {
  const hooked = ext.run(useId());
  return <p>{s.value}{hooked}</p>;
}
`);
    expect(code).toContain("ext.run(useId())");
    expect(code).not.toContain("capture(() => ext.run");
    expect(warnings).toEqual([]);
  });

  it("does not treat an alias handed to a Hook as a read", () => {
    const { code, warnings } = shape(`
import { deepSignal } from "react-fine-grained-signals";
import { useState } from "react";
const st = deepSignal({ user: { name: "a" } });
export function App() {
  const u = st.value.user;
  const [seed] = useState(u);
  const [{ name }] = useState(u);
  return <p>{seed.name}{name}</p>;
}
`);
    expect(code).toContain("useState(u)");
    expect(code).not.toContain("capture(() => useState");
    expect(warnings).toEqual([]);
  });

  it("selects only the components whose folded helper graph reads a signal", () => {
    const { code } = shape(`${head}
function h0() { return h1() + h2(); }
function h1() { return h3(); }
function h2() { return h3(); }
function h3() { return s.value; }
function p() { return q(); }
function q() { return p() + r(); }
function r() { return 1; }
function m() { return n(); }
function n() { return m() + s.value; }
export function A() { return <p>{h0()}</p>; }
export function B() { return <p>{h0()}</p>; }
export function C() { return <p>{p()}</p>; }
export function D() { return <p>{p()}</p>; }
export function E() { return <p>{m()}</p>; }
`);
    expect(code.match(/= _useSignalCapture\(\)/g)).toHaveLength(3);
    for (const name of ["A", "B", "E"]) {
      expect(code).toMatch(new RegExp(`function ${name}\\(\\) \\{\\s+"use no memo";`));
    }
  });

  it("carries JSX through render callbacks however they are also referenced", () => {
    const { code } = shape(`${head}
function Row() { return <li>{s.value}</li>; }
function note(row) { return row; }
export function ListA({ items }) { return items.map(Row); }
export function ListB({ items }) { note(Row); return items.map(Row); }
export function ListC({ items }) { items.map(Row); return note(Row); }
`, "all");
    expect(code.match(/= _useSignalCapture\(\)/g)).toHaveLength(3);
  });

  it("warns about a render prop whose callback reaches a signal through a helper", () => {
    const { warnings } = shape(`${head}
function helper() { return s.value; }
function Grid({ renderItem }) { return renderItem(); }
export function App() { return <Grid renderItem={() => helper()} />; }
`);
    expect(warnings.some((message) => message.includes("JSX callback prop"))).toBe(true);
  });
});
