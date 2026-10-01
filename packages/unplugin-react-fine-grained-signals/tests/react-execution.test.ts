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
import { act, createElement, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as reactJsxRuntime from "react/jsx-runtime";
import { transformWithOxc } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as library from "../../../src/index.js";
import type { Signal } from "../../../src/index.js";
import * as libraryRuntime from "../../../src/runtime.js";
import { transformReactFineGrainedSignals } from "../src/internal/transform.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const MODULES = "__modules";
const EXPORTS = "__exports";

const moduleRegistry: Record<string, unknown> = {
  "react/jsx-runtime": reactJsxRuntime,
  "react-fine-grained-signals": library,
  "react-fine-grained-signals/runtime": libraryRuntime,
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
  { transform = true }: { transform?: boolean } = {},
): Promise<Record<string, unknown>> {
  const transformed = transform
    ? transformReactFineGrainedSignals(source, "Fixture.jsx", {
      importSource: "react-fine-grained-signals",
      mode: "auto",
      transform: "managed",
      reactCompiler: "auto",
      reactImportSource: "react",
    })?.code ?? source
    : source;
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
    expect(transformed.match(/useManagedSignals\(\)/g)).toHaveLength(1);
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
    expect(transformed.match(/useManagedSignals\(\)/g)).toHaveLength(1);
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
