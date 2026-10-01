// @vitest-environment jsdom
/// <reference lib="dom" />

/**
 * Plugin ordering against React Compiler under a real `vite.build()`.
 *
 * `@vitejs/plugin-react` 6 enables the compiler with `react({ compiler: true })`,
 * which unshifts a `vite:react-compiler` plugin to the front of what `react()`
 * returns. That plugin is `enforce: "pre"` with a filtered object `transform`
 * hook and no `order`, and its handler runs the compiler and lowers JSX in one
 * step. plugin-react itself (and the `oxc-transform-react` engine it imports)
 * is not a dependency here, so `emulatedReactCompiler` reproduces exactly that
 * plugin shape around babel-plugin-react-compiler; everything that decides the
 * outcome -- Vite's own plugin sorting and this package's real Vite plugin --
 * is the genuine article.
 *
 * Without hook-level ordering, two `enforce: "pre"` plugins run in array order,
 * so `[react({ compiler: true }), signals()]` compiled the component first: its
 * JSX was cached behind the memo sentinel and lowered away before this
 * transform saw it, and the UI never updated after mount. The control case pins
 * that by registering the transform without `order` (the Rollup entry's shape).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transformSync, type PluginItem, type PluginObject } from "@babel/core";
import * as t from "@babel/types";
import reactCompiler from "babel-plugin-react-compiler";
import { act, createElement, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as reactCompilerRuntime from "react/compiler-runtime";
import * as reactJsxRuntime from "react/jsx-runtime";
import { build, transformWithOxc, type Plugin } from "vite";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as library from "../../../src/index.js";
import type { Signal } from "../../../src/index.js";
import * as libraryRuntime from "../../../src/runtime.js";
import rollupAdapter from "../src/rollup.js";
import viteAdapter from "../src/vite.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const fixtureDir = mkdtempSync(join(tmpdir(), "signals-vite-order-"));
const entry = join(fixtureDir, "app.jsx");
writeFileSync(
  entry,
  [
    'import { signal } from "react-fine-grained-signals";',
    "export const count = signal(0);",
    "export function Counter() {",
    "  return <output>{count.value}</output>;",
    "}",
    "",
  ].join("\n"),
);

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

/** The shape of plugin-react 6's `vite:react-compiler` plugin, around babel-plugin-react-compiler. */
function emulatedReactCompiler(): Plugin {
  return {
    name: "vite:react-compiler",
    enforce: "pre",
    transform: {
      filter: { id: /\.[jt]sx?$/ },
      async handler(code, id) {
        const compiled = transformSync(code, {
          babelrc: false,
          configFile: false,
          filename: id,
          parserOpts: { plugins: ["jsx"] },
          plugins: [[reactCompiler, { panicThreshold: "none" }] as PluginItem],
        });
        if (typeof compiled?.code !== "string") throw new Error("react compiler emitted no code");
        // plugin-react's compiler step lowers JSX in the same pass, so whatever
        // runs after it never sees JSX at all.
        const lowered = await transformWithOxc(compiled.code, id, {
          lang: "jsx",
          jsx: { runtime: "automatic", importSource: "react" },
        });
        return { code: lowered.code, map: null };
      },
    },
  };
}

async function buildApp(plugins: Plugin[]): Promise<string> {
  const result = await build({
    configFile: false,
    envFile: false,
    root: fixtureDir,
    logLevel: "silent",
    plugins,
    build: {
      write: false,
      minify: false,
      lib: { entry, formats: ["es"], fileName: "app" },
      rolldownOptions: {
        external: [/^react(\/|$)/, /^react-dom(\/|$)/, /^react-fine-grained-signals(\/|$)/],
      },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const output of outputs) {
    if ("output" in output) {
      const chunk = output.output.find((item) => item.type === "chunk");
      if (chunk !== undefined && "code" in chunk) return chunk.code;
    }
  }
  throw new Error("vite build produced no chunk");
}

const MODULES = "__modules";
const EXPORTS = "__exports";

const moduleRegistry: Record<string, unknown> = {
  "react/jsx-runtime": reactJsxRuntime,
  "react/compiler-runtime": reactCompilerRuntime,
  "react-fine-grained-signals": library,
  "react-fine-grained-signals/runtime": libraryRuntime,
};

// Turns the built ES module into something `new Function` can run: named
// imports read from the registry, and the bundle's trailing `export { ... }`
// list becomes assignments.
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
      if (path.node.declaration !== null && path.node.declaration !== undefined) {
        throw path.buildCodeFrameError("the bundle is expected to export through a specifier list");
      }
      path.replaceWithMultiple(
        path.node.specifiers.map((specifier) => {
          if (!t.isExportSpecifier(specifier) || !t.isIdentifier(specifier.exported)) {
            throw path.buildCodeFrameError("unexpected export specifier");
          }
          return t.expressionStatement(
            t.assignmentExpression(
              "=",
              t.memberExpression(t.identifier(EXPORTS), t.identifier(specifier.exported.name)),
              t.cloneNode(specifier.local),
            ),
          );
        }),
      );
    },
  },
};

function linkModule(code: string): Record<string, unknown> {
  const linked = transformSync(code, {
    babelrc: false,
    configFile: false,
    filename: "app.js",
    plugins: [moduleLinker as PluginItem],
  });
  if (typeof linked?.code !== "string") throw new Error("module linking emitted no code");
  const moduleExports: Record<string, unknown> = {};
  new Function(MODULES, EXPORTS, linked.code)(moduleRegistry, moduleExports);
  return moduleExports;
}

const mounted: { root: Root; container: HTMLElement }[] = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});

/** Mounts `Counter`, writes the signal twice, and returns what the DOM showed after each step. */
function drive(module: Record<string, unknown>): string[] {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(module.Counter as FunctionComponent));
  });
  mounted.push({ root, container });
  const seen = [container.textContent ?? ""];
  for (const next of [1, 2]) {
    act(() => {
      (module.count as Signal<number>).value = next;
    });
    seen.push(container.textContent ?? "");
  }
  return seen;
}

// `vite.build` plus a jsdom mount per case; generous for a cold Windows worker.
const BUILD_TIMEOUT = 60_000;

describe("Vite plugin order against a pre-enforced React Compiler step", () => {
  it("control: a transform without hook order loses to a compiler listed first", async () => {
    // The Rollup entry's plugin is `enforce: "pre"` with a plain function
    // transform -- exactly what the Vite entry used to be.
    const code = await buildApp([emulatedReactCompiler(), rollupAdapter({ mode: "auto" }) as Plugin]);

    expect(code).toContain("react/compiler-runtime");
    expect(code).toContain("react.memo_cache_sentinel");
    expect(code).not.toContain("use no memo");
    expect(code).not.toContain("useManagedSignals");
    expect(drive(linkModule(code))).toEqual(["0", "0", "0"]);
  }, BUILD_TIMEOUT);

  it.each([
    ["compiler first", (signals: Plugin) => [emulatedReactCompiler(), signals]],
    ["signals first", (signals: Plugin) => [signals, emulatedReactCompiler()]],
  ] as const)("runs ahead of the compiler with %s", async (_label, order) => {
    const code = await buildApp(order(viteAdapter({ mode: "auto" }) as Plugin));

    expect(code).toContain('"use no memo"');
    expect(code).toContain("useManagedSignals");
    expect(code).not.toContain("react/compiler-runtime");
    expect(drive(linkModule(code))).toEqual(["0", "1", "2"]);
  }, BUILD_TIMEOUT);
});
