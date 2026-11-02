/**
 * Runs a fixture module in memory against the real runtime in `../../src`:
 * this package's transform, then JSX lowering with Oxc, then an in-memory
 * linker that turns imports into reads from a registry. Shared by
 * `react-execution.test.ts` and `runtime-differential.test.ts`.
 */

import { transformSync, type PluginItem, type PluginObject } from "@babel/core";
import * as t from "@babel/types";
import { Suspense, useCallback, useState } from "react";
import * as reactJsxRuntime from "react/jsx-runtime";
import { transformWithOxc } from "vite";
import * as library from "../../../src/index.js";
import * as libraryJsxRuntime from "../../../src/jsx/jsx-runtime.js";
import * as libraryInternal from "../../../src/internal.js";
import { useManagedSignals } from "../../../src/react/use-signals.js";
import * as libraryUtils from "../../../src/utils.js";
import {
  transformReactFineGrainedSignals,
  type ReactFineGrainedSignalsMode,
  type ReactFineGrainedSignalsTransform,
} from "../src/internal/transform.js";

const MODULES = "__modules";
const EXPORTS = "__exports";

export const moduleRegistry: Record<string, unknown> = {
  react: { Suspense, useCallback, useState },
  "react/jsx-runtime": reactJsxRuntime,
  "react-fine-grained-signals": library,
  "react-fine-grained-signals/jsx/jsx-runtime": libraryJsxRuntime,
  // `useManagedSignals` is no longer public; the control fixtures still need a
  // hook that behaves like a hand-written boundary.
  "react-fine-grained-signals/internal": { ...libraryInternal, useManagedSignals },
  "react-fine-grained-signals/utils": libraryUtils,
};

// The same in-memory linker `react-compiler.test.ts` uses: named and namespace
// imports become reads from a registry, declaration exports (named or
// default) become assignments.
const moduleLinker: PluginObject = {
  name: "test-module-linker",
  visitor: {
    ImportDeclaration(path) {
      const source = t.memberExpression(t.identifier(MODULES), t.stringLiteral(path.node.source.value), true);
      const [first] = path.node.specifiers;
      if (path.node.specifiers.length === 1 && t.isImportNamespaceSpecifier(first)) {
        path.replaceWith(t.variableDeclaration("const", [t.variableDeclarator(t.cloneNode(first.local), source)]));
        return;
      }
      const properties = path.node.specifiers.map((specifier) => {
        if (!t.isImportSpecifier(specifier) || !t.isIdentifier(specifier.imported)) {
          throw path.buildCodeFrameError("fixtures only use named or namespace imports");
        }
        return t.objectProperty(t.identifier(specifier.imported.name), t.cloneNode(specifier.local));
      });
      path.replaceWith(t.variableDeclaration("const", [t.variableDeclarator(t.objectPattern(properties), source)]));
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
          ),
        ),
      ]);
    },
    ExportDefaultDeclaration(path) {
      const declaration = path.node.declaration;
      if (!t.isFunctionDeclaration(declaration) || !declaration.id) {
        throw path.buildCodeFrameError("fixtures only default-export named function declarations");
      }
      path.replaceWithMultiple([
        declaration,
        t.expressionStatement(
          t.assignmentExpression(
            "=",
            t.memberExpression(t.identifier(EXPORTS), t.identifier("default")),
            t.identifier(declaration.id.name),
          ),
        ),
      ]);
    },
  },
};

export interface LoadModuleOptions {
  transform?: boolean;
  mode?: ReactFineGrainedSignalsMode;
  codegen?: ReactFineGrainedSignalsTransform;
  /** Extra registry entries; an entry replaces the default for that specifier. */
  modules?: Record<string, unknown>;
  typescript?: boolean;
  /** Edits the transform's output (or the source, untransformed) before JSX lowering. */
  rewrite?: (code: string) => string;
  /** Free variables the module body can see, by name. */
  scope?: Record<string, unknown>;
  /** Receives the transform's warnings; the transform's default when omitted. */
  warn?: (warning: Error) => void;
}

/** Transforms, lowers and links `source`, runs it, and returns its exports. */
export async function loadModule(
  source: string,
  {
    transform = true,
    mode = "auto",
    codegen = "managed",
    modules = {},
    typescript = false,
    rewrite = (code) => code,
    scope = {},
    warn,
  }: LoadModuleOptions = {},
): Promise<Record<string, unknown>> {
  const fixtureName = typescript ? "Fixture.tsx" : "Fixture.jsx";
  const transformed = transform
    ? (transformReactFineGrainedSignals(source, fixtureName, {
        importSource: "react-fine-grained-signals",
        mode,
        transform: codegen,
        reactCompiler: "opt-out",
        reactImportSource: "react",
        ...(warn === undefined ? {} : { warn }),
      })?.code ?? source)
    : source;
  // `importSource: "react"` is the project-wide default a per-file
  // `@jsxImportSource` pragma overrides, exactly as under Vite.
  const jsx = await transformWithOxc(rewrite(transformed), fixtureName, {
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
  const names = Object.keys(scope);
  new Function(MODULES, EXPORTS, ...names, linked.code)(
    { ...moduleRegistry, ...modules },
    moduleExports,
    ...names.map((name) => scope[name]),
  );
  return moduleExports;
}
