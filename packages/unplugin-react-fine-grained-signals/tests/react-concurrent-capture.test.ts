// @vitest-environment jsdom

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// Install React's deterministic scheduler before React DOM is loaded. This
// mirrors the runtime concurrent regression but executes transformed managed
// components instead of useSignalTracking components.
const requireFromReactDom = createRequire(
  createRequire(import.meta.url).resolve("react-dom/package.json"),
);
const schedulerPath = requireFromReactDom.resolve("scheduler");
const mockScheduler = requireFromReactDom("scheduler/unstable_mock") as {
  log(value: unknown): void;
  unstable_clearLog(): unknown[];
  unstable_flushNumberOfYields(count: number): void;
  unstable_flushAllWithoutAsserting(): boolean;
};
requireFromReactDom.cache[schedulerPath] = {
  id: schedulerPath,
  filename: schedulerPath,
  loaded: true,
  exports: mockScheduler,
} as NodeJS.Module;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { flushSync } = await import("react-dom");
const { transformSync } = await import("@babel/core");
const t = await import("@babel/types");
const { transformWithOxc } = await import("vite");
const { signal } = await import("../../../src/index.js");
const { transformReactFineGrainedSignals } = await import("../src/internal/transform.js");

const MODULES = "__modules";
const EXPORTS = "__exports";
const moduleLinker = {
  name: "concurrent-capture-linker",
  visitor: {
    ImportDeclaration(path: any) {
      const properties = path.node.specifiers.map((specifier: any) => {
        if (!t.isImportSpecifier(specifier) || !t.isIdentifier(specifier.imported)) {
          throw path.buildCodeFrameError("fixture imports must be named imports");
        }
        return t.objectProperty(t.identifier(specifier.imported.name), t.cloneNode(specifier.local));
      });
      path.replaceWith(t.variableDeclaration("const", [t.variableDeclarator(
        t.objectPattern(properties),
        t.memberExpression(t.identifier(MODULES), t.stringLiteral(path.node.source.value), true),
      )]));
    },
    ExportNamedDeclaration(path: any) {
      const declaration = path.node.declaration;
      if (declaration === null || declaration === undefined) {
        throw path.buildCodeFrameError("fixture exports must be declarations");
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
        ...names.map((name) => t.expressionStatement(t.assignmentExpression(
          "=", t.memberExpression(t.identifier(EXPORTS), t.identifier(name)), t.identifier(name),
        ))),
      ]);
    },
  },
};

async function loadManagedModule(source: string): Promise<Record<string, unknown>> {
  const transformed = transformReactFineGrainedSignals(source, "ConcurrentCapture.jsx", {
    importSource: "react-fine-grained-signals",
    mode: "all",
    transform: "managed",
    reactCompiler: "auto",
    reactImportSource: "react",
    experimentalCapture: true,
  })?.code;
  if (!transformed) throw new Error("managed transform produced no output");
  const jsx = await transformWithOxc(transformed, "ConcurrentCapture.jsx", {
    lang: "jsx",
    jsx: { runtime: "automatic", importSource: "react" },
  });
  const linked = transformSync(jsx.code, {
    babelrc: false,
    configFile: false,
    filename: "ConcurrentCapture.js",
    plugins: [moduleLinker as never],
  });
  if (typeof linked?.code !== "string") throw new Error("module linker produced no output");
  const moduleExports: Record<string, unknown> = {};
  const modules = {
    react: React,
    "react/jsx-runtime": await import("react/jsx-runtime"),
    "react-fine-grained-signals": await import("../../../src/index.js"),
    "react-fine-grained-signals/runtime": await import("../../../src/runtime.js"),
    scheduler: mockScheduler,
  };
  new Function(MODULES, EXPORTS, linked.code)(modules, moduleExports);
  return moduleExports;
}

async function drain(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    mockScheduler.unstable_flushAllWithoutAsserting();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("transformed managed capture under concurrent React", () => {
  it("repairs a mixed read revision after React yields between component fibers", async () => {
    mockScheduler.unstable_clearLog();
    const module = await loadManagedModule(`
import { signal } from "react-fine-grained-signals";
import { log } from "scheduler";
export const source = signal(1);
export function Parent() {
  const value = source.value;
  log("parent:" + value);
  return <div><b data-testid="parent">{value}</b><Child /></div>;
}
function Child() {
  const value = source.value;
  log("child:" + value);
  return <span data-testid="child">{value}</span>;
}
`);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    React.startTransition(() => root.render(React.createElement(module.Parent as React.FunctionComponent)));
    await Promise.resolve();
    await Promise.resolve();
    mockScheduler.unstable_flushNumberOfYields(1);
    expect(mockScheduler.unstable_clearLog()).toEqual(["parent:1"]);

    (module.source as ReturnType<typeof signal<number>>).value = 2;
    await drain();
    const rendered = () => [
      container.querySelector("[data-testid=parent]")?.textContent,
      container.querySelector("[data-testid=child]")?.textContent,
    ];
    expect(rendered()).toEqual(["2", "2"]);
    expect(mockScheduler.unstable_clearLog()).toContain("parent:2");

    (module.source as ReturnType<typeof signal<number>>).value = 3;
    await drain();
    expect(rendered()).toEqual(["3", "3"]);
    root.unmount();
    container.remove();
  });

  it("does not subscribe to a capture from an abandoned yielded attempt", async () => {
    mockScheduler.unstable_clearLog();
    const module = await loadManagedModule(`
import { signal } from "react-fine-grained-signals";
import { log } from "scheduler";
export const abandoned = signal(0);
export let renders = 0;
export function Parent({ show }) {
  renders += 1;
  if (show) {
    const value = abandoned.value;
    log("captured:" + value);
    return <span>{value}</span>;
  }
  log("empty");
  return <span>empty</span>;
}
`);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const Parent = module.Parent as React.FunctionComponent<{ show: boolean }>;
    React.startTransition(() => root.render(React.createElement(Parent, { show: true })));
    await Promise.resolve();
    await Promise.resolve();
    mockScheduler.unstable_flushNumberOfYields(1);
    expect(mockScheduler.unstable_clearLog()).toEqual(["captured:0"]);

    flushSync(() => root.render(React.createElement(Parent, { show: false })));
    expect(container.textContent).toBe("empty");
    const committedRenders = module.renders;
    (module.abandoned as ReturnType<typeof signal<number>>).value = 1;
    await drain();
    expect(module.renders).toBe(committedRenders);
    expect(container.textContent).toBe("empty");
    root.unmount();
    container.remove();
  });
});
