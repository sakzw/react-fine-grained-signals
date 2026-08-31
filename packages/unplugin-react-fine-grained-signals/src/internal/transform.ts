import { declare } from "@babel/helper-plugin-utils";
import {
  transformSync,
  type InputOptions,
  type NodePath,
  type PluginItem,
  type PluginObject,
  type PluginPass,
} from "@babel/core";
import * as t from "@babel/types";
import type { TransformResult } from "unplugin";

export type ReactFineGrainedSignalsMode = "manual" | "auto" | "all";
export type ReactFineGrainedSignalsTransform = "inject" | "managed";
export type ReactFineGrainedSignalsReactCompiler = "auto" | "off";

export interface InternalTransformOptions {
  importSource: string;
  mode: ReactFineGrainedSignalsMode;
  transform: ReactFineGrainedSignalsTransform;
  reactCompiler: ReactFineGrainedSignalsReactCompiler;
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

// The per-file working state the transform builds up in `Program.enter` and
// reads in every `Function` visit. This lives on Babel's own `PluginPass`
// (one fresh instance per file) rather than in a closure over the plugin
// factory, so two files processed through the same plugin instance -- Babel
// may reuse one instantiation across `transformSync` calls -- never share
// mutable state through it.
interface PluginState extends PluginPass {
  programPath: NodePath<t.Program>;
  managedRuntimeImports: RuntimeImport[];
  directImports: RuntimeImport[];
  /**
   * Import specifiers whose only use was an explicit `useSignals()` call the
   * managed transform absorbed into its own store declaration. They are
   * re-checked in `Program.exit` and dropped if nothing else references them,
   * so absorbing the call does not leave a dead import pulling the non-runtime
   * entry point into the bundle graph.
   */
  absorbedImports: NodePath<t.ImportSpecifier>[];
}

interface FunctionInspection {
  containsJSX: boolean;
  readsValue: boolean;
  hasUseSignalsCall: boolean;
}

const useSignalsComment = /(^|\s)@useSignals(\s|$)/;
const noUseSignalsComment = /(^|\s)@noUseSignals(\s|$)/;
const transformedMetadataKey = "reactFineGrainedSignalsTransformed";

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

interface ResolvedImportBinding {
  /** The specifier node the name binds to -- named, default, or namespace. */
  specifier: NodePath<t.ImportSpecifier | t.ImportDefaultSpecifier | t.ImportNamespaceSpecifier>;
  /** The `from "..."` string of the declaration that specifier belongs to. */
  source: string;
}

/**
 * Resolves `name` back to the import specifier and source module it is bound
 * to, or `undefined` if `name` isn't bound by a value-level import at all
 * (not imported, a type-only specifier, or a type-only declaration).
 *
 * Every import-recognition predicate in this file -- React's `memo`/
 * `forwardRef` wrappers, a default-or-namespace React import, a named or
 * namespace `useSignals` import -- reduces to "does this resolved binding
 * have the right specifier kind and source", so they all build on this one
 * binding walk instead of each repeating
 * `getBinding` -> specifier-kind -> `importKind` -> parent-declaration.
 */
function resolveImportedBinding(path: NodePath, name: string): ResolvedImportBinding | undefined {
  const binding = path.scope.getBinding(name);
  if (binding === undefined) return undefined;
  const specifier = binding.path;
  if (
    !specifier.isImportSpecifier() &&
    !specifier.isImportDefaultSpecifier() &&
    !specifier.isImportNamespaceSpecifier()
  ) {
    return undefined;
  }
  // Only a named specifier can itself be marked `type` (`import { type X }`);
  // a default or namespace specifier has no `importKind` field of its own.
  if (specifier.isImportSpecifier() && specifier.node.importKind === "type") return undefined;
  const declaration = specifier.parentPath;
  if (!declaration.isImportDeclaration() || declaration.node.importKind === "type") {
    return undefined;
  }
  return { specifier, source: declaration.node.source.value };
}

/** Is `name` bound by `import { memo } from "react"` (or `forwardRef`, possibly aliased)? */
function isReactNamedImport(
  path: NodePath,
  name: string,
  importedName: "memo" | "forwardRef",
  reactImportSource: string,
): boolean {
  const resolved = resolveImportedBinding(path, name);
  if (resolved === undefined || !resolved.specifier.isImportSpecifier()) return false;
  return (
    t.isIdentifier(resolved.specifier.node.imported, { name: importedName }) &&
    isReactSource(resolved.source, reactImportSource)
  );
}

/** Is `name` bound by `import * as React from "react"` or `import React from "react"`? */
function isReactDefaultOrNamespaceImport(
  path: NodePath,
  name: string,
  reactImportSource: string,
): boolean {
  const resolved = resolveImportedBinding(path, name);
  return (
    resolved !== undefined &&
    (resolved.specifier.isImportNamespaceSpecifier() || resolved.specifier.isImportDefaultSpecifier()) &&
    isReactSource(resolved.source, reactImportSource)
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
  const propertyName = getReadPropertyName(callee.node);
  if (propertyName !== "memo" && propertyName !== "forwardRef") return false;
  const object = callee.get("object");
  return (
    object.isIdentifier() &&
    isReactDefaultOrNamespaceImport(path, object.node.name, reactImportSource)
  );
}

/**
 * The static name of an object property's or class field's key. A computed key
 * is only readable when it is a string literal (`{ ["Home"]: ... }`), exactly as
 * `getReadPropertyName` reads `items["map"]`; anything else is decided at
 * runtime and stays unnamed, which leaves the function untransformed.
 */
function getPropertyKeyName(node: t.ObjectProperty | t.ClassProperty): string | undefined {
  const key = unwrapTransparent(node.key);
  if (node.computed) return t.isStringLiteral(key) ? key.value : undefined;
  if (t.isIdentifier(key)) return key.name;
  return t.isStringLiteral(key) ? key.value : undefined;
}

/**
 * The component/hook name a function held in a *keyed slot* takes from its key:
 *
 * ```js
 * Card.Header = () => <h1>{count.value}</h1>;          // a compound component
 * export const ns = { Home: () => <p>{count.value}</p> };  // an object namespace
 * class Holder { Row = () => <li>{count.value}</li>; }     // a class field
 * ```
 *
 * All three are ordinary ways to hold a component that no *binding* names, so
 * without this they resolved to no identity at all and `auto` mode passed over
 * them in silence. The key is the name the rest of the module reaches them by
 * (`<ns.Home />`, `<Card.Header />`), which is precisely what the PascalCase /
 * `useX` conventions are asked to classify -- so a lowercase key (`{ render:
 * ... }`, `obj.onClick = ...`) resolves to a lowercase identity and is filtered
 * out by those same conventions, exactly as a lowercase binding is.
 *
 * Reading the key *before* the function's own `id` is the same precedence the
 * enclosing binding already takes: `Card.onSelect = function Row() {}` is a
 * handler named for debugging, not a component, and the slot it was put in says
 * so more reliably than the label it carries.
 *
 * An identifier-target assignment (`Row = (props) => ...` after a separate
 * `let Row`) is deliberately not named here: the declaration is the binding, and
 * routing it through this would give a re-assignment the same authority as a
 * declaration. It keeps resolving through `getBindingIdentityName`'s own
 * branches exactly as before.
 *
 * An assignment target is required to root in a plain identifier
 * (`getStaticMemberPath`), which is what excludes `this.Row = ...` in a class
 * component's constructor. That shape is genuinely ambiguous here: it is just as
 * often a per-item row renderer invoked through `this.props.items.map(this.Row)`
 * as it is a component, and `this` is not a binding, so the reference walk that
 * disqualifies every other keyed slot (`isKeyedRenderCallback`) cannot see those
 * uses at all -- there would be no way to take the boundary back once given. So
 * the ambiguous case resolves the way this file always resolves one: name
 * nothing, transform nothing. Class components stay a manual `useSignals()` /
 * `@useSignals` opt-in.
 */
function getKeyedIdentityName(parent: NodePath): string | undefined {
  if (parent.isAssignmentExpression()) {
    const left = parent.node.left;
    if (!t.isMemberExpression(left)) return undefined;
    return getStaticMemberPath(left)?.keys.at(-1);
  }
  if (parent.isObjectProperty() || parent.isClassProperty()) {
    return getPropertyKeyName(parent.node);
  }
  return undefined;
}

/**
 * A member expression read as a root binding plus the chain of static keys
 * taken from it: `a.b.Row` gives `a` / `["b", "Row"]`. Every link has to be a
 * statically readable key and the innermost object a plain identifier, so a
 * computed runtime key (`a[k].Row`) and a `this`-rooted path (`this.Row`) both
 * yield nothing rather than a partial answer.
 *
 * The chain, rather than just the last key, is what lets `isKeyedRenderCallback`
 * match a use site against the definition site: a one-level walk saw
 * `const a = { b: { Row } }` handed to `items.map(a.b.Row)` as an unrelated
 * reference and let the per-item callback keep a hook boundary of its own.
 */
function getStaticMemberPath(node: t.MemberExpression): { root: string; keys: string[] } | undefined {
  const keys: string[] = [];
  let current: t.Node = node;
  while (t.isMemberExpression(current)) {
    const key = getReadPropertyName(current);
    if (key === undefined) return undefined;
    keys.unshift(key);
    current = current.object;
  }
  return t.isIdentifier(current) ? { root: current.name, keys } : undefined;
}

// Named `getBindingIdentityName` -- not `getBindingName` -- to keep it
// visually distinct from its twin below, `getOwnBindingName`: the two answer
// different questions (what is this function's public component/hook
// identity, vs. what name can other code in this module reach this exact
// function by) and were each the subject of a separate past regression, so a
// future edit must not casually merge their logic back together.
function getBindingIdentityName(
  path: NodePath<t.Function>,
  reactImportSource: string,
  // `climbComponentWrappers(path, reactImportSource).parentPath`, when a
  // caller already walked it for this same `path` and wants to hand it in
  // rather than have this function re-walk from scratch. `decideTransform`
  // and `isNestedTrackingBoundary` each evaluate a single function against
  // several of these predicates, so they compute the climb once and thread it
  // through; every other caller omits it and gets the walk done here as
  // before.
  climbedParent: NodePath | null = climbComponentWrappers(path, reactImportSource).parentPath,
): string | undefined {
  const parent = climbedParent;
  // The enclosing binding -- reached through zero or more memo()/forwardRef()
  // wrappers -- is the function's real identity and always wins. A function
  // expression's own name is conventionally only a stack-trace/devtools label
  // and may legitimately differ from what it is bound to, in either direction:
  // `const Counter = function render() {}` is a component and
  // `const helper = function Counter() {}` is not.
  if (parent !== null) {
    if (parent.isVariableDeclarator() && t.isIdentifier(parent.node.id)) {
      return parent.node.id.name;
    }
    // A keyed slot names its function for the same reason and with the same
    // authority as a binding does -- see `getKeyedIdentityName`.
    const keyed = getKeyedIdentityName(parent);
    if (keyed !== undefined) return keyed;
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

/** Does a name read as a React component -- PascalCase -- by convention? */
function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

/** Does a name read as a custom hook -- `useX` -- by convention? */
function isHookName(name: string): boolean {
  return /^use[A-Z]/.test(name);
}

/**
 * Does `path` render JSX *itself*, rather than merely containing some?
 *
 * Nested functions are skipped, because their JSX is their own output and not
 * this function's: `(Base) => (props) => <Base />` renders nothing at all, it
 * returns a function that does. That distinction is the whole difference
 * between a factory and a component here, so without it a factory of factories
 * would be mistaken for the component at the bottom of the chain and have a
 * hook injected into a function React never renders.
 *
 * The cost of the stricter reading is a component whose only JSX lives inside a
 * callback (`(props) => items.map((i) => <li />)`) -- it renders JSX, but not
 * itself. That direction is the safe one: it declines to derive an identity,
 * leaving behavior exactly as it was, rather than injecting an invalid hook.
 */
function rendersJsx(path: NodePath<t.Function>): boolean {
  let found = false;
  path.traverse({
    Function(nested) {
      nested.skip();
    },
    JSXElement(jsx) {
      found = true;
      jsx.stop();
    },
    JSXFragment(jsx) {
      found = true;
      jsx.stop();
    },
  });
  return found;
}

/**
 * Is `path` a higher-order component factory -- a function that *produces* a
 * component rather than being one, and that React itself therefore never
 * renders?
 *
 * The evidence is the parameter list. React calls a component with exactly one
 * props object, and a `forwardRef` render function with `(props, ref)`; neither
 * of those parameters is ever PascalCase, and a destructured one is a pattern
 * rather than a plain identifier. A PascalCase *identifier* parameter is
 * therefore a component being handed in, which only a factory receives. That is
 * the same naming convention this file already reads to classify `Counter` as a
 * component and `useCount` as a hook, applied one position further in -- not a
 * new kind of guess.
 *
 * The second half -- rendering no JSX of its own (`rendersJsx`, which looks past
 * nested functions) -- keeps a genuine component out no matter how its
 * parameters are spelled: a function that renders is a component.
 *
 * Two consequences follow, and together they are the whole policy for a
 * PascalCase factory such as
 * `export const WithCount = (Base) => (props) => <Base count={count.value} />`:
 *
 * - the factory is never transformed itself (`decideTransform` withholds both
 *   the automatic and the annotated route from it), and
 * - the function it returns inherits the factory's name (`getIdentityFactory`)
 *   exactly as a camelCase `withCount` factory's returned component already did.
 *
 * The first half is the load-bearing one. Without it the factory looked like an
 * ordinary component from every angle -- a PascalCase binding, and (because the
 * component it returns owned no identity, so `inspectFunction` never skipped it)
 * the returned component's JSX and `.value` reads credited to the factory's own
 * body. `auto` mode injected the boundary into the factory, `all` mode did so
 * with no `.value` read needed at all, and since `WithCount(Foo)` is normally
 * called at module scope the injected `useSignals()` ran with no React
 * dispatcher and threw at import time -- the unrecoverable direction this file
 * steers away from everywhere else.
 */
function isHigherOrderComponentFactory(path: NodePath<t.Function>): boolean {
  return (
    path.node.params.some((param) => {
      const name = getSimpleParameterName(param);
      return name !== undefined && isComponentName(name);
    }) && !rendersJsx(path)
  );
}

/**
 * The name a parameter binds, seen through a default value. `(Base)` and
 * `(Base = Fallback)` bind the very same `Base`, but a default makes the node an
 * `AssignmentPattern` wrapping the identifier rather than an identifier itself
 * -- so matching only `Identifier` let a defaulted parameter fall through and
 * put the factory straight back in front of the import-time crash
 * `isHigherOrderComponentFactory` exists to prevent.
 *
 * A destructured or rest parameter binds no single name and yields nothing,
 * which is what keeps a component's `({ Icon })` prop out.
 */
function getSimpleParameterName(param: t.Node): string | undefined {
  if (t.isIdentifier(param)) return param.name;
  if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) return param.left.name;
  return undefined;
}

/** The enclosing factory a returned component inherits its identity from. */
interface IdentityFactory {
  /** The enclosing function that returns the component. */
  path: NodePath<t.Function>;
  /** Its own binding name -- always a real binding, never itself derived. */
  name: string;
}

/**
 * The higher-order-component factory whose identity `path` inherits, when
 * `path` is the component that factory returns:
 *
 * ```js
 * export const withCount = (Base) => (props) => <Base count={count.value} />;
 * export function withCount(Base) { return (props) => <Base ... />; }
 * ```
 *
 * The inner function is the real component in both, but it has no name of its
 * own: its only identity comes from being what `withCount` returns. Left
 * unresolved it is not a component to `auto` mode and not an annotatable
 * function to `@useSignals`, so a signal write silently stops re-rendering it
 * -- no error, just a stale UI.
 *
 * Three things have to hold, tested cheapest-first:
 *
 * - `path` sits in a return position of the enclosing function: an explicit
 *   `return`, or an arrow's concise body, which returns just as literally.
 *   Missing the second is what made the concise form fail even when annotated.
 * - The enclosing function has a resolvable name that is not a hook name, and
 *   -- if it is a *component* name -- is a function `isHigherOrderComponentFactory`
 *   independently identifies as a factory. A function returned by a component or
 *   a hook is otherwise a render prop or a callback that runs inside that owner's
 *   render rather than an independently mounted component, and a hook boundary of
 *   its own would be an invalid hook call. Factories are camelCase by convention
 *   (`withCount`, `connect`, `observer`), so the plain name test reads as
 *   "returned from a plain factory"; the PascalCase escape hatch exists because
 *   `WithCount` is an equally common spelling of the very same thing, and there
 *   the convention alone was not merely unhelpful but actively harmful (see
 *   `isHigherOrderComponentFactory`).
 *
 *   A `useX` name gets no such escape hatch, deliberately. React calls a hook
 *   from inside a render that is already in progress, so anything the hook hands
 *   back is a closure the caller may invoke during that same render -- no
 *   structural evidence in this file can rule that out, and the safe reading of
 *   an ambiguous case is to leave the returned function unresolved rather than
 *   give it a boundary that would be an invalid hook call.
 * - `path` renders JSX itself (`rendersJsx`). A factory handing back a
 *   comparator, a reducer or any other plain closure returns no component and
 *   must not be swept up -- and neither must the middle link of a factory
 *   chain, whose JSX is all inside the function *it* returns.
 *
 * Only the immediately enclosing function is consulted, so the inherited name
 * is always a real module binding. A factory that returns a factory
 * (`(a) => (b) => (props) => <p />`) deliberately leaves the innermost
 * function unresolved rather than inventing a name for a middle function that
 * has none -- an `@useSignals` annotation there still warns
 * (`warnUnnamedUseSignalsAnnotation`) instead of silently doing nothing.
 */
function getIdentityFactory(
  path: NodePath<t.Function>,
  reactImportSource: string,
  climbedParent: NodePath | null,
): IdentityFactory | undefined {
  if (climbedParent === null) return undefined;
  let enclosing: NodePath<t.Function> | null;
  if (climbedParent.isArrowFunctionExpression()) {
    // The only slot of an arrow function a function can occupy is its concise
    // body: a parameter's default value sits under an `AssignmentPattern`.
    enclosing = climbedParent;
  } else if (climbedParent.isReturnStatement()) {
    enclosing = climbedParent.getFunctionParent();
  } else {
    return undefined;
  }
  if (enclosing === null) return undefined;
  const name = getBindingIdentityName(enclosing, reactImportSource);
  if (name === undefined || isHookName(name)) return undefined;
  if (!rendersJsx(path)) return undefined;
  if (isComponentName(name) && !isHigherOrderComponentFactory(enclosing)) return undefined;
  return { path: enclosing, name };
}

/**
 * A function's public component/hook identity, and where it came from:
 *
 * - `"binding"`: a name the module itself gives the function -- the enclosing
 *   binding, or the function's own `id`. The naming conventions classify it.
 * - `"hoc-return"`: the function is the component a factory returns and has no
 *   name of its own, so it inherits the factory's (see `getIdentityFactory`).
 *   The conventions cannot classify that name -- it is the factory's, camelCase
 *   by definition -- so the classification is structural instead: the identity
 *   only exists at all because the function renders JSX, which makes it a
 *   component and never a hook.
 */
type ComponentIdentity =
  | { kind: "binding"; name: string }
  | { kind: "hoc-return"; name: string; factory: NodePath<t.Function> };

function resolveComponentIdentity(
  path: NodePath<t.Function>,
  reactImportSource: string,
  // See `getBindingIdentityName`'s matching parameter.
  climbedParent: NodePath | null = climbComponentWrappers(path, reactImportSource).parentPath,
): ComponentIdentity | undefined {
  const own = getBindingIdentityName(path, reactImportSource, climbedParent);
  if (own !== undefined) return { kind: "binding", name: own };
  const factory = getIdentityFactory(path, reactImportSource, climbedParent);
  if (factory === undefined) return undefined;
  // Every other identity in this file is the bare binding name it was read
  // from; the call spelled out here marks the one identity that is not a
  // binding of its own, so the two never read as the same thing: `withCount`
  // is the factory, `withCount()` is the component it returns.
  return { kind: "hoc-return", name: `${factory.name}()`, factory: factory.path };
}

function isComponentIdentity(identity: ComponentIdentity | undefined): boolean {
  if (identity === undefined) return false;
  return identity.kind === "hoc-return" || isComponentName(identity.name);
}

function isHookIdentity(identity: ComponentIdentity | undefined): boolean {
  if (identity === undefined) return false;
  // A derived identity is only ever handed out to a function that renders JSX,
  // and it carries a factory's name rather than its own, so it can never name
  // a hook.
  return identity.kind === "binding" && isHookName(identity.name);
}

/**
 * A PascalCase identity derived from the module's own file name.
 *
 * `export default (props) => <p>{count.value}</p>` is a perfectly ordinary way
 * to write a component and the only component position in a module that carries
 * no name at all: there is no binding, no key, and no function `id` for
 * `getBindingIdentityName` to read, so the export resolved to no identity and
 * `auto` and `all` alike passed straight over it in silence -- while the named
 * `export default function App()` one line away was transformed.
 *
 * The file name is the name such a module actually has: `Counter.tsx` is
 * imported as `Counter`, which is exactly the identity the rest of the codebase
 * refers to it by. Only its *shape* is ever used -- the derived string
 * classifies the export through `isComponentName`/`isHookName` and is never
 * emitted into the output -- so sanitizing punctuation away (`my-widget.tsx` ->
 * `MyWidget`) costs nothing and cannot collide with anything.
 *
 * A name that does not come out PascalCase (`123.tsx`, a module with no usable
 * stem) yields nothing rather than something invented, and the caller reports
 * that rather than silently skipping the export.
 */
function deriveModuleIdentityName(filename: string | undefined): string | undefined {
  if (filename === undefined) return undefined;
  const base = filename.replace(/[?#].*$/, "").replace(/\\/g, "/");
  const stem = base.slice(base.lastIndexOf("/") + 1).replace(/\.[^.]*$/, "");
  const name = stem
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return isComponentName(name) ? name : undefined;
}

/**
 * The derived identity for an anonymous `export default`, and nothing else.
 * Reached only after `resolveComponentIdentity` has found no real name, so a
 * named default export (`export default function App()`, `export default memo(
 * function App() {})`) keeps the name it wrote for itself.
 */
function getDefaultExportIdentity(
  climbedParent: NodePath | null,
  filename: string | undefined,
): ComponentIdentity | undefined {
  if (climbedParent === null || !climbedParent.isExportDefaultDeclaration()) return undefined;
  const name = deriveModuleIdentityName(filename);
  return name === undefined ? undefined : { kind: "binding", name };
}

// The library exports `useSignals` from two first-party entry points: the
// package root (the bare, best-effort hook) and its `/runtime` subpath (the
// managed boundary this transform itself emits). Both are unambiguously this
// library's own export, so an import from either is verified. Accepting only
// the root would reject `/runtime` and then tell the author, in the barrel
// warning below, to import from exactly where they already imported.
function isVerifiedUseSignalsSource(source: string, importSource: string): boolean {
  return source === importSource || source === `${importSource}/runtime`;
}

function isNamedUseSignalsImport(
  functionPath: NodePath<t.Function>,
  name: string,
  importSource?: string,
): boolean {
  const resolved = resolveImportedBinding(functionPath, name);
  if (resolved === undefined || !resolved.specifier.isImportSpecifier()) return false;
  return (
    t.isIdentifier(resolved.specifier.node.imported, { name: "useSignals" }) &&
    (importSource === undefined || isVerifiedUseSignalsSource(resolved.source, importSource))
  );
}

function isNamespaceUseSignalsImport(
  functionPath: NodePath<t.Function>,
  name: string,
  importSource?: string,
): boolean {
  const resolved = resolveImportedBinding(functionPath, name);
  return (
    resolved !== undefined &&
    resolved.specifier.isImportNamespaceSpecifier() &&
    (importSource === undefined || isVerifiedUseSignalsSource(resolved.source, importSource))
  );
}

function isUseSignalsCallee(
  functionPath: NodePath<t.Function>,
  callee: NodePath<t.CallExpression["callee"]>,
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
  if (!object.isIdentifier()) return false;
  return (
    getReadPropertyName(callee.node) === "useSignals" &&
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

/**
 * The mirror image of `climbTransparentWrappers`: the path of the value a
 * chain of transparent wrappers is wrapped *around*. A declarator's initializer
 * is such a chain in `const Row = ((item) => <li />) as Fn`, so a check that
 * asks whether a binding was initialized with a function has to descend past
 * the wrappers to find it.
 */
function unwrapTransparentPath(path: NodePath): NodePath {
  let current = path;
  while (isTransparentWrapper(current.node)) {
    current = (current as NodePath<TransparentWrapper>).get("expression");
  }
  return current;
}

/**
 * The syntactic slot a function really occupies, past every wrapper that leaves
 * both its value and its identity alone: transparent TypeScript wrappers and
 * React's own `memo()` / `forwardRef()` calls. The two interleave freely --
 * `memo(((props) => <p />) as Fn)` puts the wrapper inside the call and
 * `(memo((props) => <p />)) as Fn` puts it outside -- so one loop alternates
 * between them rather than two separate passes, which would each stop at the
 * first wrapper of the other kind.
 *
 * Only argument 0 -- the component itself -- may climb. `memo`'s second
 * argument is an `areEqual` comparator that React calls during reconciliation,
 * outside any component's render: letting it inherit the wrapper's binding name
 * would classify `memo(Row, (a, b) => a.id === b.id)`'s comparator as the
 * component `MemoRow`, inject a full hook boundary into it, and throw
 * "Invalid hook call" on the first re-render. `forwardRef` takes only one
 * argument, so the same rule costs it nothing.
 */
function climbComponentWrappers(path: NodePath, reactImportSource: string): NodePath {
  let current = climbTransparentWrappers(path);
  for (
    let parent = current.parentPath;
    parent !== null &&
    parent.isCallExpression() &&
    parent.node.arguments[0] === current.node &&
    isKnownComponentWrapper(parent, reactImportSource);
    parent = current.parentPath
  ) {
    current = climbTransparentWrappers(parent);
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
  if (!t.isMemberExpression(node) && !t.isOptionalMemberExpression(node)) return false;
  const name = getReadPropertyName(node);
  return name !== undefined && renderCallbackMethods.has(name);
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

/**
 * The name other statements can reach this function's own binding by. The
 * declarator is reached from the climbed position rather than the immediate
 * parent, because a wrapper on the initializer -- `const Row = ((item) =>
 * <li />) as Fn` -- stands between the function and the binding it names.
 *
 * This is `getBindingIdentityName`'s twin, deliberately not shared with it:
 * that function asks what a function *is* (its public component/hook
 * identity, where the enclosing binding always outranks the function's own
 * name and a `memo()`/`forwardRef()` wrapper is climbed through to reach it);
 * this one asks what other code in the module can *call it by* (a function
 * declaration's own name is authoritative the instant it exists, and only a
 * transparent TypeScript wrapper -- never a component wrapper -- sits between
 * a reference and the binding, since `items.map(memo(Row))` does not hand
 * `map` the plain `Row` reference). Each direction was its own past
 * regression, so keep them separate rather than reconciling the priority or
 * the climb depth.
 */
function getOwnBindingName(path: NodePath<t.Function>): string | undefined {
  if (path.isFunctionDeclaration() && path.node.id !== null && path.node.id !== undefined) {
    return path.node.id.name;
  }
  const parent = climbTransparentWrappers(path).parentPath;
  if (parent !== null && parent.isVariableDeclarator() && t.isIdentifier(parent.node.id)) {
    return parent.node.id.name;
  }
  return undefined;
}

/**
 * The full path a function in a keyed slot is reached by, from a root binding
 * down: `const ns = { Row: ... }` gives `ns` / `["Row"]`, `Card.Row = ...` gives
 * `Card` / `["Row"]`, and `const a = { b: { Row: ... } }` gives `a` /
 * `["b", "Row"]`.
 *
 * Nesting has to be followed all the way out rather than one level, because the
 * path is matched against use sites: stopping early left `items.map(a.b.Row)`
 * unrecognized, so the per-item callback kept a boundary that React would run
 * once per item inside a single render.
 *
 * A class field is deliberately absent -- it is reached through an instance
 * (`new Holder().Row`), which no binding walk can follow.
 */
function getKeyedAccessPath(
  parent: NodePath,
): { origin: NodePath; root: string; keys: string[] } | undefined {
  if (parent.isAssignmentExpression()) {
    const left = parent.node.left;
    if (!t.isMemberExpression(left)) return undefined;
    const path = getStaticMemberPath(left);
    return path === undefined ? undefined : { origin: parent, ...path };
  }
  if (!parent.isObjectProperty()) return undefined;
  const key = getPropertyKeyName(parent.node);
  if (key === undefined) return undefined;
  const keys = [key];
  // Climb out through however many object literals nest this property, until
  // the outermost one reaches a binding or a member-expression target.
  for (let container = parent.parentPath; container.isObjectExpression(); ) {
    const holder = container.parentPath;
    if (holder === null) return undefined;
    if (holder.isVariableDeclarator() && t.isIdentifier(holder.node.id)) {
      return { origin: parent, root: holder.node.id.name, keys };
    }
    if (holder.isAssignmentExpression() && t.isMemberExpression(holder.node.left)) {
      const path = getStaticMemberPath(holder.node.left);
      return path === undefined
        ? undefined
        : { origin: parent, root: path.root, keys: [...path.keys, ...keys] };
    }
    if (!holder.isObjectProperty() || holder.node.value !== container.node) return undefined;
    const outerKey = getPropertyKeyName(holder.node);
    if (outerKey === undefined) return undefined;
    keys.unshift(outerKey);
    container = holder.parentPath;
  }
  return undefined;
}

/**
 * The keyed-slot twin of the by-reference check below: is a function held at
 * `ns.Row` / `Card.Row` handed to an iteration method anywhere in the module
 * (`items.map(ns.Row)`)?
 *
 * A keyed component has no binding of its own, so `getOwnBindingName` can say
 * nothing about it and the ordinary reference walk never runs. Naming such a
 * slot (`getKeyedIdentityName`) is what made it eligible for a boundary in the
 * first place, so this is the exclusion that has to come with it: without it,
 * `const handlers = { Row: (item) => <li>{item.value}</li> }` passed to `map`
 * would be the one keyed shape that gets a hook injected into a per-item
 * callback.
 *
 * The walk goes through the *root* binding rather than the function's, then
 * follows the same chain of keys back down from each reference, so only a use
 * that reads this exact slot counts. A JSX use (`<ns.Row />`) is a
 * `JSXMemberExpression`, not a member expression, so it never matches and a
 * genuine compound component keeps its boundary.
 */
function isKeyedRenderCallback(parent: NodePath): boolean {
  const access = getKeyedAccessPath(parent);
  if (access === undefined) return false;
  const binding = access.origin.scope.getBinding(access.root);
  if (binding === undefined) return false;
  return binding.referencePaths.some((rootPath) => {
    let current: NodePath = rootPath;
    for (const key of access.keys) {
      const member = current.parentPath;
      if (
        member === null ||
        !member.isMemberExpression() ||
        member.node.object !== current.node ||
        getReadPropertyName(member.node) !== key
      ) {
        return false;
      }
      current = member;
    }
    const slot = climbTransparentWrappers(current);
    return slot.parentPath !== null && isRenderCallbackInvocation(slot.parentPath.node, slot.node);
  });
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
//
// `visited` guards the mutual recursion with `isCalledFromRenderCallback`
// below against a reference cycle between two functions that call each other.
function isRenderCallback(
  path: NodePath<t.Function>,
  visited: Set<t.Node> = new Set(),
): boolean {
  if (visited.has(path.node)) return false;
  visited.add(path.node);

  const argument = climbTransparentWrappers(path);
  const enclosing = argument.parentPath;
  if (enclosing !== null && isRenderCallbackInvocation(enclosing.node, argument.node)) return true;
  if (enclosing !== null && isKeyedRenderCallback(enclosing)) return true;

  const name = getOwnBindingName(path);
  if (name === undefined || enclosing === null) return false;
  const binding = enclosing.scope.getBinding(name);
  if (binding === undefined) return false;
  // Only this function's own binding may speak for it, so a same-named binding
  // from an outer scope cannot disqualify an unrelated function. The declarator
  // is compared against the climbed position for the same reason
  // `getOwnBindingName` reads the name from there: a wrapped initializer puts
  // the wrapper, not the function, directly under the declarator.
  if (binding.path.node !== path.node && binding.path.node !== enclosing.node) return false;
  return binding.referencePaths.some((reference) => {
    const slot = climbTransparentWrappers(reference);
    if (slot.parentPath !== null && isRenderCallbackInvocation(slot.parentPath.node, slot.node)) {
      return true;
    }
    return isCalledFromRenderCallback(slot, visited);
  });
}

/**
 * Is `slot` the callee of a call that happens inside a render callback --
 * `items.map((item) => Row(item))` rather than `items.map(Row)`?
 *
 * Both forms run `Row` once per item inside the owner's single render pass, so
 * both must keep `Row` off a boundary of its own: `Row` called as a plain
 * function is never mounted as a fiber, so three hooks injected into it would
 * run in a loop and crash with "Rendered more hooks than during the previous
 * render" the moment the array length changes. The by-reference form is caught
 * by `isRenderCallbackInvocation`; this is the direct-call twin of it.
 */
function isCalledFromRenderCallback(slot: NodePath, visited: Set<t.Node>): boolean {
  const call = slot.parentPath;
  if (call === null) return false;
  const parts = getCallParts(call.node);
  if (parts === undefined || parts.callee !== slot.node) return false;
  const owner = call.getFunctionParent();
  return owner !== null && isRenderCallback(owner, visited);
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
    // `const Row = ((item) => <li />) as Fn` initializes the binding with the
    // wrapper, which erases to the function the caller actually runs.
    // `isExpression()` rather than `hasNode()`: a declarator's initializer is
    // an expression or nothing, and Babel 8 dropped the type guard from
    // `hasNode()`, so only this narrows the `null` out of the path type.
    if (init.isExpression()) {
      const value = unwrapTransparentPath(init);
      if (value.isArrowFunctionExpression() || value.isFunctionExpression()) return value;
    }
  }
  // An imported callback lives in another module, which a single-file
  // transform cannot follow.
  return undefined;
}

/**
 * Is `path` a component defined inline as a call argument --
 * `observer(function App() { return <p>{count.value}</p>; })`?
 *
 * The by-reference form is already eligible and documented as such: `const App
 * = ...; observer(App)` is named by its binding, and a reference passed to any
 * call that is not a known iteration method is "ordinary component
 * registration", where React instantiates the result as its own fiber with its
 * own hooks. The inline form is the same registration written in one
 * expression, and left out it was the one shape a third-party HOC could take
 * that went untransformed *and* unreported.
 *
 * Admitting it needs a discriminator with no ambiguity left in it, so all four
 * of these hold:
 *
 * - a function *expression carrying its own PascalCase name*. An arrow or an
 *   anonymous function expression has no identity for a boundary to attach to
 *   anyway, and the written-out name is the author's own statement that this is
 *   a component -- the same statement `const App = ...` makes.
 * - it renders JSX itself. A named callback that renders nothing is a
 *   comparator, a reducer, or a test body.
 * - it sits in an *argument* slot, never the callee, so the IIFE
 *   `(function App() { ... })()` -- which runs once at module scope, outside any
 *   render, exactly where a hook call throws -- is excluded.
 * - it is not the callback of a deferred hook (`useMemo(function Rows() {...},
 *   [])`), which runs inside the caller's render and must carry no hook of its
 *   own. The render-callback form (`items.map(function Row() {...})`) is
 *   excluded before this is ever reached, by `isRenderCallback`.
 */
function isInlineNamedComponentArgument(
  path: NodePath<t.Function>,
  call: NodePath<t.CallExpression>,
  reactImportSource: string,
): boolean {
  if (!path.isFunctionExpression()) return false;
  const id = path.node.id;
  if (id === null || id === undefined || !isComponentName(id.name)) return false;
  const slot = climbComponentWrappers(path, reactImportSource);
  if (!call.node.arguments.some((argument) => argument === slot.node)) return false;
  if (isDeferredCallbackArgument(path)) return false;
  return rendersJsx(path);
}

function isAutomaticTransformCandidate(
  path: NodePath<t.Function>,
  reactImportSource: string,
  // See `getBindingIdentityName`'s matching parameter: an already-walked
  // `climbComponentWrappers(path, reactImportSource).parentPath` a caller can
  // hand in instead of having this function redo the walk. Read lazily, not
  // as a default parameter, so the common `isRenderCallback`/
  // `isFunctionDeclaration` early-outs below still cost nothing when the
  // caller didn't already have a climbed parent to give.
  climbedParent?: NodePath | null,
): boolean {
  if (isRenderCallback(path)) return false;
  if (path.isFunctionDeclaration()) return true;

  const parent = climbedParent === undefined
    ? climbComponentWrappers(path, reactImportSource).parentPath
    : climbedParent;
  return (
    parent !== null &&
    (parent.isVariableDeclarator() ||
      parent.isReturnStatement() ||
      // An arrow's concise body is a return position too: `(Base) => (props) =>
      // <Base />` hands back the inner arrow exactly as `(Base) => { return
      // (props) => <Base />; }` does. Treating only the explicit `return` as
      // one left the concise HOC form outside candidacy altogether, so it was
      // neither transformed in `auto` mode nor reported when annotated.
      // Position alone is never enough on its own -- an identity still has to
      // resolve (`resolveComponentIdentity`) before anything is transformed --
      // so this widens what is *considered*, not what is transformed.
      parent.isArrowFunctionExpression() ||
      parent.isExportDefaultDeclaration() ||
      // Keyed slots: a component held in an object namespace, a class field, or
      // a compound-component assignment (`Card.Header = ...`). All three are
      // named by `getKeyedIdentityName`, and all three were invisible to `auto`
      // mode while they were not candidates -- no transform and no warning, even
      // when the name resolved perfectly well. The naming conventions still
      // decide what is actually transformed, so a lowercase key stays out.
      parent.isObjectProperty() ||
      parent.isClassProperty() ||
      // The assignment target has to root in a plain identifier, which excludes
      // `this.Row = ...` in a class component's constructor -- see
      // `getKeyedIdentityName`, where the same rule keeps that shape unnamed.
      (parent.isAssignmentExpression() &&
        t.isMemberExpression(parent.node.left) &&
        getStaticMemberPath(parent.node.left) !== undefined) ||
      (parent.isCallExpression() &&
        isInlineNamedComponentArgument(path, parent, reactImportSource)))
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
  // Every nested `Function` node `inspectFunction` walks past is checked
  // against this predicate, and both the candidacy test and the identity
  // resolution would otherwise climb through memo()/forwardRef() wrappers on
  // their own -- so without sharing the walk, one nested node could trigger it
  // twice. Climbing once here and handing the result to both keeps the
  // eligibility logic itself (and its short-circuiting) untouched.
  const climbedParent = climbComponentWrappers(path, reactImportSource).parentPath;
  if (!isAutomaticTransformCandidate(path, reactImportSource, climbedParent)) return false;
  const identity = resolveComponentIdentity(path, reactImportSource, climbedParent);
  return isComponentIdentity(identity) || isHookIdentity(identity);
}

// React hooks whose callback argument is deliberately *not* part of the read
// set of the render that declares it: an effect body runs after the commit, and
// `useCallback`/`useMemo` hand back a value reused across renders rather than
// re-evaluated on each one. Making reads in effects, event handlers and
// asynchronous callbacks into render dependencies is an explicit non-goal of
// the boundary design (docs/design/use-signals-boundary-design.md), so a
// `.value` read confined to one of these is no evidence that the surrounding
// component subscribes to anything.
const deferredCallbackHooks = new Set([
  "useEffect",
  "useLayoutEffect",
  "useInsertionEffect",
  "useCallback",
  "useMemo",
]);

/**
 * The property name a member expression reads, for the forms this file
 * tracks. A wrapper can sit around the key alone -- `items["map" as
 * const](Row)` is a plain member expression whose property is the wrapped
 * node -- so a computed property still needs unwrapping to reach the name.
 */
function getReadPropertyName(
  node: t.MemberExpression | t.OptionalMemberExpression,
): string | undefined {
  if (!node.computed) {
    return t.isIdentifier(node.property) ? node.property.name : undefined;
  }
  const property = unwrapTransparent(node.property);
  return t.isStringLiteral(property) ? property.value : undefined;
}

// `e.target.value`, `e.currentTarget.value` and `ref.current.value` are the DOM
// and React idioms that collide with a signal's `.value` accessor. None of them
// can be a signal: `target`/`currentTarget` are an event's element fields and
// `current` is a ref's mutable slot, so a `.value` hanging off one of them is
// never evidence of a signal read -- unlike `items[0].value` or `props.n.value`,
// where the receiver genuinely could be a signal and so still counts.
const nonSignalValueReceivers = new Set(["target", "currentTarget", "current"]);

function isNonSignalValueReceiver(object: t.Node): boolean {
  const receiver = unwrapTransparent(object);
  if (!t.isMemberExpression(receiver) && !t.isOptionalMemberExpression(receiver)) return false;
  const name = getReadPropertyName(receiver);
  return name !== undefined && nonSignalValueReceivers.has(name);
}

/**
 * Is `path` the value of a JSX event-handler attribute -- `onClick={() => ...}`,
 * `onChange={(e) => ...}`?
 *
 * The `on[A-Z]` naming convention is what separates the two kinds of function
 * a JSX attribute can carry. A handler runs from the event loop, long after the
 * render that created it, so `e.target.value` inside one is not a render read.
 * A render prop (`renderItem={(item) => ...}`) is invoked by the receiver
 * during the very same render and stays deliberately included -- it is the
 * documented workaround for the render-prop limitation, and excluding it would
 * leave a component that only reads through one with no subscription at all.
 */
function isJsxEventHandlerValue(path: NodePath): boolean {
  const container = climbTransparentWrappers(path).parentPath;
  if (container === null || !container.isJSXExpressionContainer()) return false;
  const attribute = container.parentPath;
  if (attribute === null || !attribute.isJSXAttribute()) return false;
  const name = attribute.node.name;
  return t.isJSXIdentifier(name) && /^on[A-Z]/.test(name.name);
}

/** Is `path` the callback argument of `useEffect`/`useMemo`/one of their kin? */
function isDeferredCallbackArgument(path: NodePath): boolean {
  const slot = climbTransparentWrappers(path);
  const call = slot.parentPath;
  if (call === null) return false;
  const parts = getCallParts(call.node);
  // All of these hooks take the callback first; a dependency array parked in
  // any later position is not a callback at all.
  if (parts === undefined || parts.arguments[0] !== slot.node) return false;
  const callee = unwrapTransparent(parts.callee);
  if (t.isIdentifier(callee)) return deferredCallbackHooks.has(callee.name);
  // `React.useEffect(...)` / `React["useEffect"](...)` reach the same hook.
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return false;
  const property = getReadPropertyName(callee);
  return property !== undefined && deferredCallbackHooks.has(property);
}

/**
 * Does a read at `path` sit inside a nested function that `functionPath`'s
 * render never runs -- an event handler, a deferred hook callback, or an async
 * body? Only the functions between the read and `functionPath` are examined:
 * the enclosing component is already known to be synchronous by the time any of
 * this matters, and anything further out owns its own inspection.
 */
function isDeferredReadContext(path: NodePath, functionPath: NodePath<t.Function>): boolean {
  for (
    let current = path.getFunctionParent();
    current !== null && current.node !== functionPath.node;
    current = current.getFunctionParent()
  ) {
    if (current.node.async) return true;
    if (isJsxEventHandlerValue(current)) return true;
    if (isDeferredCallbackArgument(current)) return true;
  }
  return false;
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
    // Only argument 0 can ever be the callback (see `isRenderCallbackInvocation`),
    // so there is no need to scan the rest of the argument list for it.
    const argument = call.node.arguments[0];
    if (argument === undefined) return;
    // The wrapper node is what occupies the argument slot, so the position
    // check compares against `argument` itself; only the name has to be read
    // from underneath a `Row!` / `Row as Fn` / `Row satisfies Fn` wrapper.
    const reference = unwrapTransparent(argument);
    if (!t.isIdentifier(reference)) return;
    if (!isRenderCallbackInvocation(call.node, argument)) return;
    const target = resolveReferencedFunction(call, reference.name);
    // A callback defined inside this function is already part of the walk.
    if (target === undefined || target.isDescendant(functionPath)) return;
    if (visited.has(target.node)) return;
    visited.add(target.node);
    const nested = inspectFunction(target, importSource, reactImportSource, visited);
    if (nested.containsJSX) inspection.containsJSX = true;
    if (nested.readsValue) inspection.readsValue = true;
  };

  // The direct-call twin of the fold above: `items.map((item) => Row(item))`
  // runs `Row` inside this render without React ever mounting it, so `Row` is
  // kept off a boundary of its own (see `isCalledFromRenderCallback`) and its
  // reads have to reach the component that actually runs them.
  const foldDirectlyCalledRenderCallbacks = (
    call: NodePath<t.CallExpression> | NodePath<t.OptionalCallExpression>,
  ): void => {
    const callee = unwrapTransparent(call.node.callee);
    // Only a component- or hook-shaped callee can ever have been a transform
    // candidate, so anything else is not worth a scope walk to resolve. The
    // hook shape belongs here just as much as the component one:
    // `isRenderCallback` demotes a callee by *position*, never by name, so a
    // `useX`-named helper called from inside a render callback loses the
    // boundary it would otherwise have had (`shouldAutomaticallyTransform`
    // transforms a hook identity on a `.value` read alone) and its reads have
    // to reach the owner here or nothing subscribes to them at all. A
    // lowercase callee is deliberately still skipped: it was never a candidate
    // to begin with, so it is an ordinary helper call, which this transform
    // does not follow anywhere else either.
    if (
      !t.isIdentifier(callee) ||
      (!isComponentName(callee.name) && !isHookName(callee.name))
    ) {
      return;
    }
    const owner = call.getFunctionParent();
    if (owner === null || owner.node === functionPath.node || !isRenderCallback(owner)) return;
    const target = resolveReferencedFunction(call, callee.name);
    if (target === undefined || target.isDescendant(functionPath)) return;
    if (visited.has(target.node)) return;
    visited.add(target.node);
    const nested = inspectFunction(target, importSource, reactImportSource, visited);
    if (nested.containsJSX) inspection.containsJSX = true;
    if (nested.readsValue) inspection.readsValue = true;
  };

  const recordValueRead = (
    node: t.MemberExpression | t.OptionalMemberExpression,
    path: NodePath,
  ): void => {
    if (getReadPropertyName(node) !== "value") return;
    if (isNonSignalValueReceiver(node.object)) return;
    if (isDeferredReadContext(path, functionPath)) return;
    inspection.readsValue = true;
  };

  functionPath.traverse({
    Function(path) {
      if (isNestedTrackingBoundary(path, reactImportSource)) path.skip();
    },
    JSXElement(_path) {
      inspection.containsJSX = true;
    },
    JSXFragment(_path) {
      inspection.containsJSX = true;
    },
    MemberExpression(path) {
      recordValueRead(path.node, path);
    },
    OptionalMemberExpression(path) {
      recordValueRead(path.node, path);
    },
    CallExpression(path) {
      foldReferencedRenderCallbacks(path);
      foldDirectlyCalledRenderCallbacks(path);
      // Compared by node, as the equivalent checks in `isDeferredReadContext`
      // and `foldDirectlyCalledRenderCallbacks` are: a re-crawled scope can hand
      // back a fresh NodePath for the very same function.
      if (path.getFunctionParent()?.node !== functionPath.node) return;
      const callee = path.get("callee");
      if (isUseSignalsCallee(functionPath, callee, importSource)) {
        inspection.hasUseSignalsCall = true;
      }
    },
    OptionalCallExpression(path) {
      foldReferencedRenderCallbacks(path);
      foldDirectlyCalledRenderCallbacks(path);
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

/**
 * Is `statements`' first entry a bare zero-argument call whose callee resolves
 * to `useSignals`, with `allowBarrel` controlling whether a barrel/re-export
 * chain counts (see `isUseSignalsCallee`)? Shared by `isExplicitUseSignals`
 * (`allowBarrel: false`, the verified boundary) and
 * `isUnverifiableBarrelUseSignals` (`allowBarrel: true`, to detect the exact
 * call the former rejects).
 */
function isFirstStatementUseSignalsCall(
  functionPath: NodePath<t.Function>,
  statements: NodePath<t.Statement>[],
  importSource: string,
  allowBarrel: boolean,
): boolean {
  const first = statements[0];
  if (first === undefined || !first.isExpressionStatement()) return false;
  const expression = first.get("expression");
  if (!expression.isCallExpression() || expression.node.arguments.length !== 0) return false;
  const callee = expression.get("callee");
  return isUseSignalsCallee(functionPath, callee, importSource, allowBarrel);
}

function isExplicitUseSignals(
  functionPath: NodePath<t.Function>,
  statements: NodePath<t.Statement>[],
  importSource: string,
): boolean {
  return isFirstStatementUseSignalsCall(functionPath, statements, importSource, false);
}

/**
 * The named import specifier the absorbed explicit `useSignals()` call resolves
 * to, when the call is a bare identifier bound by one. `applyManaged` replaces
 * that call with its own store declaration, which can leave the import behind
 * with nothing referencing it -- so `Program.exit` needs the specifier to check
 * and drop. A namespace import is deliberately not returned: the namespace
 * object may be used for other exports of the same module.
 */
function getAbsorbedUseSignalsImport(
  functionPath: NodePath<t.Function>,
  statements: NodePath<t.Statement>[],
): NodePath<t.ImportSpecifier> | undefined {
  const first = statements[0];
  if (first === undefined || !first.isExpressionStatement()) return undefined;
  const expression = first.get("expression");
  if (!expression.isCallExpression()) return undefined;
  const callee = expression.get("callee");
  if (!callee.isIdentifier()) return undefined;
  const resolved = resolveImportedBinding(functionPath, callee.node.name);
  if (resolved === undefined || !resolved.specifier.isImportSpecifier()) return undefined;
  return resolved.specifier;
}

// A call the transform cannot verify as this library's own `useSignals` --
// because a single-file transform cannot follow the re-export chain to
// confirm the barrel target -- can still be written in exactly the shape of a
// deliberate opt-in: the first statement, zero arguments, no different from
// `isExplicitUseSignals`'s own shape. Left unflagged, that call makes
// `hasUseSignalsCall` true (`isUseSignalsCallee` is barrel-permissive there,
// see `inspectFunction`) while `explicit` stays false, so the component is
// silently kept on the bare/best-effort boundary: no transform, no directive,
// and -- without this check -- no warning telling the author why. `explicit`
// is passed in rather than recomputed so this only does the extra
// barrel-permissive walk when the direct-import check already failed.
function isUnverifiableBarrelUseSignals(
  functionPath: NodePath<t.Function>,
  statements: NodePath<t.Statement>[],
  importSource: string,
  explicit: boolean,
): boolean {
  if (explicit) return false;
  return isFirstStatementUseSignalsCall(functionPath, statements, importSource, true);
}

// Barrel resolution can't be verified, so this is valid-but-unconfirmable
// code, not invalid code: warn, matching the `console.warn` convention Babel
// plugins use for non-fatal diagnostics, rather than `path.buildCodeFrameError`
// thrown outright (reserved for the genuinely invalid async/generator case
// below).
function warnUnverifiableBarrelUseSignals(path: NodePath<t.Function>, importSource: string): void {
  const warning = path.buildCodeFrameError(
    `This useSignals() call cannot be verified as "${importSource}"'s own export: it resolves ` +
      "only through a barrel/re-export module, and a single-file transform cannot follow that " +
      "chain to confirm the target. The component stays on the bare, best-effort useSignals() " +
      `boundary. Import useSignals directly from "${importSource}" or "${importSource}/runtime" ` +
      "instead to get the verified boundary.",
  );
  console.warn(warning.message);
}

// An `@useSignals` annotation is only actionable once the transform can name
// the function it sits on: the boundary is attached to a component or hook
// identity. A component returned straight out of a HOC has no name of its own
// but does inherit the factory's (`getIdentityFactory`), and a component held
// in a keyed slot takes its key's (`getKeyedIdentityName`), so what is left
// here is the remainder those cannot reach -- a factory returning a factory
// (`(a) => (b) => (props) => <p />`), where the middle function has no name to
// inherit either, or a name that resolves but is neither PascalCase nor `useX`.
// Left silent, such an annotation reads as an opt-in that simply never
// happened. Warn instead, matching the barrel case above.
function warnUnnamedUseSignalsAnnotation(path: NodePath<t.Function>): void {
  const warning = path.buildCodeFrameError(
    "This @useSignals annotation is ignored: the transform could not resolve a component " +
      "or hook identity for the annotated function, and the boundary is attached to that " +
      "identity. Give it a PascalCase (component) or useX (hook) name -- a binding, a named " +
      "function declaration, or an object/class property key -- to opt it in.",
  );
  console.warn(warning.message);
}

// The one anonymous `export default` shape `deriveModuleIdentityName` cannot
// name. Reported rather than skipped for exactly the reason the annotation
// warning above exists: the author wrote a component in a position the
// transform recognizes, and silence would read as "handled".
function warnUnnamedDefaultExport(path: NodePath<t.Function>): void {
  const warning = path.buildCodeFrameError(
    "This anonymous default export is left untransformed: its component identity is derived " +
      "from the module's file name, and this module's name does not yield a PascalCase " +
      "identifier. Name the function (`export default function App() { ... }`), or assign it " +
      "to a PascalCase binding and export that binding, to opt it in.",
  );
  console.warn(warning.message);
}

function shouldAutomaticallyTransform(
  mode: ReactFineGrainedSignalsMode,
  inspection: FunctionInspection,
  // The identity `decideTransform` already resolved for this same function,
  // rather than a path this would have to re-resolve (and re-climb) itself.
  identity: ComponentIdentity | undefined,
): boolean {
  if (isHookIdentity(identity)) {
    return mode !== "manual" && inspection.readsValue;
  }
  if (!isComponentIdentity(identity) || !inspection.containsJSX) {
    return false;
  }
  return mode === "all" || (mode === "auto" && inspection.readsValue);
}

/** Marks the current file as having produced at least one real change. */
function markTransformed(state: PluginState): void {
  (state.file.metadata as Record<string, unknown>)[transformedMetadataKey] = true;
}

// A standalone function purely to pin down, once, the exact NodePath union
// Babel infers for a function's body (`BlockStatement` for every `t.Function`
// variant except an arrow function's concise body, which may also be a bare
// `Expression`). `decideTransform`'s result carries this same path forward to
// `applyInject`/`applyManaged`, so its type is captured here via `ReturnType`
// rather than restated by hand.
function getFunctionBody(path: NodePath<t.Function>) {
  return path.get("body");
}
type FunctionBody = ReturnType<typeof getFunctionBody>;

// The shared fields `applyInject` and `applyManaged` both need once
// `decideTransform` has settled on a codegen strategy: the body slot to
// rewrite, the original statement list it came from (empty for a concise
// arrow body), whether the author's own call is being absorbed, and the
// runtime `useSignals` binding to call.
interface TransformCodegenInput {
  body: FunctionBody;
  statements: NodePath<t.Statement>[];
  explicit: boolean;
  runtimeImport: RuntimeImport;
  /**
   * The import specifier the absorbed explicit call resolved to, when there is
   * one -- see `getAbsorbedUseSignalsImport`. Only `applyManaged` absorbs, so
   * only it records this.
   */
  absorbedImport?: NodePath<t.ImportSpecifier> | undefined;
}

/**
 * What the `Function` visitor should do with one visited function, decided up
 * front by `decideTransform` so the two codegen strategies below never have to
 * re-derive eligibility themselves:
 * - `"skip"`: opted out, ineligible, or already covered by an unverifiable or
 *   late `useSignals()` call the component keeps on its own.
 * - `"directive-only"`: `transform: "inject"` with the author's own explicit
 *   call already in place -- nothing to inject, but the memoization opt-out
 *   directive may still need adding.
 * - `"inject"` / `"managed"`: apply the corresponding codegen strategy.
 */
type TransformDecision =
  | { kind: "skip" }
  | { kind: "directive-only"; body: FunctionBody }
  | ({ kind: "inject" } & TransformCodegenInput)
  | ({ kind: "managed" } & TransformCodegenInput);

/**
 * Resolves what, if anything, `path` needs done to it: the opt-out check,
 * explicit/annotated/automatic eligibility (plus the barrel-useSignals
 * warning that eligibility check surfaces along the way), the
 * async/generator guard, and -- once a function is confirmed eligible for
 * real codegen -- acquiring the runtime `useSignals` import it will call.
 * Pure decision-making: no AST mutation happens here, so every early return is
 * just a `return`, not a `return` guarding mutations already made.
 */
function decideTransform(
  path: NodePath<t.Function>,
  state: PluginState,
  options: InternalTransformOptions,
  reactImportSource: string,
): TransformDecision {
  // Computed once and given to every check below that would otherwise climb
  // through this same function's memo()/forwardRef() wrappers on its own --
  // see `getBindingIdentityName`'s matching parameter.
  const climbedParent = climbComponentWrappers(path, reactImportSource).parentPath;
  const identity =
    resolveComponentIdentity(path, reactImportSource, climbedParent) ??
    getDefaultExportIdentity(climbedParent, state.filename);
  // A `@useSignals`/`@noUseSignals` comment on a HOC factory is written for the
  // component that factory returns: the factory is never a component itself and
  // can never carry a boundary, so it has nothing else to mean.
  // `hasOwnedLeadingComment` already reaches such a comment from the returned
  // function when the factory is a concise-body arrow -- the climb runs through
  // expressions all the way up to the declaration -- but the block-bodied form
  // puts a `return` statement in the way, where the climb stops by design, so
  // the factory is asked directly.
  const factory = identity?.kind === "hoc-return" ? identity.factory : undefined;
  const ownsLeadingComment = (pattern: RegExp): boolean =>
    hasOwnedLeadingComment(path, pattern) ||
    (factory !== undefined && hasOwnedLeadingComment(factory, pattern));

  if (ownsLeadingComment(noUseSignalsComment)) return { kind: "skip" };

  const body = path.get("body");
  const statements = body.isBlockStatement() ? body.get("body") : [];
  const explicit = isExplicitUseSignals(path, statements, options.importSource);
  if (isUnverifiableBarrelUseSignals(path, statements, options.importSource, explicit)) {
    warnUnverifiableBarrelUseSignals(path, options.importSource);
  }
  const inspection = inspectFunction(path, options.importSource, reactImportSource);
  const annotation = ownsLeadingComment(useSignalsComment);
  // A factory is not a component, so no automatic route and no annotation may
  // attach a boundary to it -- the component it returns carries one instead
  // (`getIdentityFactory`). An explicit, hand-written `useSignals()` call is
  // left alone, here as everywhere: the author's own call is their statement
  // about their own code, not something inferred.
  //
  // A *hook* identity is exempt, and the exemption is the whole reason the gate
  // is written against the resolved identity rather than the shape alone. The
  // rationale for standing a factory down is that React never calls it during a
  // render, so a boundary inside it would run with no dispatcher -- and that
  // rationale simply does not reach a hook, which React calls from inside a
  // render that is already in progress, where a boundary is valid. Without this,
  // `function useModal(Overlay) { const n = count.value; ... }` was skipped for
  // taking a component-shaped parameter, silently and with its `@useSignals`
  // annotation dropped too (the annotation warning is gated on rendering JSX,
  // which a hook does not do).
  const isFactory = isHigherOrderComponentFactory(path) && !isHookIdentity(identity);
  const annotated =
    annotation && !isFactory && (isComponentIdentity(identity) || isHookIdentity(identity));
  const candidate = isAutomaticTransformCandidate(path, reactImportSource, climbedParent);
  // The annotation was written for a function no boundary ended up attached to,
  // so it will be dropped. An opt-in that silently does nothing is the worst of
  // both outcomes -- the author believes the component is subscribed and it is
  // not -- so this reports it wherever the annotation could plausibly have
  // meant a component.
  //
  // `rendersJsx(path)` is the whole condition, and candidacy deliberately is
  // not part of it any more. The positions candidacy excludes -- a bare call
  // argument, a JSX attribute value, an object or class member before this file
  // learned to name one -- are exactly the positions where an annotation used to
  // vanish without a word, which is the reason this check exists at all.
  // Requiring the function to render JSX of its own is what keeps it honest in
  // the two directions that matter:
  //
  // - a function that renders nothing was never going to be a component, so an
  //   annotation on it is the lowercase-helper no-op the README documents; and
  // - an annotated HOC *factory* renders nothing itself while the component it
  //   returns honors that very same annotation, so it must stay quiet. That is
  //   the case the old `identity === undefined` guard was protecting, and
  //   rendering is a sounder test for it than name shape, which cannot tell a
  //   factory from a helper at all.
  //
  // The enclosing-function guard stays: `hasOwnedLeadingComment` climbs through
  // expressions up to the declaration, so every nested arrow under an annotated
  // concise-body component reads that component's annotation as its own and
  // would otherwise report it a second time.
  if (annotation && !annotated && rendersJsx(path)) {
    const enclosing = path.getFunctionParent();
    if (enclosing === null || !hasOwnedLeadingComment(enclosing, useSignalsComment)) {
      warnUnnamedUseSignalsAnnotation(path);
    }
  }
  // An anonymous default export the file name could not name is the one
  // recognized component position left with no identity at all, and `auto`/`all`
  // would otherwise skip it in silence.
  if (
    options.mode !== "manual" &&
    identity === undefined &&
    climbedParent !== null &&
    climbedParent.isExportDefaultDeclaration() &&
    rendersJsx(path)
  ) {
    warnUnnamedDefaultExport(path);
  }
  const automatic =
    !isFactory && candidate && shouldAutomaticallyTransform(options.mode, inspection, identity);
  if (!explicit && !annotated && !automatic) return { kind: "skip" };
  if (!explicit && inspection.hasUseSignalsCall) return { kind: "skip" };
  if (options.transform === "inject" && explicit) return { kind: "directive-only", body };
  if (path.node.async || path.node.generator) {
    if (!explicit && !annotated) return { kind: "skip" };
    throw path.buildCodeFrameError(
      "useSignals transform only supports synchronous, non-generator functions",
    );
  }

  const managedRuntimeSource = `${options.importSource}/runtime`;
  const importSource = options.transform === "managed"
    ? managedRuntimeSource
    : options.importSource;
  const imports = options.transform === "managed"
    ? state.managedRuntimeImports
    : state.directImports;
  let runtimeImport = imports.find(({ identifier, bindingPath }) =>
    path.scope.getBinding(identifier.name)?.path === bindingPath
  );
  if (runtimeImport === undefined) {
    runtimeImport = addRuntimeImport(state.programPath, importSource, path);
    imports.push(runtimeImport);
  }

  return {
    kind: options.transform,
    body,
    statements,
    explicit,
    runtimeImport,
    absorbedImport: explicit ? getAbsorbedUseSignalsImport(path, statements) : undefined,
  };
}

/** Codegen: inject a bare `useSignals()` call at the top of the function body. */
function applyInject(
  path: NodePath<t.Function>,
  { body, runtimeImport }: TransformCodegenInput,
  options: InternalTransformOptions,
  state: PluginState,
): void {
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
  markTransformed(state);
}

/** Codegen: wrap the function body in the managed try/finally render-tracking scope. */
function applyManaged(
  path: NodePath<t.Function>,
  { body, statements, explicit, runtimeImport, absorbedImport }: TransformCodegenInput,
  options: InternalTransformOptions,
  state: PluginState,
): void {
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
  // The author's own call is gone; whether its import is now dead can only be
  // answered once every function in the file has been visited, so record it and
  // let `Program.exit` decide.
  if (absorbedImport !== undefined) state.absorbedImports.push(absorbedImport);
  markTransformed(state);
}

/**
 * Drops an `import { useSignals } from "<importSource>"` the managed transform
 * absorbed and nothing else refers to any more, along with the whole
 * declaration once its last specifier goes. A reused `/runtime` import survives
 * this untouched: the emitted store declaration still calls it, so the binding
 * is still referenced.
 */
function removeAbsorbedImports(programPath: NodePath<t.Program>, state: PluginState): void {
  if (state.absorbedImports.length === 0) return;
  programPath.scope.crawl();
  for (const specifier of state.absorbedImports) {
    if (specifier.removed) continue;
    const binding = programPath.scope.getBinding(specifier.node.local.name);
    if (binding === undefined || binding.path.node !== specifier.node || binding.referenced) {
      continue;
    }
    const declaration = specifier.parentPath;
    specifier.remove();
    if (declaration.isImportDeclaration() && declaration.node.specifiers.length === 0) {
      declaration.remove();
    }
  }
  state.absorbedImports = [];
}

const babelTransform = declare<PluginState, InternalTransformOptions>((api, options) => {
  api.assertVersion(8);
  const managedRuntimeSource = `${options.importSource}/runtime`;
  const reactImportSource = options.reactImportSource;

  const plugin: PluginObject<PluginState> = {
    name: "unplugin-react-fine-grained-signals",
    visitor: {
      Program: {
        enter(path, state) {
          state.programPath = path;
          state.managedRuntimeImports = findRuntimeImports(path, managedRuntimeSource);
          state.directImports = findRuntimeImports(path, options.importSource);
          state.absorbedImports = [];
          (state.file.metadata as Record<string, unknown>)[transformedMetadataKey] = false;
        },
        exit(path, state) {
          removeAbsorbedImports(path, state);
        },
      },
      Function(path, state) {
        const decision = decideTransform(path, state, options, reactImportSource);
        switch (decision.kind) {
          case "skip":
            return;
          case "directive-only":
            // Nothing to inject, but the author's own call still makes this
            // function render-tracking, so it needs the memoization opt-out.
            if (
              options.reactCompiler === "auto" &&
              decision.body.isBlockStatement() &&
              addNoMemoDirective(decision.body.node)
            ) {
              markTransformed(state);
            }
            return;
          case "inject":
            applyInject(path, decision, options, state);
            return;
          case "managed":
            applyManaged(path, decision, options, state);
            return;
        }
      },
    },
  };
  return plugin;
});

/**
 * A raw-text screen run before the file is parsed at all. Parsing, walking,
 * printing and generating a source map is the whole cost of this transform, and
 * it is discarded outright for every file none of the three opt-in routes can
 * possibly apply to:
 *
 * - explicit and annotated opt-in both need the text `useSignals` (an aliased
 *   import, a namespace call and the `@useSignals` comment all still contain
 *   it);
 * - `auto` needs a `.value` read, so it needs the text `value`;
 * - `all` additionally wraps JSX components, so it needs a `<` -- but its
 *   custom-hook rule still needs a `.value` read.
 *
 * Each test is a plain substring scan and each one is deliberately wider than
 * what the AST check accepts, so this can only ever bail out on files the walk
 * would have rejected anyway.
 */
function mightTransform(code: string, mode: ReactFineGrainedSignalsMode): boolean {
  if (code.includes("useSignals")) return true;
  if (mode === "manual") return false;
  if (code.includes("value")) return true;
  return mode === "all" && code.includes("<");
}

/** Runs the private Babel transform for the universal bundler adapter. */
export function transformReactFineGrainedSignals(
  code: string,
  id: string,
  options: InternalTransformOptions,
): InternalTransformResult | null {
  if (!mightTransform(code, options.mode)) return null;
  const cleanId = id.replace(/[?#].*$/, "");
  const isTypeScript = /\.[cm]?tsx?$/i.test(cleanId);
  // JavaScript commonly carries JSX without using a .jsx suffix, while
  // TypeScript's angle-bracket assertions make JSX parsing unsafe for .ts.
  const supportsJsx = /\.[cm]?(?:jsx?|tsx)$/i.test(cleanId);
  const parserPlugins: NonNullable<NonNullable<InputOptions["parserOpts"]>["plugins"]> = [];
  if (supportsJsx) parserPlugins.push("jsx");
  if (isTypeScript) parserPlugins.push("typescript");
  parserPlugins.push("decorators-legacy", "decoratorAutoAccessors");
  let result: ReturnType<typeof transformSync>;
  try {
    result = transformSync(code, {
      babelrc: false,
      configFile: false,
      filename: id,
      // Babel otherwise derives `sources` from `filename`'s basename, which both
      // loses the path a debugger needs and, under Vite, leaks the HMR query
      // string (`App.tsx?t=173...`) into the map as if it were a real file name.
      sourceFileName: cleanId,
      parserOpts: { plugins: parserPlugins },
      // Babel 8 types `plugins` as `PluginItem<object>[]`, which cannot carry a
      // plugin whose options are a specific interface. The pair is built from
      // `babelTransform`'s own option type one line up, so this only restates
      // what that call site already checked.
      plugins: [[babelTransform, options] as PluginItem],
      sourceMaps: true,
    });
  } catch (error) {
    // Fatal on purpose. Swallowing this and returning `null` would hand the
    // bundler the untransformed source, which is the silent stale-UI failure
    // this file refuses everywhere else -- and here it would also hide a real
    // syntax error behind a component that merely stopped updating.
    //
    // What is added is attribution. The raw Babel error names neither the
    // plugin that raised it nor the parser configuration it used, so the most
    // likely cause -- a syntax this plugin list does not enable, such as JSX in
    // a `.ts` module (where TypeScript's angle-bracket assertions make JSX
    // parsing unsafe, so `jsx` is deliberately off) or a proposal this
    // transform does not opt into -- reads as an unattributable build failure
    // somewhere in the bundler. `cause` keeps the original error and its code
    // frame intact for anything that prints it.
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `unplugin-react-fine-grained-signals could not parse ${cleanId} ` +
        `(Babel parser plugins: ${parserPlugins.join(", ") || "none"}): ${detail}`,
      { cause: error },
    );
  }
  if (
    result === null ||
    typeof result.code !== "string" ||
    (result.metadata as Record<string, unknown> | undefined)?.[transformedMetadataKey] !== true
  ) {
    return null;
  }
  return { code: result.code, map: result.map };
}
