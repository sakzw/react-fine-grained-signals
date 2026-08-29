import { declare } from "@babel/helper-plugin-utils";
import {
  transformSync,
  type NodePath,
  type ParserOptions,
  type PluginObj,
} from "@babel/core";
import * as t from "@babel/types";
import type { TransformResult } from "unplugin";

export type ReactAlienSignalsMode = "manual" | "auto" | "all";
export type ReactAlienSignalsTransform = "inject" | "managed";
export type ReactAlienSignalsReactCompiler = "auto" | "off";

export interface InternalTransformOptions {
  importSource: string;
  mode: ReactAlienSignalsMode;
  transform: ReactAlienSignalsTransform;
  reactCompiler: ReactAlienSignalsReactCompiler;
}

export type InternalTransformResult = Exclude<TransformResult, string>;

interface RuntimeImport {
  identifier: t.Identifier;
  bindingPath: NodePath<t.ImportSpecifier>;
}

interface FunctionInspection {
  containsJSX: boolean;
  readsValue: boolean;
  hasUseSignalsCall: boolean;
}

const useSignalsComment = /(^|\s)@useSignals(\s|$)/;
const noUseSignalsComment = /(^|\s)@noUseSignals(\s|$)/;
const transformedMetadataKey = "reactAlienSignalsTransformed";

// React Compiler caches a component's JSX in its memo cache, and a signal read
// it classifies as non-reactive (a module-scope binding) is then evaluated once
// and never again: the render collector sees no dependencies on every later
// render and drops the component's subscriptions. Opting the functions this
// transform made reactive out of memoization keeps those reads happening.
// See docs/design/react-compiler-compatibility.md for the measurements.
const noMemoDirective = "use no memo";
const memoizationDirectives = new Set([
  "use memo",
  "use forget",
  "use no memo",
  "use no forget",
]);

/** Adds the opt-out unless the author already stated a memoization choice. */
function addNoMemoDirective(body: t.BlockStatement): boolean {
  if (body.directives.some(({ value }) => memoizationDirectives.has(value.value))) {
    return false;
  }
  body.directives.unshift(t.directive(t.directiveLiteral(noMemoDirective)));
  return true;
}

function hasLeadingComment(path: NodePath, pattern: RegExp): boolean {
  return path.node.leadingComments?.some((comment) => pattern.test(comment.value)) ?? false;
}

function hasOwnedLeadingComment(path: NodePath, pattern: RegExp): boolean {
  let current: NodePath | null = path;
  while (current !== null && !current.isProgram()) {
    if (hasLeadingComment(current, pattern)) return true;
    if (current.isStatement()) {
      const parent = current.parentPath;
      return (
        parent !== null &&
        (parent.isExportNamedDeclaration() || parent.isExportDefaultDeclaration()) &&
        hasLeadingComment(parent, pattern)
      );
    }
    current = current.parentPath;
  }
  return false;
}

const reactPackageSource = "react";

/** Is `name` bound by `import { memo } from "react"` (or `forwardRef`, possibly aliased)? */
function isReactNamedImport(
  path: NodePath,
  name: string,
  importedName: "memo" | "forwardRef",
): boolean {
  const binding = path.scope.getBinding(name);
  if (binding === undefined || !binding.path.isImportSpecifier()) return false;
  if (binding.path.node.importKind === "type") return false;
  if (!t.isIdentifier(binding.path.node.imported, { name: importedName })) return false;
  const declaration = binding.path.parentPath;
  return (
    declaration.isImportDeclaration() &&
    declaration.node.importKind !== "type" &&
    declaration.node.source.value === reactPackageSource
  );
}

/** Is `name` bound by `import * as React from "react"` or `import React from "react"`? */
function isReactDefaultOrNamespaceImport(path: NodePath, name: string): boolean {
  const binding = path.scope.getBinding(name);
  if (binding === undefined) return false;
  if (
    !binding.path.isImportNamespaceSpecifier() &&
    !binding.path.isImportDefaultSpecifier()
  ) {
    return false;
  }
  const declaration = binding.path.parentPath;
  return (
    declaration.isImportDeclaration() &&
    declaration.node.importKind !== "type" &&
    declaration.node.source.value === reactPackageSource
  );
}

// A bare `memo`/`forwardRef` name (or `X.memo`/`X.forwardRef`) only counts as
// React's wrapper when it actually resolves back to an import from "react".
// Otherwise a same-named local helper (e.g. a homemade memoization cache)
// could be mistaken for it and have a `useSignals()` hook injected into a
// function that is never actually rendered by React, which throws at runtime.
function isKnownComponentWrapper(path: NodePath<t.CallExpression>): boolean {
  const callee = path.get("callee");
  if (callee.isIdentifier()) {
    const name = callee.node.name;
    return isReactNamedImport(path, name, "memo") || isReactNamedImport(path, name, "forwardRef");
  }
  if (!callee.isMemberExpression()) return false;
  const property = callee.get("property");
  const isMemoOrForwardRefProperty =
    (!callee.node.computed && property.isIdentifier() &&
      (property.node.name === "memo" || property.node.name === "forwardRef")) ||
    (callee.node.computed && property.isStringLiteral() &&
      (property.node.value === "memo" || property.node.value === "forwardRef"));
  if (!isMemoOrForwardRefProperty) return false;
  const object = callee.get("object");
  return object.isIdentifier() && isReactDefaultOrNamespaceImport(path, object.node.name);
}

function getFunctionName(path: NodePath<t.Function>): string | undefined {
  if (
    (path.isFunctionDeclaration() || path.isFunctionExpression()) &&
    path.node.id !== null &&
    path.node.id !== undefined
  ) {
    return path.node.id.name;
  }
  let parent = path.parentPath;
  while (parent.isCallExpression() && isKnownComponentWrapper(parent)) {
    parent = parent.parentPath;
  }
  if (parent.isVariableDeclarator() && t.isIdentifier(parent.node.id)) {
    return parent.node.id.name;
  }
  return undefined;
}

function isComponent(path: NodePath<t.Function>): boolean {
  const name = getFunctionName(path);
  return name !== undefined && /^[A-Z]/.test(name);
}

function isCustomHook(path: NodePath<t.Function>): boolean {
  const name = getFunctionName(path);
  return name !== undefined && /^use[A-Z]/.test(name);
}

function isNamedUseSignalsImport(
  functionPath: NodePath<t.Function>,
  name: string,
  importSource?: string,
): boolean {
  const binding = functionPath.scope.getBinding(name);
  if (binding === undefined || !binding.path.isImportSpecifier()) return false;
  if (binding.path.node.importKind === "type") return false;
  if (!t.isIdentifier(binding.path.node.imported, { name: "useSignals" })) return false;
  const declaration = binding.path.parentPath;
  return (
    declaration.isImportDeclaration() &&
    declaration.node.importKind !== "type" &&
    (importSource === undefined || declaration.node.source.value === importSource)
  );
}

function isNamespaceUseSignalsImport(
  functionPath: NodePath<t.Function>,
  name: string,
  importSource?: string,
): boolean {
  const binding = functionPath.scope.getBinding(name);
  if (binding === undefined || !binding.path.isImportNamespaceSpecifier()) return false;
  const declaration = binding.path.parentPath;
  return (
    declaration.isImportDeclaration() &&
    declaration.node.importKind !== "type" &&
    (importSource === undefined || declaration.node.source.value === importSource)
  );
}

function isUseSignalsCallee(
  functionPath: NodePath<t.Function>,
  callee: NodePath<t.Expression | t.V8IntrinsicIdentifier | t.Super>,
  importSource: string,
  allowBarrel = true,
): boolean {
  if (callee.isIdentifier()) {
    // A named re-export keeps the imported name, so this also recognizes
    // `useSignals` aliases imported through application barrel modules.
    return isNamedUseSignalsImport(
      functionPath,
      callee.node.name,
      allowBarrel ? undefined : importSource,
    );
  }
  if (!callee.isMemberExpression()) return false;
  const object = callee.get("object");
  const property = callee.get("property");
  if (!object.isIdentifier()) return false;
  const isUseSignalsProperty =
    (!callee.node.computed && property.isIdentifier({ name: "useSignals" })) ||
    (callee.node.computed && property.isStringLiteral({ value: "useSignals" }));
  return (
    isUseSignalsProperty &&
    isNamespaceUseSignalsImport(
      functionPath,
      object.node.name,
      allowBarrel ? undefined : importSource,
    )
  );
}

function isRenderCallback(path: NodePath<t.Function>): boolean {
  const parent = path.parentPath;
  if (!parent.isCallExpression() || isKnownComponentWrapper(parent)) return false;
  return parent.get("arguments").some((argument) => argument.node === path.node);
}

function isAutomaticTransformCandidate(path: NodePath<t.Function>): boolean {
  // Render callbacks are tracked by the component that invokes them. Injecting
  // a hook into the callback would violate the Rules of Hooks because callbacks
  // such as Array#map can execute a variable number of times.
  if (isRenderCallback(path)) return false;
  if (path.isFunctionDeclaration()) return true;

  let parent = path.parentPath;
  while (parent.isCallExpression() && isKnownComponentWrapper(parent)) {
    parent = parent.parentPath;
  }
  return (
    parent.isVariableDeclarator() ||
    parent.isReturnStatement() ||
    parent.isExportDefaultDeclaration()
  );
}

function isNestedTrackingBoundary(path: NodePath<t.Function>): boolean {
  return (
    !isRenderCallback(path) &&
    (isComponent(path) || isCustomHook(path))
  );
}

function inspectFunction(
  functionPath: NodePath<t.Function>,
  importSource: string,
): FunctionInspection {
  const inspection: FunctionInspection = {
    containsJSX: false,
    readsValue: false,
    hasUseSignalsCall: false,
  };
  functionPath.traverse({
    Function(path) {
      // Components and hooks own their subscriptions. Other nested callbacks
      // remain part of the current render owner so hidden JSX/.value reads in a
      // map/render-prop still cause the owner component to be transformed.
      if (isNestedTrackingBoundary(path)) path.skip();
    },
    JSXElement(_path) {
      inspection.containsJSX = true;
    },
    JSXFragment(_path) {
      inspection.containsJSX = true;
    },
    MemberExpression(path) {
      const property = path.node.property;
      if (
        (!path.node.computed && t.isIdentifier(property, { name: "value" })) ||
        (path.node.computed && t.isStringLiteral(property, { value: "value" }))
      ) {
        inspection.readsValue = true;
      }
    },
    OptionalMemberExpression(path) {
      const property = path.node.property;
      if (
        (!path.node.computed && t.isIdentifier(property, { name: "value" })) ||
        (path.node.computed && t.isStringLiteral(property, { value: "value" }))
      ) {
        inspection.readsValue = true;
      }
    },
    CallExpression(path) {
      if (path.getFunctionParent() !== functionPath) return;
      const callee = path.get("callee");
      if (isUseSignalsCallee(functionPath, callee, importSource)) {
        inspection.hasUseSignalsCall = true;
      }
    },
  });
  return inspection;
}

function findRuntimeImports(
  programPath: NodePath<t.Program>,
  runtimeSource: string,
): RuntimeImport[] {
  const imports: RuntimeImport[] = [];
  for (const statement of programPath.get("body")) {
    if (
      !statement.isImportDeclaration() ||
      statement.node.importKind === "type" ||
      statement.node.source.value !== runtimeSource
    ) {
      continue;
    }
    for (const specifier of statement.get("specifiers")) {
      if (
        specifier.isImportSpecifier() &&
        specifier.node.importKind !== "type" &&
        t.isIdentifier(specifier.node.imported, { name: "useSignals" })
      ) {
        imports.push({
          identifier: t.cloneNode(specifier.node.local),
          bindingPath: specifier,
        });
      }
    }
  }
  return imports;
}

function addRuntimeImport(
  programPath: NodePath<t.Program>,
  runtimeSource: string,
  functionPath: NodePath<t.Function>,
): RuntimeImport {
  const local = functionPath.scope.generateUidIdentifier("useSignals");
  const declaration = t.importDeclaration(
    [t.importSpecifier(t.cloneNode(local), t.identifier("useSignals"))],
    t.stringLiteral(runtimeSource),
  );
  const imports = programPath.get("body").filter((path) => path.isImportDeclaration());
  const insertedPaths = imports.length === 0
    ? programPath.unshiftContainer("body", declaration)
    : imports.at(-1)!.insertAfter(declaration);
  const inserted = insertedPaths[0];
  if (inserted === undefined || !inserted.isImportDeclaration()) {
    throw new Error("Failed to insert the useSignals import");
  }
  programPath.scope.registerDeclaration(inserted);
  const specifier = inserted.get("specifiers")[0];
  if (specifier === undefined || !specifier.isImportSpecifier()) {
    throw new Error("Failed to register the useSignals import");
  }
  return { identifier: local, bindingPath: specifier };
}

function isExplicitUseSignals(
  functionPath: NodePath<t.Function>,
  statements: NodePath<t.Statement>[],
  importSource: string,
): boolean {
  const first = statements[0];
  if (first === undefined || !first.isExpressionStatement()) return false;
  const expression = first.get("expression");
  if (!expression.isCallExpression() || expression.node.arguments.length !== 0) return false;
  const callee = expression.get("callee");
  return isUseSignalsCallee(functionPath, callee, importSource, false);
}

function shouldAutomaticallyTransform(
  mode: ReactAlienSignalsMode,
  functionPath: NodePath<t.Function>,
  inspection: FunctionInspection,
): boolean {
  if (isCustomHook(functionPath)) return mode !== "manual" && inspection.readsValue;
  if (!isComponent(functionPath) || !inspection.containsJSX) return false;
  return mode === "all" || (mode === "auto" && inspection.readsValue);
}

const babelTransform = declare<InternalTransformOptions>((api, options) => {
  api.assertVersion(7);
  const managedRuntimeSource = `${options.importSource}/runtime`;
  let programPath: NodePath<t.Program>;
  let managedRuntimeImports: RuntimeImport[];
  let directImports: RuntimeImport[];

  const plugin: PluginObj = {
    name: "unplugin-react-alien-signals",
    visitor: {
      Program: {
        enter(path, state) {
          programPath = path;
          managedRuntimeImports = findRuntimeImports(path, managedRuntimeSource);
          directImports = findRuntimeImports(path, options.importSource);
          (state.file.metadata as Record<string, unknown>)[transformedMetadataKey] = false;
        },
      },
      Function(path, state) {
        if (hasOwnedLeadingComment(path, noUseSignalsComment)) return;

        const body = path.get("body");
        const statements = body.isBlockStatement() ? body.get("body") : [];
        const explicit = isExplicitUseSignals(path, statements, options.importSource);
        const inspection = inspectFunction(path, options.importSource);
        const annotated =
          hasOwnedLeadingComment(path, useSignalsComment) &&
          (isComponent(path) || isCustomHook(path));
        const automatic =
          isAutomaticTransformCandidate(path) &&
          shouldAutomaticallyTransform(options.mode, path, inspection);
        if (!explicit && !annotated && !automatic) return;
        if (!explicit && inspection.hasUseSignalsCall) return;
        if (options.transform === "inject" && explicit) {
          // Nothing to inject, but the author's own call still makes this
          // function render-tracking, so it needs the memoization opt-out.
          if (
            options.reactCompiler === "auto" &&
            body.isBlockStatement() &&
            addNoMemoDirective(body.node)
          ) {
            (state.file.metadata as Record<string, unknown>)[transformedMetadataKey] = true;
          }
          return;
        }
        if (path.node.async || path.node.generator) {
          if (!explicit && !annotated) return;
          throw path.buildCodeFrameError(
            "useSignals transform only supports synchronous, non-generator functions",
          );
        }

        const importSource = options.transform === "managed"
          ? managedRuntimeSource
          : options.importSource;
        const imports = options.transform === "managed" ? managedRuntimeImports : directImports;
        let runtimeImport = imports.find(({ identifier, bindingPath }) =>
          path.scope.getBinding(identifier.name)?.path === bindingPath
        );
        if (runtimeImport === undefined) {
          runtimeImport = addRuntimeImport(programPath, importSource, path);
          imports.push(runtimeImport);
        }

        if (options.transform === "inject") {
          const call = t.expressionStatement(
            t.callExpression(t.cloneNode(runtimeImport.identifier), []),
          );
          if (body.isBlockStatement()) {
            body.unshiftContainer("body", call);
          } else {
            body.replaceWith(
              t.blockStatement([
                call,
                t.returnStatement(body.node as t.Expression),
              ]),
            );
          }
          const injectedBody = path.node.body;
          if (options.reactCompiler === "auto" && t.isBlockStatement(injectedBody)) {
            addNoMemoDirective(injectedBody);
          }
          path.scope.crawl();
          (state.file.metadata as Record<string, unknown>)[transformedMetadataKey] = true;
          return;
        }

        const store = path.scope.generateUidIdentifier("signals");
        const declaration = t.variableDeclaration("const", [
          t.variableDeclarator(
            t.cloneNode(store),
            t.callExpression(t.cloneNode(runtimeImport.identifier), []),
          ),
        ]);
        const first = statements[0];
        if (explicit && first !== undefined) t.inheritsComments(declaration, first.node);
        const originalStatements = body.isBlockStatement()
          ? statements.slice(explicit ? 1 : 0).map((statement) => statement.node)
          : [t.returnStatement(body.node as t.Expression)];
        const transformedBody = t.blockStatement([
          declaration,
          t.tryStatement(
            t.blockStatement(originalStatements),
            null,
            t.blockStatement([
              t.expressionStatement(
                t.callExpression(
                  t.memberExpression(t.cloneNode(store), t.identifier("f")),
                  [],
                ),
              ),
            ]),
          ),
        ]);
        if (body.isBlockStatement()) transformedBody.directives = body.node.directives;
        if (options.reactCompiler === "auto") addNoMemoDirective(transformedBody);
        body.replaceWith(transformedBody);
        path.scope.crawl();
        (state.file.metadata as Record<string, unknown>)[transformedMetadataKey] = true;
      },
    },
  };
  return plugin;
});

/** Runs the private Babel transform for the universal bundler adapter. */
export function transformReactAlienSignals(
  code: string,
  id: string,
  options: InternalTransformOptions,
): InternalTransformResult | null {
  const cleanId = id.replace(/[?#].*$/, "");
  const isTypeScript = /\.[cm]?tsx?$/i.test(cleanId);
  // JavaScript commonly carries JSX without using a .jsx suffix, while
  // TypeScript's angle-bracket assertions make JSX parsing unsafe for .ts.
  const supportsJsx = /\.[cm]?(?:jsx?|tsx)$/i.test(cleanId);
  const parserPlugins: NonNullable<ParserOptions["plugins"]> = [];
  if (supportsJsx) parserPlugins.push("jsx");
  if (isTypeScript) parserPlugins.push("typescript");
  parserPlugins.push("decorators-legacy");
  const result = transformSync(code, {
    babelrc: false,
    configFile: false,
    filename: id,
    parserOpts: { plugins: parserPlugins },
    plugins: [[babelTransform, options]],
    sourceMaps: true,
  });
  if (
    result === null ||
    typeof result.code !== "string" ||
    (result.metadata as Record<string, unknown> | undefined)?.[transformedMetadataKey] !== true
  ) {
    return null;
  }
  return { code: result.code, map: result.map };
}
