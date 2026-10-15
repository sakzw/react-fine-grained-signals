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

import { transformSync, type PluginItem, type PluginObject } from "@babel/core";
import * as t from "@babel/types";
import { act, createElement, Suspense, useState, type FunctionComponent } from "react";
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
  react: { Suspense, useState },
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
  }: {
    transform?: boolean;
    mode?: ReactFineGrainedSignalsMode;
    codegen?: ReactFineGrainedSignalsTransform;
    experimentalCapture?: boolean;
    modules?: Record<string, unknown>;
  } = {},
): Promise<Record<string, unknown>> {
  const transformed = transform
    ? transformReactFineGrainedSignals(source, "Fixture.jsx", {
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
  const jsx = await transformWithOxc(transformed, "Fixture.jsx", {
    lang: "jsx",
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
