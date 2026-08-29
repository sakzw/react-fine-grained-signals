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
  /**
   * Additional module specifier whose `memo`/`forwardRef` exports count as
   * React's own, for codebases that import them through one internal
   * re-export module. Detection is additive: `"react"` itself always counts
   * regardless of this value.
   */
  reactImportSource: string;
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

// A single-file transform cannot follow a re-export chain, so a codebase that
// imports React's wrappers through an internal barrel names that module with
// `reactImportSource`. The check stays additive: a direct `"react"` import is
// unambiguously React's wrapper, so configuring a barrel widens detection
// rather than moving it, and never silently drops a direct import.
function isReactSource(source: string, reactImportSource: string): boolean {
  return source === reactPackageSource || source === reactImportSource;
}

/** Is `name` bound by `import { memo } from "react"` (or `forwardRef`, possibly aliased)? */
function isReactNamedImport(
  path: NodePath,
  name: string,
  importedName: "memo" | "forwardRef",
  reactImportSource: string,
): boolean {
  const binding = path.scope.getBinding(name);
  if (binding === undefined || !binding.path.isImportSpecifier()) return false;
  if (binding.path.node.importKind === "type") return false;
  if (!t.isIdentifier(binding.path.node.imported, { name: importedName })) return false;
  const declaration = binding.path.parentPath;
  return (
    declaration.isImportDeclaration() &&
    declaration.node.importKind !== "type" &&
    isReactSource(declaration.node.source.value, reactImportSource)
  );
}

/** Is `name` bound by `import * as React from "react"` or `import React from "react"`? */
function isReactDefaultOrNamespaceImport(
  path: NodePath,
  name: string,
  reactImportSource: string,
): boolean {
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
    isReactSource(declaration.node.source.value, reactImportSource)
  );
}

// A bare `memo`/`forwardRef` name (or `X.memo`/`X.forwardRef`) only counts as
// React's wrapper when it actually resolves back to an import from "react".
// Otherwise a same-named local helper (e.g. a homemade memoization cache)
// could be mistaken for it and have a `useSignals()` hook injected into a
// function that is never actually rendered by React, which throws at runtime.
function isKnownComponentWrapper(
  path: NodePath<t.CallExpression>,
  reactImportSource: string,
): boolean {
  const callee = path.get("callee");
  if (callee.isIdentifier()) {
    const name = callee.node.name;
    return (
      isReactNamedImport(path, name, "memo", reactImportSource) ||
      isReactNamedImport(path, name, "forwardRef", reactImportSource)
    );
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
  return (
    object.isIdentifier() &&
    isReactDefaultOrNamespaceImport(path, object.node.name, reactImportSource)
  );
}

function getFunctionName(
  path: NodePath<t.Function>,
  reactImportSource: string,
): string | undefined {
  let parent = path.parentPath;
  while (parent.isCallExpression() && isKnownComponentWrapper(parent, reactImportSource)) {
    parent = parent.parentPath;
  }
  // The enclosing binding -- reached through zero or more memo()/forwardRef()
  // wrappers -- is the function's real identity and always wins. A function
  // expression's own name is conventionally only a stack-trace/devtools label
  // and may legitimately differ from what it is bound to, in either direction:
  // `const Counter = function render() {}` is a component and
  // `const helper = function Counter() {}` is not.
  if (parent.isVariableDeclarator() && t.isIdentifier(parent.node.id)) {
    return parent.node.id.name;
  }
  if (
    (path.isFunctionDeclaration() || path.isFunctionExpression()) &&
    path.node.id !== null &&
    path.node.id !== undefined
  ) {
    return path.node.id.name;
  }
  return undefined;
}

function isComponent(path: NodePath<t.Function>, reactImportSource: string): boolean {
  const name = getFunctionName(path, reactImportSource);
  return name !== undefined && /^[A-Z]/.test(name);
}

function isCustomHook(path: NodePath<t.Function>, reactImportSource: string): boolean {
  const name = getFunctionName(path, reactImportSource);
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

// A callback handed to one of these array iteration methods runs synchronously,
// a variable number of times, inside a single render of the function that calls
// it -- exactly what the Rules of Hooks forbid injecting a hook into.
//
// The set is deliberately minimal. `map` and `flatMap` build an element per
// item and `forEach` pushes elements into an accumulator, so these are the
// calls whose callbacks are routinely factored out under a PascalCase name
// (`Row`, `Item`) that would otherwise look exactly like an independent
// component. The predicate/accumulator methods (`filter`, `reduce`, `some`,
// `every`, `find`) are left out on purpose: their callbacks are lowercase
// helpers that return booleans or accumulators, so they never qualify as a
// component or a `useX` hook and are never transform candidates in the first
// place -- including them would buy nothing while widening the chance of
// matching an unrelated user-defined method with the same name. That direction
// of error is the expensive one: a false positive silently denies a real
// component its subscription, which shows up as a stale UI rather than a crash.
const renderCallbackMethods = new Set(["map", "flatMap", "forEach"]);

// TypeScript-only wrappers that restate a value's type without changing the
// value. `Row!`, `Row as Fn`, `Row satisfies Fn`, `Row<Item>` and -- in a `.ts`
// module, where angle brackets are not JSX -- `<Fn>Row` all erase to the very
// same `Row`, so every one of them hands the same function to `items.map(...)`
// at runtime. Detection has to see through them or the callback keeps a hook
// the Rules of Hooks forbid, and they nest freely (`Row! as typeof Row`).
//
// The membership rule is exactly "erases to its own `.expression`", which is
// what makes unwrapping sound: nothing else about the node survives to
// runtime. Type arguments on the call itself (`items.map<Item>(Row)`) are not
// in this family and need no handling -- they are a field of the call node,
// not a wrapper around it.
type TransparentWrapper =
  | t.TSNonNullExpression
  | t.TSAsExpression
  | t.TSSatisfiesExpression
  | t.TSTypeAssertion
  | t.TSInstantiationExpression;

function isTransparentWrapper(node: t.Node): node is TransparentWrapper {
  return (
    t.isTSNonNullExpression(node) ||
    t.isTSAsExpression(node) ||
    t.isTSSatisfiesExpression(node) ||
    t.isTSTypeAssertion(node) ||
    t.isTSInstantiationExpression(node)
  );
}

/** The value-level node behind any chain of transparent TypeScript wrappers. */
function unwrapTransparent(node: t.Node): t.Node {
  let current = node;
  while (isTransparentWrapper(current)) current = current.expression;
  return current;
}

/**
 * The path of the syntactic slot `path` really occupies. A reference wrapped in
 * `Row!` or `Row as Fn` sits one or more nodes below the argument list it is
 * actually part of, so climbing past those wrappers is what makes the enclosing
 * call -- and the node that genuinely sits in its argument list -- visible.
 */
function climbTransparentWrappers(path: NodePath): NodePath {
  let current = path;
  for (
    let parent = current.parentPath;
    parent !== null && isTransparentWrapper(parent.node) && parent.node.expression === current.node;
    parent = current.parentPath
  ) {
    current = parent;
  }
  return current;
}

/** The callee and arguments of a plain or optional-chained call. */
function getCallParts(node: t.Node): { callee: t.Node; arguments: t.Node[] } | undefined {
  if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
    return { callee: node.callee, arguments: node.arguments };
  }
  return undefined;
}

/**
 * Is `callee` a member access naming one of the known iteration methods
 * (`items.map`, `items?.flatMap`, `items["forEach"]`)? The object's runtime
 * type cannot be known statically, so this stays a heuristic on the method
 * name -- but a targeted one. `memo`/`forwardRef` can never match it: a bare
 * `memo(Row)` has an identifier callee, and `React.memo(Row)` names a property
 * that is not in the set, so React's wrappers keep their wrapped component
 * eligible for the transform without needing a special case here.
 */
function isRenderCallbackCallee(callee: t.Node): boolean {
  // `items.map!(Row)` puts a non-null assertion between the call and the member
  // access it invokes, which erases to the same `items.map`.
  const node = unwrapTransparent(callee);
  const member = t.isMemberExpression(node) || t.isOptionalMemberExpression(node)
    ? node
    : undefined;
  if (member === undefined) return false;
  const property = member.property;
  return member.computed
    ? t.isStringLiteral(property) && renderCallbackMethods.has(property.value)
    : t.isIdentifier(property) && renderCallbackMethods.has(property.name);
}

/**
 * The single notion of "this reference means the function runs synchronously,
 * repeatedly, as part of the caller's render": `callback` is *the* callback
 * argument of a call to a known array iteration method. Both the render-callback
 * exclusion and the read propagation in `inspectFunction` ask this same
 * question, so they cannot drift apart.
 *
 * `map`, `flatMap` and `forEach` all have the signature `(callbackFn, thisArg?)`,
 * so only argument 0 is ever invoked. Accepting any position would read the
 * `thisArg` of `items.map(String, Row)` as a render callback and strip `Row` --
 * a component this call never invokes at all -- of its own subscription, leaving
 * it stale on every later signal write.
 *
 * `callback` is matched against the node that literally sits in the argument
 * list, wrappers included, so a caller holding `Row!` compares equal while a
 * caller holding the inner `Row` does not; use `climbTransparentWrappers` to
 * reach the former from the latter.
 */
function isRenderCallbackInvocation(call: t.Node, callback: t.Node): boolean {
  const parts = getCallParts(call);
  if (parts === undefined || !isRenderCallbackCallee(parts.callee)) return false;
  return parts.arguments[0] === callback;
}

/** The name other statements can reach this function's own binding by. */
function getBindingName(path: NodePath<t.Function>): string | undefined {
  if (path.isFunctionDeclaration() && path.node.id !== null && path.node.id !== undefined) {
    return path.node.id.name;
  }
  const parent = path.parentPath;
  if (parent !== null && parent.isVariableDeclarator() && t.isIdentifier(parent.node.id)) {
    return parent.node.id.name;
  }
  return undefined;
}

// A function handed to an array iteration method runs a variable number of
// times inside one render of its owner, so a hook injected into it would break
// hook order. Both the inline definition site and a callback factored out into
// its own binding and passed by reference later count, whether that binding is
// a `const` (`const Row = ...; items.map(Row)`) or a function declaration
// (`function Row() {}; items.map(Row)`). Tracing deliberately stops at that one
// binding: a re-assigned alias (`const RowAlias = Row; items.map(RowAlias)`) is
// not followed.
//
// Both branches ask about the argument slot rather than the bare node, because
// a transparent TypeScript wrapper -- `items.map(Row!)`, or an inline
// `items.map(((item) => <li />) as Fn)` -- stands between the two.
function isRenderCallback(path: NodePath<t.Function>): boolean {
  const argument = climbTransparentWrappers(path);
  const enclosing = argument.parentPath;
  if (enclosing !== null && isRenderCallbackInvocation(enclosing.node, argument.node)) return true;

  const parent = path.parentPath;
  const name = getBindingName(path);
  if (name === undefined || parent === null) return false;
  const binding = parent.scope.getBinding(name);
  if (binding === undefined) return false;
  // Only this function's own binding may speak for it, so a same-named binding
  // from an outer scope cannot disqualify an unrelated function.
  if (binding.path.node !== path.node && binding.path.node !== parent.node) return false;
  return binding.referencePaths.some((reference) => {
    const slot = climbTransparentWrappers(reference);
    return (
      slot.parentPath !== null && isRenderCallbackInvocation(slot.parentPath.node, slot.node)
    );
  });
}

/** The function `name`, referenced from `origin`'s scope, is bound to. */
function resolveReferencedFunction(
  origin: NodePath,
  name: string,
): NodePath<t.Function> | undefined {
  const binding = origin.scope.getBinding(name);
  if (binding === undefined) return undefined;
  const bindingPath = binding.path;
  if (bindingPath.isFunctionDeclaration()) return bindingPath;
  if (bindingPath.isVariableDeclarator()) {
    const init = bindingPath.get("init");
    if (init.isArrowFunctionExpression() || init.isFunctionExpression()) return init;
  }
  // An imported callback lives in another module, which a single-file
  // transform cannot follow.
  return undefined;
}

function isAutomaticTransformCandidate(
  path: NodePath<t.Function>,
  reactImportSource: string,
): boolean {
  // Render callbacks are tracked by the component that invokes them. Injecting
  // a hook into the callback would violate the Rules of Hooks because callbacks
  // such as Array#map can execute a variable number of times.
  if (isRenderCallback(path)) return false;
  if (path.isFunctionDeclaration()) return true;

  let parent = path.parentPath;
  while (parent.isCallExpression() && isKnownComponentWrapper(parent, reactImportSource)) {
    parent = parent.parentPath;
  }
  return (
    parent.isVariableDeclarator() ||
    parent.isReturnStatement() ||
    parent.isExportDefaultDeclaration()
  );
}

// A nested function is skipped only when it will own its subscription, which
// is exactly when it is a component or hook the transform can target. A named
// function the transform cannot target -- a render callback, or one in a
// position that is never a candidate, such as a bare call argument or a JSX
// attribute value -- stays part of the current render owner, so its JSX and
// `.value` reads still cause that owner to be transformed.
function isNestedTrackingBoundary(
  path: NodePath<t.Function>,
  reactImportSource: string,
): boolean {
  return (
    isAutomaticTransformCandidate(path, reactImportSource) &&
    (isComponent(path, reactImportSource) || isCustomHook(path, reactImportSource))
  );
}

function inspectFunction(
  functionPath: NodePath<t.Function>,
  importSource: string,
  reactImportSource: string,
  // Guards the render-callback recursion below against reference cycles
  // (mutually referencing helpers) and re-inspecting the same body twice.
  visited: Set<t.Node> = new Set([functionPath.node]),
): FunctionInspection {
  const inspection: FunctionInspection = {
    containsJSX: false,
    readsValue: false,
    hasUseSignalsCall: false,
  };

  // A render callback defined elsewhere in the module runs inside this
  // function's render, but its body is not inside the AST being walked, so its
  // reads have to be folded in explicitly. Without this, the component that
  // owns the only subscription point sees no `.value` read at all and is left
  // untransformed while the excluded callback is left untransformed too, and
  // nothing subscribes.
  const foldReferencedRenderCallbacks = (
    call: NodePath<t.CallExpression> | NodePath<t.OptionalCallExpression>,
  ): void => {
    for (const argument of call.node.arguments) {
      // The wrapper node is what occupies the argument slot, so the position
      // check compares against `argument` itself; only the name has to be read
      // from underneath a `Row!` / `Row as Fn` / `Row satisfies Fn` wrapper.
      const reference = unwrapTransparent(argument);
      if (!t.isIdentifier(reference)) continue;
      if (!isRenderCallbackInvocation(call.node, argument)) continue;
      const target = resolveReferencedFunction(call, reference.name);
      // A callback defined inside this function is already part of the walk.
      if (target === undefined || target.isDescendant(functionPath)) continue;
      if (visited.has(target.node)) continue;
      visited.add(target.node);
      const nested = inspectFunction(target, importSource, reactImportSource, visited);
      if (nested.containsJSX) inspection.containsJSX = true;
      if (nested.readsValue) inspection.readsValue = true;
    }
  };

  functionPath.traverse({
    Function(path) {
      // Components and hooks own their subscriptions. Other nested callbacks
      // remain part of the current render owner so hidden JSX/.value reads in a
      // map/render-prop still cause the owner component to be transformed.
      if (isNestedTrackingBoundary(path, reactImportSource)) path.skip();
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
      foldReferencedRenderCallbacks(path);
      if (path.getFunctionParent() !== functionPath) return;
      const callee = path.get("callee");
      if (isUseSignalsCallee(functionPath, callee, importSource)) {
        inspection.hasUseSignalsCall = true;
      }
    },
    OptionalCallExpression(path) {
      foldReferencedRenderCallbacks(path);
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
  reactImportSource: string,
): boolean {
  if (isCustomHook(functionPath, reactImportSource)) {
    return mode !== "manual" && inspection.readsValue;
  }
  if (!isComponent(functionPath, reactImportSource) || !inspection.containsJSX) return false;
  return mode === "all" || (mode === "auto" && inspection.readsValue);
}

const babelTransform = declare<InternalTransformOptions>((api, options) => {
  api.assertVersion(7);
  const managedRuntimeSource = `${options.importSource}/runtime`;
  const reactImportSource = options.reactImportSource;
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
        const inspection = inspectFunction(path, options.importSource, reactImportSource);
        const annotated =
          hasOwnedLeadingComment(path, useSignalsComment) &&
          (isComponent(path, reactImportSource) || isCustomHook(path, reactImportSource));
        const automatic =
          isAutomaticTransformCandidate(path, reactImportSource) &&
          shouldAutomaticallyTransform(options.mode, path, inspection, reactImportSource);
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
