import { declare } from "@babel/helper-plugin-utils";
import {
  transformSync,
  type InputOptions,
  type NodePath,
  type PluginItem,
  type PluginObject,
  type PluginPass,
  type Visitor,
} from "@babel/core";
import * as t from "@babel/types";
import type { DiagnosticId } from "./diagnostics.js";

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
  /** Receives non-fatal diagnostics; omitted for direct calls, which use console.warn. */
  warn?: (warning: Error) => void;
}

export interface InternalTransformResult {
  code: string;
  map?: {
    file?: string;
    mappings: string;
    names: string[];
    sourceRoot?: string;
    sources: string[];
    sourcesContent?: (string | null)[];
    version: number;
  };
}

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
   * Import specifiers whose only use was an explicit `useSignalTracking()` call the
   * managed transform absorbed into its own store declaration. They are
   * re-checked in `Program.exit` and dropped if nothing else references them,
   * so absorbing the call does not leave a dead import pulling the non-runtime
   * entry point into the bundle graph.
   */
  absorbedImports: NodePath<t.ImportSpecifier>[];
  /** Whether the file was parsed as TypeScript, so generated code may use its syntax. */
  typeScript: boolean;
  /**
   * Whether the file had no import declaration of its own when the walk began.
   * Only then does `addRuntimeImport` put the generated import in front of the
   * author's first statement, which `Program.exit` has to account for -- see
   * `keepJsxPragmasFirst`.
   */
  importFree: boolean;
}

interface FunctionInspection {
  containsJSX: boolean;
  readsValue: boolean;
  hasSignalTrackingCall: boolean;
  hasUseManagedSignalsCall: boolean;
}

const useSignalTrackingComment = /(^|\s)@signalTracking(\s|$)/;
const noSignalTrackingComment = /(^|\s)@noSignalTracking(\s|$)/;
const transformedMetadataKey = "reactFineGrainedSignalsTransformed";

// React Compiler caches a component's JSX in its memo cache, and a signal read
// it classifies as non-reactive (a module-scope binding) is then evaluated once
// and never again: the render collector sees no dependencies on every later
// render and drops the component's subscriptions. Opting the functions this
// transform made reactive out of memoization keeps those reads happening.
// See development/design/react-compiler-compatibility.md for the measurements.
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
 * namespace `useSignalTracking` import -- reduces to "does this resolved binding
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
// could be mistaken for it and have a `useSignalTracking()` hook injected into a
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
 * The static name of an object property's key. A computed key
 * is only readable when it is a string literal (`{ ["Home"]: ... }`), exactly as
 * `getReadPropertyName` reads `items["map"]`; anything else is decided at
 * runtime and stays unnamed, which leaves the function untransformed.
 */
function getPropertyKeyName(
  node: t.ObjectProperty | t.ObjectMethod,
): string | undefined {
  const key = unwrapTransparent(node.key);
  if (node.computed) return t.isStringLiteral(key) ? key.value : undefined;
  if (t.isIdentifier(key)) return key.name;
  return t.isStringLiteral(key) ? key.value : undefined;
}

/**
 * The identity an object-literal method takes from its key -- the shorthand
 * twin of a keyed `ObjectProperty`:
 *
 * ```js
 * export const ns = { Home() { return <p>{count.value}</p>; } };   // this
 * export const ns = { Home: () => <p>{count.value}</p> };          // == this
 * ```
 *
 * The two spellings put the same function at the same `ns.Home` slot, and the
 * rest of the module reaches both through `<ns.Home />`, so they have to resolve
 * to the same identity -- while only the property form did, the method form was
 * passed over in silence. Unlike a property, the method *is* the function node,
 * so there is no enclosing slot to climb to: its own key is read directly.
 *
 * Only a plain `kind: "method"` qualifies. A getter or setter is an accessor
 * React never calls as a component, and an async or generator method can never
 * carry a boundary (`decideTransform` refuses them anyway), so all four resolve
 * to no identity at all rather than to a name that could only ever be rejected
 * later or, under an annotation, turned into a build error.
 */
function getObjectMethodIdentityName(node: t.ObjectMethod): string | undefined {
  if (node.kind !== "method" || node.async || node.generator) return undefined;
  return getPropertyKeyName(node);
}

/**
 * The component/hook name a function held in a *keyed slot* takes from its key:
 *
 * ```js
 * Card.Header = () => <h1>{count.value}</h1>;          // a compound component
 * export const ns = { Home: () => <p>{count.value}</p> };  // an object namespace
 * ```
 *
 * Both are ordinary ways to hold a component that no *binding* names, so
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
 * nothing, transform nothing. Class fields (`Row = () => ...`) are excluded the
 * same way. Such a renderer is left to its author: one rendered as an element
 * (`<this.Row />`) can call `useSignalTracking()` itself; one called as a
 * function or passed per item cannot hold a hook at all.
 */
function getKeyedIdentityName(parent: NodePath): string | undefined {
  if (parent.isAssignmentExpression()) {
    const left = parent.node.left;
    if (!t.isMemberExpression(left)) return undefined;
    return getStaticMemberPath(left)?.keys.at(-1);
  }
  if (parent.isObjectProperty()) return getPropertyKeyName(parent.node);
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
 *
 * An optional link reads the same key: `ns?.group.Home`, `ns.group?.Home` and
 * `ns.group.Home` all name one slot, so each link may be either member form.
 */
function getStaticMemberPath(
  node: t.MemberExpression | t.OptionalMemberExpression,
): { root: string; keys: string[] } | undefined {
  const chain = getStaticMemberChain(node);
  return chain !== undefined && t.isIdentifier(chain.root) ? { root: chain.root.name, keys: chain.keys } : undefined;
}

/** `getStaticMemberPath` without the root restriction: the innermost object node and the static keys. */
function getStaticMemberChain(
  node: t.MemberExpression | t.OptionalMemberExpression,
): { root: t.Node; keys: string[] } | undefined {
  const keys: string[] = [];
  let current: t.Node = node;
  while (t.isMemberExpression(current) || t.isOptionalMemberExpression(current)) {
    const key = getReadPropertyName(current);
    if (key === undefined) return undefined;
    keys.unshift(key);
    current = current.object;
  }
  return { root: current, keys };
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
  // An object method is its own keyed slot -- no wrapper can sit around it and
  // no binding encloses it, so its key is the whole answer.
  if (path.isObjectMethod()) return getObjectMethodIdentityName(path.node);
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
 * called at module scope the injected `useSignalTracking()` ran with no React
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
 * function to `@signalTracking`, so a signal write silently stops re-rendering it
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
 * has none -- an `@signalTracking` annotation there still warns
 * (`warnUnnamedSignalTrackingAnnotation`) instead of silently doing nothing.
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

// The root `useSignalTracking` import is the bare, best-effort hook. Its direct import
// remains recognizable as an explicit opt-in that managed mode can absorb.
function isVerifiedSignalTrackingSource(source: string, importSource: string): boolean {
  return source === importSource;
}

function isNamedUseManagedSignalsImport(
  functionPath: NodePath<t.Function>,
  name: string,
  runtimeSource: string,
): boolean {
  const resolved = resolveImportedBinding(functionPath, name);
  return (
    resolved !== undefined &&
    resolved.specifier.isImportSpecifier() &&
    resolved.source === runtimeSource &&
    t.isIdentifier(resolved.specifier.node.imported) &&
    (resolved.specifier.node.imported.name === "useManagedSignals" ||
      resolved.specifier.node.imported.name === "useSignalCapture")
  );
}

function isNamespaceUseManagedSignalsImport(
  functionPath: NodePath<t.Function>,
  name: string,
  runtimeSource: string,
): boolean {
  const resolved = resolveImportedBinding(functionPath, name);
  return (
    resolved !== undefined &&
    resolved.specifier.isImportNamespaceSpecifier() &&
    resolved.source === runtimeSource
  );
}

function isNamedSignalTrackingImport(
  functionPath: NodePath<t.Function>,
  name: string,
  importSource?: string,
): boolean {
  const resolved = resolveImportedBinding(functionPath, name);
  if (resolved === undefined || !resolved.specifier.isImportSpecifier()) return false;
  return (
    t.isIdentifier(resolved.specifier.node.imported, { name: "useSignalTracking" }) &&
    (importSource === undefined || isVerifiedSignalTrackingSource(resolved.source, importSource))
  );
}

function isNamespaceSignalTrackingImport(
  functionPath: NodePath<t.Function>,
  name: string,
  importSource?: string,
): boolean {
  const resolved = resolveImportedBinding(functionPath, name);
  return (
    resolved !== undefined &&
    resolved.specifier.isImportNamespaceSpecifier() &&
    (importSource === undefined || isVerifiedSignalTrackingSource(resolved.source, importSource))
  );
}

function isSignalTrackingCallee(
  functionPath: NodePath<t.Function>,
  callee: NodePath<t.CallExpression["callee"]>,
  importSource: string,
  allowBarrel = true,
): boolean {
  if (callee.isIdentifier()) {
    // A named re-export keeps the imported name, so this also recognizes
    // `useSignalTracking` aliases imported through application barrel modules.
    return isNamedSignalTrackingImport(
      functionPath,
      callee.node.name,
      allowBarrel ? undefined : importSource,
    );
  }
  if (!callee.isMemberExpression()) return false;
  const object = callee.get("object");
  if (!object.isIdentifier()) return false;
  return (
    getReadPropertyName(callee.node) === "useSignalTracking" &&
    isNamespaceSignalTrackingImport(
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
  const argument = getRenderCallbackArgument(call);
  return argument !== undefined && argument === callback;
}

/**
 * The argument slot of `call` that a known iteration method invokes once per
 * item: argument 0 of `items.map` / `flatMap` / `forEach`, and argument 1 --
 * the `mapFn` -- of `Array.from(arrayLike, mapFn)`, which builds an element per
 * item exactly as `map` does (`Array.from({ length: 5 }, Star)`). Only a
 * plain `Array` identifier counts as the callee's object; a shadowing local
 * `Array` with its own `from` is not worth a scope lookup here, and matching it
 * errs toward the crash-safe side (no hook in the callback).
 */
function getRenderCallbackArgument(call: t.Node): t.Node | undefined {
  const parts = getCallParts(call);
  if (parts === undefined) return undefined;
  if (isRenderCallbackCallee(parts.callee)) return parts.arguments[0];
  const callee = unwrapTransparent(parts.callee);
  if (
    t.isMemberExpression(callee) &&
    t.isIdentifier(callee.object, { name: "Array" }) &&
    getReadPropertyName(callee) === "from"
  ) {
    return parts.arguments[1];
  }
  return undefined;
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
 *
 * An object *method* (`{ Row() {...} }`) is passed in as its own `parent`: it is
 * the function and the slot at once, and it sits in its object literal exactly
 * where the equivalent `{ Row: ... }` property would, so the same climb applies.
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
  if (!parent.isObjectProperty() && !parent.isObjectMethod()) return undefined;
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
  return getKeyedSafetyUses(parent).some((slot) =>
    slot.parentPath !== null && isRenderCallbackInvocation(slot.parentPath.node, slot.node)
  );
}

/**
 * Every place the module reads the exact keyed slot `access` describes, as the
 * path of the syntactic slot that read occupies (past transparent TypeScript
 * wrappers, so `ns.Row!` hands back the wrapper that actually sits in an
 * argument list or callee position).
 *
 * The walk goes through the *root* binding, then follows the same chain of keys
 * back down from each reference; a reference that turns off the chain anywhere
 * (`ns.Other`, `ns` passed whole -- or `ns[k]` unless `includeDynamic` is set)
 * is not a use of this slot. Both
 * by-key exclusions -- the render-callback one above and the plain-call one in
 * `isPlainCalledComponent` -- ask their question of this list (joined with the
 * `this` uses in `getKeyedSafetyUses`), so they cannot disagree about which
 * reads count as reaching the slot.
 */
function getKeyedSlotUses(
  access: { origin: NodePath; root: string; keys: string[] },
  // Also count a computed link whose key cannot be read statically
  // (`renderers[node.type]`) as one that may reach this slot -- see
  // `matchesKeyedLink`. Only the two safety exclusions ask for this;
  // `resolveKeyedFunction` must keep naming exactly one static slot.
  includeDynamic = false,
): NodePath[] {
  const binding = access.origin.scope.getBinding(access.root);
  if (binding === undefined) return [];
  const uses: NodePath[] = [];
  for (const rootPath of binding.referencePaths) {
    followKeyedChain(rootPath, access.keys, includeDynamic, uses);
  }
  return uses;
}

/**
 * Follows `keys` down from `start` -- a reference to the root binding, or a
 * `this` that stands for the object holding the slot -- and records the use it
 * reaches in `uses`. A chain that turns off the path records nothing.
 */
function followKeyedChain(
  start: NodePath,
  keys: readonly string[],
  includeDynamic: boolean,
  uses: NodePath[],
): void {
  let current = start;
  for (const [index, key] of keys.entries()) {
    const member = current.parentPath;
    if (member === null || !matchesKeyedLink(member, current, key, includeDynamic)) {
      // `const { Row } = parts` reads the last key into a binding of its
      // own, so that binding's references reach the slot just as
      // `parts.Row` does -- `items.map(Row)` then runs the keyed function
      // per item. Only this one-step destructuring of the final key is
      // followed; deeper patterns and re-assigned aliases are not.
      if (index === keys.length - 1) uses.push(...getDestructuredSlotUses(current, key));
      return;
    }
    current = member;
  }
  uses.push(climbTransparentWrappers(current));
}

/**
 * Every place a sibling reaches the object-literal slot `holder` through
 * `this`:
 *
 * ```jsx
 * const renderers = {
 *   Leaf(i) { return <li>{suffix.value}</li>; },
 *   Tree(count) { return <ul>{Array.from({ length: count }, (_, i) => this.Leaf(i))}</ul>; },
 * };
 * ```
 *
 * `this.Leaf(i)` runs `Leaf` once per item inside whatever render called
 * `Tree`, exactly as `renderers.Leaf(i)` would, but `this` is not a binding,
 * so the root-reference walk in `getKeyedSlotUses` never sees it -- and a
 * boundary in `Leaf` was then a variable number of hooks in the caller.
 *
 * `this` is only followed where its identity is syntactic: inside a function
 * that is itself a non-arrow member of the object literal (a method, accessor,
 * or `function` property value), and inside arrows nested in it, which inherit
 * that `this`. A nested `function` or class rebinds `this` and is skipped. Each
 * enclosing object literal is its own level, so `this.Leaf` in a method of the
 * object holding `Leaf` reaches it, `this.group.Leaf` in a method of the outer
 * object reaches it through `group`, and a same-named slot in another object
 * literal is never touched. A computed `this[key]` reaches every slot at its
 * depth, like `renderers[key]` does.
 *
 * Only the object literals around this one slot are walked, never the
 * program, so the cost stays with the object that holds the slot.
 */
function getThisSlotUses(holder: NodePath): NodePath[] {
  if (!holder.isObjectProperty() && !holder.isObjectMethod()) return [];
  const key = getPropertyKeyName(holder.node);
  if (key === undefined) return [];
  const keys = [key];
  const uses: NodePath[] = [];
  for (let container: NodePath | null = holder.parentPath; container?.isObjectExpression(); ) {
    for (const reference of getObjectThisReferences(container)) {
      followKeyedChain(reference, keys, true, uses);
    }
    const outer: NodePath | null = container.parentPath;
    if (outer === null || !outer.isObjectProperty() || outer.node.value !== container.node) break;
    const outerKey = getPropertyKeyName(outer.node);
    if (outerKey === undefined) break;
    keys.unshift(outerKey);
    container = outer.parentPath;
  }
  return uses;
}

/**
 * `getObjectThisReferences` results, per object literal. One function's
 * decision asks for the same object's references many times over -- every
 * candidacy check of every nested function lands here -- so they are collected
 * once. Keyed by node, so nothing outlives the file being transformed.
 *
 * A rewrite moves the rewritten function's statements under new parents, and a
 * cached path inside it would then describe a tree that no longer exists, so
 * `invalidateThisReferences` drops every entry whose references could lie
 * inside that function: the object literals within it, and -- only when it
 * contains a `this` at all -- the object literals around it. Every other entry
 * stays valid, which matters in a module where most object members are
 * transformed one after another and only a few of them use `this`.
 */
const thisReferenceCache = new WeakMap<t.ObjectExpression, NodePath<t.ThisExpression>[]>();

function invalidateThisReferences(rewritten: NodePath<t.Function>): void {
  let containsThis = false;
  rewritten.traverse({
    ObjectExpression(object) {
      thisReferenceCache.delete(object.node);
    },
    ThisExpression() {
      containsThis = true;
    },
  });
  if (!containsThis) return;
  for (let parent: NodePath | null = rewritten.parentPath; parent !== null; parent = parent.parentPath) {
    if (parent.isObjectExpression()) thisReferenceCache.delete(parent.node);
  }
}

/** The `this` expressions that stand for `object` itself, inside its own non-arrow members. */
function getObjectThisReferences(object: NodePath<t.ObjectExpression>): NodePath<t.ThisExpression>[] {
  const cached = thisReferenceCache.get(object.node);
  if (cached !== undefined) return cached;
  const references: NodePath<t.ThisExpression>[] = [];
  thisReferenceCache.set(object.node, references);
  for (const property of object.get("properties")) {
    let member: NodePath | undefined;
    if (property.isObjectMethod()) {
      member = property;
    } else if (property.isObjectProperty()) {
      const value = unwrapTransparentPath(property.get("value") as NodePath);
      if (value.isFunctionExpression()) member = value;
    }
    member?.traverse({
      Function(nested) {
        if (!nested.isArrowFunctionExpression()) nested.skip();
      },
      Class(nested) {
        nested.skip();
      },
      ThisExpression(reference) {
        references.push(reference);
      },
    });
  }
  return references;
}

/**
 * Every use that can run the keyed slot `holder` inline: reads through its root
 * binding, computed keys included (`getKeyedSlotUses`), and reads through
 * `this` from a sibling member of the same object literal (`getThisSlotUses`).
 * Both safety exclusions -- per-item callback and plain call -- ask this list.
 */
function getKeyedSafetyUses(
  holder: NodePath,
  access = getKeyedAccessPath(holder),
): NodePath[] {
  const uses = access === undefined ? [] : getKeyedSlotUses(access, true);
  uses.push(...getThisSlotUses(holder));
  return uses;
}

/**
 * Does `member` read `key` off `object` -- one link of a keyed-slot path?
 *
 * A static link has to name the key exactly. With `includeDynamic`, a computed
 * link whose key is decided at runtime (`renderers[node.type]`,
 * `renderers?.[key]`) matches too, because nothing rules out that it names this
 * slot. That is what keeps an object-literal component off a boundary of its
 * own when the module dispatches to it dynamically:
 *
 * ```jsx
 * const renderers = { User(node) { return <li>{suffix.value}</li>; } };
 * nodes.map((node) => renderers[node.__typename](node));
 * ```
 *
 * `User` is called once per item inside the caller's render, exactly like
 * `renderers.User(node)` would be, so a boundary in it is a variable number of
 * hooks in the caller -- "Rendered more hooks than during the previous render"
 * as soon as the list grows. The static spelling of that call was already
 * excluded; the dynamic one could not be named, so the slot kept its boundary.
 *
 * Only a link at the right depth counts, so `renderers[key](node)` reaches
 * `renderers.User` but not `renderers.group.User`, and `registry.users[key]`
 * reaches only the slots under `registry.users`.
 *
 * An optional link (`ns?.Home`, `renderers?.[key]`) is matched exactly like
 * the plain one, static or dynamic: it reaches the very same slot, and missing
 * it costs a crash -- `{show && ns?.Home()}` is as much a conditional call
 * inside the caller as `{show && ns.Home()}` is.
 */
function matchesKeyedLink(
  member: NodePath,
  object: NodePath,
  key: string,
  includeDynamic: boolean,
): boolean {
  if (!member.isMemberExpression() && !member.isOptionalMemberExpression()) return false;
  if (member.node.object !== object.node) return false;
  const name = getReadPropertyName(member.node);
  return name === key || (includeDynamic && name === undefined);
}

/**
 * The references of the binding that `const { key } = object` or
 * `const { key: Alias } = object` creates, when `object` is the node that
 * initializes that declarator; nothing otherwise.
 */
function getDestructuredSlotUses(object: NodePath, key: string): NodePath[] {
  const declarator = object.parentPath;
  if (
    declarator === null ||
    !declarator.isVariableDeclarator() ||
    declarator.node.init !== object.node ||
    !t.isObjectPattern(declarator.node.id)
  ) {
    return [];
  }
  for (const property of declarator.node.id.properties) {
    if (!t.isObjectProperty(property) || !t.isIdentifier(property.value)) continue;
    if (getPropertyKeyName(property) !== key) continue;
    const alias = declarator.scope.getBinding(property.value.name);
    return alias === undefined ? [] : alias.referencePaths.map((reference) => climbTransparentWrappers(reference));
  }
  return [];
}

/** Is `slot` the callee of a plain or optional-chained call -- `Row()`, `Row?.()`, `ns.Row!()`? */
function isPlainCallee(slot: NodePath): boolean {
  const call = slot.parentPath;
  if (call === null) return false;
  const parts = getCallParts(call.node);
  return parts !== undefined && parts.callee === slot.node;
}

/**
 * Is `path` a component-named function that the module invokes as a plain
 * function -- `Title()`, `Title?.()`, `Title!()`, `ns.Home()` -- rather than
 * (only) mounting it through JSX?
 *
 * ```jsx
 * function Title() { return <h1>{count.value}</h1>; }
 * function Outer({ show }) { return <div>{show && Title()}</div>; }
 * ```
 *
 * `Title` reads exactly like a component, but a plain call never mounts a
 * fiber: React sees only `Outer`, and `Title`'s body simply runs inside
 * `Outer`'s render. A boundary injected into it is therefore three more hooks
 * *in `Outer`*, and here they run only when `show` is true -- the conditional
 * hook call the Rules of Hooks forbid, which React reports as "Rendered more
 * hooks than during the previous render" (or "Expected static flag was
 * missing") the first time `show` flips. The render-callback exclusion
 * (`isRenderCallback`) already handled the looped variant of this -- `Row`
 * called once per item from inside `items.map(...)` -- and this is the same
 * fact stated for every call site, not just the ones inside a loop: a function
 * that is called is not a component, whatever it is named.
 *
 * The exclusion is decided from the module as a whole -- *any* plain call of the
 * function's own binding (or of its exact keyed slot) disqualifies it -- because
 * a boundary is a property of the function, not of one call site: once one
 * caller runs the body inline, a boundary inside it is wrong for that caller no
 * matter what the others do. The reads are not lost; `inspectFunction` folds
 * them into the function that makes the call (`foldDirectlyCalledRenderCallbacks`),
 * so `Outer` is the one that gets transformed and subscribes -- which is right,
 * since `Outer` is the fiber that re-renders and re-runs `Title()`.
 *
 * Deliberately narrow, in both directions:
 *
 * - Only a *component* name is affected. A `useX` hook is called as a function
 *   by definition, and its boundary is valid precisely because React runs it
 *   inside a render already in progress; hooks keep their handling unchanged.
 * - Only the function's *own* binding counts, as in `isRenderCallback`: a
 *   same-named binding in another scope cannot disqualify it, and an alias
 *   (`const T = Title; T()`) is not followed. Neither is `Title.call(...)` or
 *   `new Title()`, which are not plain calls of the binding.
 */
function isPlainCalledComponent(path: NodePath<t.Function>): boolean {
  const slot = climbTransparentWrappers(path);
  // A method is its own slot; every other function sits in its parent's.
  const holder = path.isObjectMethod() ? path : slot.parentPath;
  if (holder === null) return false;
  const access = getKeyedAccessPath(holder);
  // An object-literal slot with no root binding (an array element, a call
  // argument) can still be reached through `this` by a sibling member.
  const key = access?.keys.at(-1) ??
    (holder.isObjectProperty() || holder.isObjectMethod() ? getPropertyKeyName(holder.node) : undefined);
  if (key !== undefined) {
    return isComponentName(key) && getKeyedSafetyUses(holder, access).some(isPlainCallee);
  }
  return getOwnBindingReferences(path, holder)?.some((reference) =>
    isPlainCallee(climbTransparentWrappers(reference))
  ) ?? false;
}

/**
 * The reference paths of `path`'s own component-named binding, or `undefined`
 * when it has none -- no own binding, a non-component name, or a same-named
 * binding that belongs to some other function. `holder` is the climbed parent
 * the binding is looked up from, matching `isRenderCallback`'s own lookup.
 */
function getOwnBindingReferences(
  path: NodePath<t.Function>,
  holder: NodePath,
): NodePath[] | undefined {
  const name = getOwnBindingName(path);
  if (name === undefined || !isComponentName(name)) return undefined;
  const binding = holder.scope.getBinding(name);
  if (binding === undefined) return undefined;
  if (binding.path.node !== path.node && binding.path.node !== holder.node) return undefined;
  return binding.referencePaths;
}

/**
 * Is `path` -- already known to be plain-called -- *also* mounted through JSX
 * by its own binding (`<Title />`)? That instance loses its own boundary along
 * with the plain-called one, so `decideTransform` reports the mix rather than
 * leaving the `<Title />` instance to go stale in silence. Babel records a JSX
 * tag as an ordinary reference to the binding it names, which is what makes
 * this a plain reference walk.
 */
function isAlsoMountedThroughJsx(path: NodePath<t.Function>): boolean {
  const holder = climbTransparentWrappers(path).parentPath;
  if (holder === null || path.isObjectMethod()) return false;
  return getOwnBindingReferences(path, holder)?.some((reference) =>
    reference.isJSXIdentifier()
  ) ?? false;
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
// Whether a function is one is reachability over its callers (a function
// called from a render callback is itself one), answered iteratively: a long
// chain of helpers must not recurse once per link, nor re-walk the whole chain
// once per helper. A positive answer marks every function on the path to it;
// a negative one marks every function walked, since each was walked with all
// of its callers.
const renderCallbackMemo = new WeakMap<t.Node, boolean>();

function isRenderCallback(path: NodePath<t.Function>): boolean {
  const known = renderCallbackMemo.get(path.node);
  if (known !== undefined) return known;
  const parentOf = new Map<t.Node, t.Node | undefined>();
  const pending: Array<[NodePath<t.Function>, t.Node | undefined]> = [[path, undefined]];
  while (pending.length > 0) {
    const [current, from] = pending.pop()!;
    if (parentOf.has(current.node)) continue;
    parentOf.set(current.node, from);
    const remembered = current === path ? undefined : renderCallbackMemo.get(current.node);
    if (remembered === false) continue;
    const callers = remembered === true ? true : renderCallbackCallers(current);
    if (callers === true) {
      for (let node: t.Node | undefined = current.node; node !== undefined; node = parentOf.get(node)) {
        renderCallbackMemo.set(node, true);
      }
      return true;
    }
    for (const owner of callers) pending.push([owner, current.node]);
  }
  for (const node of parentOf.keys()) renderCallbackMemo.set(node, false);
  return false;
}

/**
 * One step of `isRenderCallback`: `true` when `path` is handed to a render
 * callback method itself, otherwise the functions that call it (whose own
 * answer then decides).
 */
function renderCallbackCallers(path: NodePath<t.Function>): true | NodePath<t.Function>[] {
  const argument = climbTransparentWrappers(path);
  const enclosing = argument.parentPath;
  if (enclosing !== null && isRenderCallbackInvocation(enclosing.node, argument.node)) return true;
  // An object method is its own keyed slot (see `getKeyedAccessPath`), so it is
  // checked as the holder itself; `items.map(ns.Row)` disqualifies `{ Row() {} }`
  // exactly as it does `{ Row: () => ... }`.
  const keyedHolder = path.isObjectMethod() ? path : enclosing;
  if (keyedHolder !== null && isKeyedRenderCallback(keyedHolder)) return true;

  const name = getOwnBindingName(path);
  if (name === undefined || enclosing === null) return [];
  const binding = enclosing.scope.getBinding(name);
  if (binding === undefined) return [];
  // Only this function's own binding may speak for it, so a same-named binding
  // from an outer scope cannot disqualify an unrelated function. The declarator
  // is compared against the climbed position for the same reason
  // `getOwnBindingName` reads the name from there: a wrapped initializer puts
  // the wrapper, not the function, directly under the declarator.
  if (binding.path.node !== path.node && binding.path.node !== enclosing.node) return [];
  const callers: NodePath<t.Function>[] = [];
  for (const reference of binding.referencePaths) {
    const slot = climbTransparentWrappers(reference);
    if (slot.parentPath !== null && isRenderCallbackInvocation(slot.parentPath.node, slot.node)) {
      return true;
    }
    // `items.map((item) => Row(item))` rather than `items.map(Row)`: both run
    // `Row` once per item inside the owner's single render pass, so both must
    // keep `Row` off a boundary of its own. `Row` called as a plain function is
    // never mounted as a fiber, so three hooks injected into it would run in a
    // loop and crash with "Rendered more hooks than during the previous render"
    // the moment the array length changes.
    const call = slot.parentPath!;
    const owner = call.getFunctionParent();
    if (owner !== null && getCallParts(call.node)?.callee === slot.node) callers.push(owner);
  }
  return callers;
}

/** The function `name`, referenced from `origin`'s scope, is bound to. */
function resolveReferencedFunction(
  origin: NodePath,
  name: string,
): NodePath<t.Function> | undefined {
  const binding = origin.scope.getBinding(name);
  // A reassigned name (`let f = a; f = b;`) holds a function chosen at run time.
  if (binding === undefined || binding.constantViolations.length > 0) return undefined;
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
 * The keyed-slot twin of `resolveReferencedFunction`: the function a static
 * member callee such as `ns.Home` / `deep.a.Home` / `Card.Header` reaches, when
 * this module defines it in one of the keyed shapes `getKeyedAccessPath`
 * names -- an object literal bound to the root (`const ns = { Home() {} }`,
 * `{ Home: () => ... }`, nested to any depth) or a member assignment
 * (`Card.Header = () => ...`).
 *
 * Needed because `isPlainCalledComponent` takes the boundary away from such a
 * slot the moment it is called (`ns.Home()`), and without resolving it here its
 * reads would reach nobody: the slot no longer subscribes, and the caller never
 * learns what it read. Anything this cannot resolve unambiguously -- a spread,
 * a computed runtime key, an import -- resolves to nothing, which leaves the
 * caller exactly as it would otherwise have been.
 */
function resolveKeyedFunction(
  origin: NodePath,
  callee: t.MemberExpression | t.OptionalMemberExpression,
): NodePath<t.Function> | undefined {
  // `this.Leaf()` from a sibling member: `this` is the object literal that
  // member belongs to (see `getThisSlotUses` for when that is syntactic).
  const chain = getStaticMemberChain(callee);
  if (chain !== undefined && t.isThisExpression(chain.root)) {
    const object = getThisObject(origin);
    return object === undefined ? undefined : resolveObjectLiteralSlot(object, chain.keys);
  }
  const access = getStaticMemberPath(callee);
  if (access === undefined) return undefined;
  const binding = origin.scope.getBinding(access.root);
  if (binding === undefined) return undefined;
  // An object literal bound directly to the root: walk the keys down through
  // nested literals.
  // A reassigned root (`let o = {...}; o = extStore`), or one whose members
  // other code rewrites, holds functions chosen at run time.
  if (binding.constantViolations.length > 0 || objectMayBeRewritten(binding)) return undefined;
  const slotUses = getKeyedSlotUses({ origin, ...access });
  if (binding.path.isVariableDeclarator()) {
    const found = resolveObjectLiteralSlot(unwrapTransparentPath(binding.path.get("init") as NodePath), access.keys);
    // ...and so is a literal's slot the module assigns again (`o.total = ext`).
    if (found !== undefined) {
      return slotUses.some((slot) => slot.parentPath?.isAssignmentExpression() === true && (slot.parentPath.node as t.AssignmentExpression).left === slot.node)
        ? undefined
        : found;
    }
  }
  // A member assignment (`Card.Header = () => ...`) anywhere in the module.
  // Only an assignment of the one exact slot counts, and only a single one:
  // two different functions assigned to the same slot are a runtime decision.
  const assigned: NodePath<t.AssignmentExpression>[] = [];
  for (const slot of slotUses) {
    const parent = slot.parentPath;
    if (
      parent !== null &&
      parent.isAssignmentExpression({ operator: "=" }) &&
      parent.node.left === slot.node
    ) {
      assigned.push(parent);
    }
  }
  const only = assigned.length === 1 ? assigned[0] : undefined;
  if (only === undefined) return undefined;
  const value = unwrapTransparentPath(only.get("right"));
  return value.isArrowFunctionExpression() || value.isFunctionExpression() ? value : undefined;
}

/**
 * The function at `keys` inside the object literal `object`, walking down
 * through nested literals. The *last* matching property wins, as it does at
 * runtime; anything that is not a literal or not a function resolves to nothing.
 */
function resolveObjectLiteralSlot(object: NodePath, keys: readonly string[]): NodePath<t.Function> | undefined {
  let container: NodePath | undefined = object;
  for (const key of keys) {
    if (container === undefined || !container.isObjectExpression()) return undefined;
    const match: NodePath | undefined = container
      .get("properties")
      .filter((property) =>
        (property.isObjectProperty() || property.isObjectMethod()) &&
        getPropertyKeyName(property.node) === key
      )
      .at(-1);
    container = match?.isObjectProperty()
      ? unwrapTransparentPath(match.get("value") as NodePath)
      : match;
  }
  if (container === undefined) return undefined;
  if (container.isObjectMethod()) return container;
  if (container.isArrowFunctionExpression() || container.isFunctionExpression()) return container;
  return undefined;
}

/**
 * The object literal a `this` written at `origin` stands for, when that is
 * syntactic: the nearest non-arrow function is a member of an object literal
 * (a method, accessor, or `function` property value) and no class sits in
 * between. The inverse of the walk `getObjectThisReferences` does.
 */
function getThisObject(origin: NodePath): NodePath<t.ObjectExpression> | undefined {
  let owner = origin.getFunctionParent();
  while (owner !== null && owner.isArrowFunctionExpression()) owner = owner.getFunctionParent();
  if (owner === null) return undefined;
  const blocker = origin.findParent((parent) => parent.node === owner!.node || parent.isClass());
  if (blocker === null || blocker.node !== owner.node) return undefined;
  if (owner.isObjectMethod()) {
    const object = owner.parentPath;
    return object.isObjectExpression() ? object : undefined;
  }
  if (!owner.isFunctionExpression()) return undefined;
  const property = climbTransparentWrappers(owner);
  const holder = property.parentPath;
  if (holder === null || !holder.isObjectProperty() || holder.node.value !== property.node) return undefined;
  const object = holder.parentPath;
  return object.isObjectExpression() ? object : undefined;
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
  // Called as a plain function somewhere in the module, so never mounted as a
  // fiber of its own -- see `isPlainCalledComponent`. Its reads are folded into
  // the caller instead, which is why this is a candidacy question (it also
  // keeps the function from being skipped as a nested boundary) rather than a
  // late veto in `decideTransform`.
  if (isPlainCalledComponent(path)) return false;
  // An object method sits in a keyed slot just like `{ Home: () => ... }`, and
  // `getObjectMethodIdentityName` has already narrowed it to a plain method;
  // the naming conventions still decide whether it is transformed.
  if (path.isFunctionDeclaration() || path.isObjectMethod()) return true;

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
      // Keyed slots: a component held in an object namespace or a
      // compound-component assignment (`Card.Header = ...`). Both are named by
      // `getKeyedIdentityName`, and both were invisible to `auto` mode while
      // they were not candidates -- no transform and no warning, even
      // when the name resolved perfectly well. The naming conventions still
      // decide what is actually transformed, so a lowercase key stays out.
      // A class field -- instance or static -- is not a candidate: it is
      // reached through `this.Row` or `Holder.Row`, which the use-site walks
      // (`isPlainCalledComponent`, `isKeyedRenderCallback`) cannot follow, so a
      // field called as a function (`this.Header()`) or passed per item
      // (`items.map(this.Row)`) would get a hook boundary inside a class
      // render. Same resolution as `this.Row = ...`: transform nothing.
      parent.isObjectProperty() ||
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
// the boundary design (development/design/use-signals-boundary-design.md), so a
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

/**
 * Resolve a `.value` accessor when its computed key is a constant local string,
 * such as `const valueKey = "value"; signal[valueKey]`. General computed keys
 * remain dynamic and are not treated as proven signal reads.
 */
function getTrackedReadPropertyName(
  path: NodePath<t.MemberExpression | t.OptionalMemberExpression>,
): string | undefined {
  const direct = getReadPropertyName(path.node);
  if (direct !== undefined || !path.node.computed) return direct;
  const property = unwrapTransparent(path.node.property);
  if (!t.isIdentifier(property)) return undefined;
  const binding = path.scope.getBinding(property.name);
  if (binding?.kind !== "const" || !binding.constant || !binding.path.isVariableDeclarator()) {
    return undefined;
  }
  const init = binding.path.get("init");
  if (!init.node) return undefined;
  const value = unwrapTransparent(init.node);
  return t.isStringLiteral(value) ? value.value : undefined;
}

// Without an explicit signal `.value` earlier in the same receiver chain,
// these spellings are common DOM/ref fields and do not identify a signal.
// Once a signal read is already present (`holder.value.current.value`), keep
// the inner read eligible: a signal may legitimately be stored under any key.
const nonSignalValueReceivers = new Set(["target", "currentTarget", "current"]);

function hasTrackedValuePrefix(
  path: NodePath<t.MemberExpression | t.OptionalMemberExpression>,
): boolean {
  let object = path.get("object");
  while (object.isMemberExpression() || object.isOptionalMemberExpression()) {
    if (getTrackedReadPropertyName(object) === "value") return true;
    object = object.get("object");
  }
  return false;
}

function isNonSignalValueReceiver(
  path: NodePath<t.MemberExpression | t.OptionalMemberExpression>,
): boolean {
  const object = path.get("object");
  if (!object.isMemberExpression() && !object.isOptionalMemberExpression()) return false;
  const name = getReadPropertyName(object.node);
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

/** A JSX callback's execution is owned and scheduled by another component. */
function isRenderPropCallback(path: NodePath): boolean {
  const container = climbTransparentWrappers(path).parentPath;
  if (container === null || !container.isJSXExpressionContainer()) return false;
  const parent = container.parentPath;
  if (parent === null) return false;
  if (parent.isJSXElement() || parent.isJSXFragment()) return true;
  if (!parent.isJSXAttribute()) return false;
  const name = parent.get("name");
  return name.isJSXIdentifier() && !/^on[A-Z]/.test(name.node.name);
}

function containsSyntacticValueRead(path: NodePath): boolean {
  let found = false;
  const inspect = (member: NodePath<t.MemberExpression | t.OptionalMemberExpression>): void => {
    if (getTrackedReadPropertyName(member) === "value") found = true;
  };
  if (path.isMemberExpression() || path.isOptionalMemberExpression()) inspect(path);
  path.traverse({
    // A function in a default (`onPick = () => count.value`) reads only when
    // called later, not while the parameter initializer runs.
    Function(nested) { nested.skip(); },
    MemberExpression: inspect,
    OptionalMemberExpression: inspect,
  });
  return found;
}

function warnUncapturedParameterRead(
  functionPath: NodePath<t.Function>,
  options: InternalTransformOptions,
): void {
  reportWarning(
    options,
    "RFGS004",
    functionPath,
    "A .value read remains in a function parameter initializer, which runs before the top-level " +
      "capture Hook. Move the read into the function body so managed tracking can capture it safely.",
  );
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

/**
 * Is `node` (at `path`) a `.value` read that counts as part of `functionPath`'s
 * render -- the one rule both `inspectFunction` (does this function subscribe
 * at all?) and `relocateTrackedParameters` (does this parameter have to move
 * behind the boundary?) apply, so the two can never disagree about what a
 * tracked read is.
 */
function isTrackedValueRead(
  node: t.MemberExpression | t.OptionalMemberExpression,
  path: NodePath,
  functionPath: NodePath<t.Function>,
): boolean {
  const memberPath = path as NodePath<t.MemberExpression | t.OptionalMemberExpression>;
  if (getTrackedReadPropertyName(memberPath) !== "value") {
    return false;
  }
  if (isNonSignalValueReceiver(memberPath) && !hasTrackedValuePrefix(memberPath)) return false;
  if (isWriteTarget(path)) return isReadModifyingTrackedTarget(memberPath, functionPath);
  return !isDeferredReadContext(path, functionPath);
}

/**
 * An update reads its old target value, and deleting a nested proxy property
 * reads the proxy base even though both expressions are syntactically write
 * targets. The codegen captures the complete operation so accessors, computed
 * keys, Proxy traps, and the operator's result keep their native evaluation.
 */
function isReadModifyingTrackedTarget(
  member: NodePath<t.MemberExpression | t.OptionalMemberExpression>,
  functionPath: NodePath<t.Function>,
): boolean {
  if (isDeferredReadContext(member, functionPath)) return false;
  let target: NodePath = member;
  while (target.parentPath !== null) {
    const parent: NodePath = target.parentPath;
    if (
      (parent.isMemberExpression() || parent.isOptionalMemberExpression()) &&
      parent.get("object").node === target.node
    ) {
      target = parent;
      continue;
    }
    if (
      (parent.isTSAsExpression() || parent.isTSTypeAssertion() || parent.isTSNonNullExpression()) &&
      parent.get("expression").node === target.node
    ) {
      target = parent;
      continue;
    }
    break;
  }
  const operation = target.parentPath;
  if (operation?.isUpdateExpression() && operation.get("argument").node === target.node) return true;
  return operation?.isUnaryExpression({ operator: "delete" }) &&
    operation.get("argument").node === target.node && target.node !== member.node;
}

/**
 * A computed member with a runtime key can still resolve to a signal's `value`
 * accessor. Since the key is not statically known, capture the complete member
 * expression and let the runtime record an actual signal read if one occurs.
 */
function isPotentialDynamicMemberRead(
  node: t.MemberExpression | t.OptionalMemberExpression,
  path: NodePath,
  functionPath: NodePath<t.Function>,
): boolean {
  const memberPath = path as NodePath<t.MemberExpression | t.OptionalMemberExpression>;
  if (!node.computed || getTrackedReadPropertyName(memberPath) !== undefined) return false;
  const property = unwrapTransparent(node.property);
  if (
    t.isNumericLiteral(property) ||
    t.isBigIntLiteral(property) ||
    t.isBooleanLiteral(property) ||
    t.isNullLiteral(property)
  ) return false;
  if (isWriteTarget(path)) return false;
  return !isDeferredReadContext(path, functionPath);
}

/**
 * One function's own findings plus the functions its render runs that must be
 * folded in. Folding is a graph reachability question, so it is answered
 * iteratively over memoized per-function scans rather than by recursing into
 * each target: a long helper chain neither overflows the stack nor re-walks
 * every callee once per ancestor.
 */
interface FoldEdge {
  target: NodePath<t.Function>;
  /** Does the target's JSX count as the caller's own (render callbacks)? */
  jsx: boolean;
}

interface FunctionScan {
  own: FunctionInspection;
  edges: FoldEdge[];
}

/** Per function: does a read lie anywhere along its fold edges? (see `inspectFunction`) */
const readsReachable = new WeakMap<t.Node, boolean>();

/** Scans of functions inspected for their synchronous body only, per node. */
const synchronousScans = new WeakMap<t.Node, FunctionScan>();

function synchronousScan(
  functionPath: NodePath<t.Function>,
  importSource: string,
  managedRuntimeSource: string,
  reactImportSource: string,
): FunctionScan {
  let scan = synchronousScans.get(functionPath.node);
  if (scan === undefined) {
    scan = scanFunction(functionPath, importSource, managedRuntimeSource, reactImportSource, true);
    synchronousScans.set(functionPath.node, scan);
  }
  return scan;
}

function inspectFunction(
  functionPath: NodePath<t.Function>,
  importSource: string,
  managedRuntimeSource: string,
  reactImportSource: string,
  // Functions the fold must not enter: the function being inspected itself,
  // and any owner the caller has already accounted for.
  excluded: ReadonlySet<t.Node> = new Set([functionPath.node]),
  synchronousBodyOnly = false,
): FunctionInspection {
  const root = synchronousBodyOnly
    ? synchronousScan(functionPath, importSource, managedRuntimeSource, reactImportSource)
    : scanFunction(functionPath, importSource, managedRuntimeSource, reactImportSource, false);
  const inspection = { ...root.own };
  const rootNode = functionPath.node;
  // With only the function itself excluded, what one query learns holds for
  // every function it walked through, so a chain of N helpers costs O(N)
  // overall rather than O(N^2): a read found marks the whole path to it, and a
  // negative answer marks everything reachable (all of it was walked).
  const memoizable = excluded.size === 1 && excluded.has(rootNode);
  if (!inspection.readsValue && root.edges.length > 0) {
    const parentOf = new Map<t.Node, t.Node>();
    const seen = new Set(excluded);
    const pending: Array<[NodePath<t.Function>, t.Node]> = root.edges.map((edge) => [edge.target, rootNode]);
    let found = false;
    while (pending.length > 0) {
      const [target, from] = pending.pop()!;
      if (seen.has(target.node)) continue;
      seen.add(target.node);
      parentOf.set(target.node, from);
      const known = memoizable ? readsReachable.get(target.node) : undefined;
      const scan = known === undefined
        ? synchronousScan(target, importSource, managedRuntimeSource, reactImportSource)
        : undefined;
      if (known === true || scan?.own.readsValue === true) {
        if (memoizable) {
          for (let node: t.Node | undefined = target.node; node !== undefined && node !== rootNode; node = parentOf.get(node)) {
            readsReachable.set(node, true);
          }
        }
        found = true;
        break;
      }
      if (scan !== undefined) for (const next of scan.edges) pending.push([next.target, target.node]);
    }
    inspection.readsValue = found;
    if (!found && memoizable) {
      for (const node of seen) if (node !== rootNode) readsReachable.set(node, false);
    }
  }
  if (!inspection.containsJSX && root.edges.some((edge) => edge.jsx)) {
    const seen = new Set(excluded);
    const pending = root.edges.filter((edge) => edge.jsx);
    while (pending.length > 0 && !inspection.containsJSX) {
      const edge = pending.pop()!;
      if (seen.has(edge.target.node)) continue;
      seen.add(edge.target.node);
      const scan = synchronousScan(edge.target, importSource, managedRuntimeSource, reactImportSource);
      if (scan.own.containsJSX) inspection.containsJSX = true;
      for (const next of scan.edges) if (next.jsx) pending.push(next);
    }
  }
  return inspection;
}

function scanFunction(
  functionPath: NodePath<t.Function>,
  importSource: string,
  managedRuntimeSource: string,
  reactImportSource: string,
  synchronousBodyOnly: boolean,
): FunctionScan {
  const inspection: FunctionInspection = {
    containsJSX: false,
    readsValue: false,
    hasSignalTrackingCall: false,
    hasUseManagedSignalsCall: false,
  };
  const edges: FoldEdge[] = [];
  // A helper called from many sites is one edge, not one per call.
  const edgeIndex = new Map<t.Node, FoldEdge>();
  const checkedHelpers = new Set<t.Node>();
  const addEdge = (target: NodePath<t.Function>, jsx: boolean): void => {
    if (target.node === functionPath.node) return;
    const known = edgeIndex.get(target.node);
    if (known !== undefined) {
      if (jsx) known.jsx = true;
      return;
    }
    const edge = { target, jsx };
    edgeIndex.set(target.node, edge);
    edges.push(edge);
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
    // Only one argument slot can ever be the callback (see
    // `getRenderCallbackArgument`), so there is no need to scan the rest.
    const argument = getRenderCallbackArgument(call.node);
    if (argument === undefined) return;
    // The wrapper node is what occupies the argument slot, so the position
    // check compares against `argument` itself; only the name has to be read
    // from underneath a `Row!` / `Row as Fn` / `Row satisfies Fn` wrapper.
    if (!isRenderCallbackInvocation(call.node, argument)) return;
    const reference = unwrapTransparent(argument);
    let target: NodePath<t.Function> | undefined;
    if (t.isIdentifier(reference)) {
      target = resolveReferencedFunction(call, reference.name);
    } else {
      const argumentPath = call.get("arguments").find((candidate) => candidate.node === argument);
      if (argumentPath?.isArrowFunctionExpression() || argumentPath?.isFunctionExpression()) {
        target = argumentPath;
      }
    }
    // An async callback only executes its synchronous prefix at this callsite;
    // a generator executes none of its body until iteration. Folding either
    // body into the caller would claim reads outside the active capture.
    if (target === undefined || target.node.async || target.node.generator) return;
    addEdge(target, true);
  };

  // The direct-call twin of the fold above: `items.map((item) => Row(item))`
  // runs `Row` inside this render without React ever mounting it, so `Row` is
  // kept off a boundary of its own (see `isCalledFromRenderCallback`) and its
  // reads have to reach the component that actually runs them.
  //
  // The same holds for a component-named function called anywhere else in this
  // render -- `{show && Title()}` -- which `isPlainCalledComponent` keeps off a
  // boundary for the same reason: the call runs `Title`'s body as part of this
  // function, so this function is the one that has to subscribe to its reads.
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
    //
    // A static member callee (`ns.Home()`, `ns?.Home()`, a sibling's
    // `this.Home()`) is the keyed-slot form of the same call, and is read for
    // its last key. Only the plain-called-component route reaches it: the
    // render-callback demotion of a hook is by own binding
    // (`isCalledFromRenderCallback`), so a keyed `ns.useX()` keeps its boundary.
    const member = t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee) ? callee : undefined;
    const chain = member === undefined ? undefined : getStaticMemberChain(member);
    const name = t.isIdentifier(callee)
      ? callee.name
      : chain !== undefined && (t.isIdentifier(chain.root) || t.isThisExpression(chain.root))
        ? chain.keys.at(-1)
        : undefined;
    if (name === undefined || (!isComponentName(name) && !isHookName(name))) return;
    if (!t.isIdentifier(callee) && !isComponentName(name)) return;
    const owner = call.getFunctionParent();
    if (owner === null) return;
    if (owner.node === functionPath.node || !isRenderCallback(owner)) {
      // Not inside a render callback, so only the plain-called-component route
      // can apply. A hook-shaped callee keeps its own boundary there (only the
      // render-callback position demotes a hook), so it has nothing to fold.
      if (!isComponentName(name)) return;
      // A call from an event handler, an effect, or an async body runs after
      // this render has finished collecting, so its reads are no more this
      // render's than a `.value` read written there directly would be
      // (`recordValueRead` applies the same test).
      if (isDeferredReadContext(call, functionPath)) return;
    }
    const target = t.isIdentifier(callee)
      ? resolveReferencedFunction(call, callee.name)
      : member !== undefined
        ? resolveKeyedFunction(call, member)
        : undefined;
    if (target === undefined || target.node.async || target.node.generator) return;
    addEdge(target, true);
  };

  // Ordinary module-local helpers are part of the caller's synchronous render
  // when invoked directly. Unlike components and custom Hooks, a plain helper
  // cannot own a React tracking Hook of its own, so leaving its reads outside
  // the caller's inspection silently misses `mode: "auto"` transforms.
  const foldDirectlyCalledHelpers = (
    call: NodePath<t.CallExpression> | NodePath<t.OptionalCallExpression>,
  ): void => {
    if (isDeferredReadContext(call, functionPath)) return;
    const callee = unwrapTransparent(call.node.callee);
    const member = t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)
      ? callee
      : undefined;
    const chain = member === undefined ? undefined : getStaticMemberChain(member);
    const name = t.isIdentifier(callee) ? callee.name : chain?.keys.at(-1);
    if (name === undefined || isComponentName(name) || isHookName(name)) return;
    const target = t.isIdentifier(callee)
      ? resolveReferencedFunction(call, name)
      : member === undefined ? undefined : resolveKeyedFunction(call, member);
    // A helper called from many sites is checked once, not once per call by
    // `functionCallsHook`.
    if (target === undefined || edgeIndex.has(target.node) || checkedHelpers.has(target.node)) return;
    checkedHelpers.add(target.node);
    if (target.node.async || target.node.generator || functionCallsHook(target)) return;
    addEdge(target, false);
  };

  // `items.filter(isBig)`: a named synchronous function handed to a call
  // runs in this render just like an inline callback. Hook calls are skipped:
  // their callbacks belong to React, not to this render's reads.
  const foldFunctionArguments = (
    call: NodePath<t.CallExpression> | NodePath<t.OptionalCallExpression>,
  ): void => {
    if (callNameIsHook(call.node.callee)) return;
    if (isDeferredReadContext(call, functionPath)) return;
    for (const argument of call.get("arguments") as NodePath[]) {
      if (!argument.isIdentifier()) continue;
      const target = resolveReferencedFunction(argument, argument.node.name);
      if (target === undefined || edgeIndex.has(target.node) || checkedHelpers.has(target.node)) continue;
      checkedHelpers.add(target.node);
      if (target.node.async || target.node.generator || functionCallsHook(target)) continue;
      addEdge(target, false);
    }
  };

  const recordValueRead = (
    node: t.MemberExpression | t.OptionalMemberExpression,
    path: NodePath,
  ): void => {
    // Unknown computed members are capture candidates only after another
    // statically recognized read (or explicit transform mode) selects this
    // function. Treating every `items[index]` as an auto-detection signal
    // would inject Hooks into ordinary components.
    if (isTrackedValueRead(node, path, functionPath)) inspection.readsValue = true;
  };

  functionPath.traverse({
    // A nested function is not a render read until a known synchronous call
    // site runs it. The call-site visitors below fold recognized helpers and
    // render callbacks into this inspection; unknown callbacks stay outside
    // the automatic guarantee instead of creating a stale captured closure.
    Function(path) {
      if (
        synchronousBodyOnly ||
        isNestedTrackingBoundary(path, reactImportSource) ||
        isRenderPropCallback(path)
      ) path.skip();
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
      foldDirectlyCalledHelpers(path);
      foldFunctionArguments(path);
      // Compared by node, as the equivalent checks in `isDeferredReadContext`
      // and `foldDirectlyCalledRenderCallbacks` are: a re-crawled scope can hand
      // back a fresh NodePath for the very same function.
      if (path.getFunctionParent()?.node !== functionPath.node) return;
      const callee = path.get("callee");
      if (isSignalTrackingCallee(functionPath, callee, importSource)) {
        inspection.hasSignalTrackingCall = true;
      }
      if (
        (callee.isIdentifier() && isNamedUseManagedSignalsImport(
          functionPath,
          callee.node.name,
          managedRuntimeSource,
        )) ||
        (callee.isMemberExpression() &&
          (getReadPropertyName(callee.node) === "useManagedSignals" ||
            getReadPropertyName(callee.node) === "useSignalCapture") &&
          callee.get("object").isIdentifier() &&
          isNamespaceUseManagedSignalsImport(
            functionPath,
            (callee.get("object") as NodePath<t.Identifier>).node.name,
            managedRuntimeSource,
          ))
      ) {
        inspection.hasUseManagedSignalsCall = true;
      }
    },
    OptionalCallExpression(path) {
      foldReferencedRenderCallbacks(path);
      foldDirectlyCalledRenderCallbacks(path);
      foldDirectlyCalledHelpers(path);
      foldFunctionArguments(path);
    },
  });
  return { own: inspection, edges };
}

function findRuntimeImports(
  programPath: NodePath<t.Program>,
  runtimeSource: string,
  importedName: "useSignalTracking" | "useManagedSignals" | "useSignalCapture",
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
        t.isIdentifier(specifier.node.imported, { name: importedName })
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
  importedName: "useSignalTracking" | "useManagedSignals" | "useSignalCapture",
  functionPath: NodePath<t.Function>,
): RuntimeImport {
  const local = functionPath.scope.generateUidIdentifier(importedName);
  const declaration = t.importDeclaration(
    [t.importSpecifier(t.cloneNode(local), t.identifier(importedName))],
    t.stringLiteral(runtimeSource),
  );
  const imports = programPath.get("body").filter((path) => path.isImportDeclaration());
  const insertedPaths = imports.length === 0
    ? programPath.unshiftContainer("body", declaration)
    : imports.at(-1)!.insertAfter(declaration);
  const inserted = insertedPaths[0];
  if (inserted === undefined || !inserted.isImportDeclaration()) {
    throw new Error(`Failed to insert the ${importedName} import`);
  }
  programPath.scope.registerDeclaration(inserted);
  const specifier = inserted.get("specifiers")[0];
  if (specifier === undefined || !specifier.isImportSpecifier()) {
    throw new Error(`Failed to register the ${importedName} import`);
  }
  return { identifier: local, bindingPath: specifier };
}

/**
 * Is `statements`' first entry a bare zero-argument call whose callee resolves
 * to `useSignalTracking`, with `allowBarrel` controlling whether a barrel/re-export
 * chain counts (see `isSignalTrackingCallee`)? Shared by `isExplicitSignalTracking`
 * (`allowBarrel: false`, the verified boundary) and
 * `isUnverifiableBarrelSignalTracking` (`allowBarrel: true`, to detect the exact
 * call the former rejects).
 */
function isFirstStatementSignalTrackingCall(
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
  return isSignalTrackingCallee(functionPath, callee, importSource, allowBarrel);
}

function isExplicitSignalTracking(
  functionPath: NodePath<t.Function>,
  statements: NodePath<t.Statement>[],
  importSource: string,
): boolean {
  return isFirstStatementSignalTrackingCall(functionPath, statements, importSource, false);
}

/**
 * The named import specifier the absorbed explicit `useSignalTracking()` call resolves
 * to, when the call is a bare identifier bound by one. `applyManaged` replaces
 * that call with its own store declaration, which can leave the import behind
 * with nothing referencing it -- so `Program.exit` needs the specifier to check
 * and drop. A namespace import is deliberately not returned: the namespace
 * object may be used for other exports of the same module.
 */
function getAbsorbedSignalTrackingImport(
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

// A call the transform cannot verify as this library's own `useSignalTracking` --
// because a single-file transform cannot follow the re-export chain to
// confirm the barrel target -- can still be written in exactly the shape of a
// deliberate opt-in: the first statement, zero arguments, no different from
// `isExplicitSignalTracking`'s own shape. Left unflagged, that call makes
// `hasSignalTrackingCall` true (`isSignalTrackingCallee` is barrel-permissive there,
// see `inspectFunction`) while `explicit` stays false, so the component is
// silently kept on the bare/best-effort boundary: no transform, no directive,
// and -- without this check -- no warning telling the author why. `explicit`
// is passed in rather than recomputed so this only does the extra
// barrel-permissive walk when the direct-import check already failed.
function isUnverifiableBarrelSignalTracking(
  functionPath: NodePath<t.Function>,
  statements: NodePath<t.Statement>[],
  importSource: string,
  explicit: boolean,
): boolean {
  if (explicit) return false;
  return isFirstStatementSignalTrackingCall(functionPath, statements, importSource, true);
}

// Barrel resolution can't be verified, so this is valid-but-unconfirmable
// code, not invalid code: warn, matching the `console.warn` convention Babel
// plugins use for non-fatal diagnostics, rather than `path.buildCodeFrameError`
// thrown outright (reserved for the genuinely invalid async/generator case
// below).
/**
 * A nested function is inspected once on its own and again as part of each
 * enclosing function, so the same site can be reached more than once in a
 * single transform. Report each message once per node.
 */
const reportedWarnings = new WeakMap<t.Node, Set<string>>();

/**
 * Builds the diagnostic only once it is known to be reported. The message
 * carries the stable ID, the code frame comes from `path`, and `diagnosticId`
 * lets a bundler adapter match the warning against `diagnostics.errorOn`
 * without parsing its text.
 */
function reportWarning(
  options: InternalTransformOptions,
  id: DiagnosticId,
  path: NodePath,
  text: string,
): void {
  const message = `[react-fine-grained-signals] ${id}: ${text}`;
  let reported = reportedWarnings.get(path.node);
  if (reported === undefined) reportedWarnings.set(path.node, reported = new Set());
  if (reported.has(message)) return;
  reported.add(message);
  const warning = Object.assign(path.buildCodeFrameError(message), { diagnosticId: id }) as Error & {
    diagnosticId: DiagnosticId;
    loc?: { filename?: string; line: number; column: number };
  };
  const start = path.node.loc?.start;
  if (start !== undefined) {
    warning.loc = {
      line: start.line,
      column: start.column,
    };
  }
  if (options.warn !== undefined) {
    options.warn(warning);
  } else {
    console.warn(warning.message);
  }
}

function warnUntrackedRenderPropRead(
  attribute: NodePath<t.JSXAttribute>,
  options: InternalTransformOptions,
): void {
  reportWarning(
    options,
    "RFGS003",
    attribute,
    "This JSX callback prop reads a signal but its execution owner cannot be proven by a single-file transform. " +
      "The callback may run outside the current component's render tracking boundary. Move the read into a " +
      "tracked component or use an explicit signal-value hook in the component that renders the result.",
  );
}

function warnUntrackedChildrenCallbackRead(
  expression: NodePath<t.JSXExpressionContainer>,
  options: InternalTransformOptions,
): void {
  reportWarning(
    options,
    "RFGS003",
    expression,
    "This JSX children callback reads a signal but its execution owner cannot be proven by a single-file transform. " +
      "The callback may run outside the current component's render tracking boundary. Move the read into a " +
      "tracked component or use an explicit signal-value hook in the component that renders the result.",
  );
}

type SignalControlFlowName = "For" | "Index" | "Match" | "Show" | "Switch";
type SignalControlFlowImport = { kind: "namespace" } | { kind: "component"; name: SignalControlFlowName };

const signalControlFlowNames = new Set<SignalControlFlowName>(["For", "Index", "Match", "Show", "Switch"]);

/**
 * Resolve an RFSG control-flow export from a value binding, rather than from
 * the JSX spelling. This deliberately follows only immutable local aliases and
 * statically named namespace members; a same-named local component or dynamic
 * member must keep the ordinary callback warning.
 */
function resolveSignalControlFlowImport(
  origin: NodePath,
  name: string,
  importSource: string,
  seen = new Set<object>(),
): SignalControlFlowImport | undefined {
  const binding = origin.scope.getBinding(name);
  if (binding === undefined || seen.has(binding) || binding.constantViolations.length > 0) return undefined;
  seen.add(binding);
  const bindingPath = binding.path;
  if (bindingPath.isImportNamespaceSpecifier()) {
    const declaration = bindingPath.parentPath;
    return declaration.isImportDeclaration() && declaration.node.importKind !== "type" &&
        declaration.node.source.value === `${importSource}/utils`
      ? { kind: "namespace" }
      : undefined;
  }
  if (bindingPath.isImportSpecifier()) {
    const declaration = bindingPath.parentPath;
    if (
      !declaration.isImportDeclaration() || declaration.node.importKind === "type" ||
      bindingPath.node.importKind === "type" || declaration.node.source.value !== `${importSource}/utils`
    ) return undefined;
    const imported = bindingPath.node.imported;
    if (!t.isIdentifier(imported) || !signalControlFlowNames.has(imported.name as SignalControlFlowName)) return undefined;
    return { kind: "component", name: imported.name as SignalControlFlowName };
  }
  if (!bindingPath.isVariableDeclarator() || !binding.constant) return undefined;
  const init = bindingPath.get("init");
  if (!init.isExpression()) return undefined;
  const value = unwrapTransparentPath(init);
  const id = bindingPath.get("id");
  if (value.isIdentifier()) {
    const resolved = resolveSignalControlFlowImport(value, value.node.name, importSource, seen);
    if (!id.isObjectPattern()) return resolved;
    if (resolved?.kind !== "namespace") return undefined;
    // `const { Show: If } = utils` is a value alias too. Resolve only a simple
    // static property binding from the verified RFSG utils namespace.
    for (const propertyPath of id.get("properties")) {
      if (!propertyPath.isObjectProperty() || propertyPath.node.computed) continue;
      const propertyValue = propertyPath.get("value");
      if (!propertyValue.isIdentifier() || propertyValue.node.name !== name) continue;
      const key = propertyPath.get("key");
      const property = key.isIdentifier() ? key.node.name : key.isStringLiteral() ? key.node.value : undefined;
      return property !== undefined && signalControlFlowNames.has(property as SignalControlFlowName)
        ? { kind: "component", name: property as SignalControlFlowName }
        : undefined;
    }
    return undefined;
  }
  if (value.isMemberExpression() && !value.node.computed && value.get("property").isIdentifier()) {
    const base = value.get("object");
    if (!base.isIdentifier()) return undefined;
    const namespace = resolveSignalControlFlowImport(base, base.node.name, importSource, seen);
    const propertyPath = value.get("property");
    if (!propertyPath.isIdentifier()) return undefined;
    const property = propertyPath.node.name;
    return namespace?.kind === "namespace" && signalControlFlowNames.has(property as SignalControlFlowName)
      ? { kind: "component", name: property as SignalControlFlowName }
      : undefined;
  }
  return undefined;
}

function signalControlFlowTagName(
  tag: NodePath<t.JSXIdentifier | t.JSXMemberExpression>,
  importSource: string,
): SignalControlFlowName | undefined {
  if (tag.isJSXIdentifier()) {
    const resolved = resolveSignalControlFlowImport(tag, tag.node.name, importSource);
    return resolved?.kind === "component" ? resolved.name : undefined;
  }
  const parts: string[] = [];
  let current: NodePath = tag;
  while (current.isJSXMemberExpression()) {
    const property = current.get("property");
    if (!property.isJSXIdentifier()) return undefined;
    parts.unshift(property.node.name);
    current = current.get("object");
  }
  if (!current.isJSXIdentifier()) return undefined;
  const resolved = resolveSignalControlFlowImport(current, current.node.name, importSource);
  if (resolved?.kind !== "namespace") return undefined;
  if (parts.length !== 1 || !signalControlFlowNames.has(parts[0] as SignalControlFlowName)) return undefined;
  return parts[0] as SignalControlFlowName;
}

function isOwnedBySignalControlFlow(
  callbackSite: NodePath,
  propName: string | undefined,
  importSource: string,
): boolean {
  let element: NodePath<t.JSXElement> | undefined;
  if (callbackSite.parentPath?.isJSXElement()) {
    element = callbackSite.parentPath;
  } else if (callbackSite.isJSXAttribute() || callbackSite.parentPath?.isJSXAttribute()) {
    const attribute = callbackSite.isJSXAttribute() ? callbackSite : callbackSite.parentPath!;
    const opening = attribute.parentPath;
    if (opening?.isJSXOpeningElement() && opening.parentPath?.isJSXElement()) element = opening.parentPath;
  }
  if (element === undefined) return false;
  const opening = element.get("openingElement");
  const namePath = opening.get("name");
  if (!namePath.isJSXIdentifier() && !namePath.isJSXMemberExpression()) return false;
  const owner = signalControlFlowTagName(namePath, importSource);
  if (owner === undefined) return false;
  if (propName !== undefined) {
    if (propName === "children") return owner === "Show" || owner === "For" || owner === "Index" || owner === "Match";
    return owner === "For" && propName === "by";
  }
  if (owner === "Show" || owner === "For" || owner === "Index") return true;
  if (owner !== "Match") return false;
  // Match is declarative; its branch callback is invoked by its nearest
  // enclosing RFSG Switch, not by Match itself.
  const parent = element.parentPath;
  if (parent === null || !parent.isJSXElement()) return false;
  const parentName = parent.get("openingElement.name");
  return (parentName.isJSXIdentifier() || parentName.isJSXMemberExpression()) &&
    signalControlFlowTagName(parentName, importSource) === "Switch";
}

type StaticConstObjectPattern = {
  properties: Array<
    | { key: t.Identifier; id: t.Identifier }
    | { key: t.Identifier; pattern: StaticConstObjectPattern }
  >;
};

function getStaticConstDestructuredBindings(
  declarator: NodePath<t.VariableDeclarator>,
): StaticConstObjectPattern | undefined {
  if (
    !declarator.parentPath.isVariableDeclaration({ kind: "const" }) ||
    !declarator.get("id").isObjectPattern()
  ) return undefined;
  const buildPattern = (pattern: NodePath<t.ObjectPattern>): StaticConstObjectPattern | undefined => {
    if (pattern.node.typeAnnotation != null || pattern.node.properties.length === 0) return undefined;
    const properties: StaticConstObjectPattern["properties"] = [];
    for (const property of pattern.get("properties")) {
      if (!property.isObjectProperty() || property.node.computed || !t.isIdentifier(property.node.key)) {
        return undefined;
      }
      const key = t.cloneNode(property.node.key);
      const value = property.get("value");
      if (value.isIdentifier() && value.node.typeAnnotation == null) {
        const binding = value.scope.getBinding(value.node.name);
        if (binding?.kind !== "const" || !binding.constant || binding.constantViolations.length !== 0) {
          return undefined;
        }
        properties.push({ key, id: t.cloneNode(value.node) });
      } else if (value.isObjectPattern()) {
        const nested = buildPattern(value);
        if (nested === undefined) return undefined;
        properties.push({ key, pattern: nested });
      } else {
        return undefined;
      }
    }
    return { properties };
  };
  return buildPattern(declarator.get("id") as NodePath<t.ObjectPattern>);
}

function inspectKnownRenderPropReads(
  functionPath: NodePath<t.Function>,
  options: InternalTransformOptions,
  reactImportSource: string,
): void {
  if (options.mode === "manual" && !hasOwnedLeadingComment(functionPath, useSignalTrackingComment)) return;
  functionPath.traverse({
    JSXExpressionContainer(expression) {
      if (!expression.parentPath.isJSXElement() && !expression.parentPath.isJSXFragment()) return;
      const callback = expression.get("expression");
      let target: NodePath<t.Function> | undefined;
      if (callback.isArrowFunctionExpression() || callback.isFunctionExpression()) {
        target = callback;
      } else if (callback.isIdentifier()) {
        target = resolveReferencedFunction(expression, callback.node.name);
      }
      if (target === undefined || isOwnedBySignalControlFlow(expression, undefined, options.importSource)) return;
      const reads = inspectFunction(
        target,
        options.importSource,
        `${options.importSource}/runtime`,
        reactImportSource,
        new Set([functionPath.node]),
        true,
      ).readsValue;
      if (reads) warnUntrackedChildrenCallbackRead(expression, options);
    },
    JSXAttribute(attribute) {
      const name = attribute.get("name");
      if (!name.isJSXIdentifier() || /^on[A-Z]/.test(name.node.name)) return;
      const value = attribute.get("value");
      if (!value.isJSXExpressionContainer()) return;
      const expression = value.get("expression");
      const propName = name.node.name;
      if (isOwnedBySignalControlFlow(attribute, propName, options.importSource)) return;
      let target: NodePath<t.Function> | undefined;
      if (expression.isArrowFunctionExpression() || expression.isFunctionExpression()) {
        target = expression;
      } else if (expression.isIdentifier()) {
        target = resolveReferencedFunction(attribute, expression.node.name);
      }
      if (target === undefined || target.node.async || target.node.generator) {
        // Deferred callbacks are outside this transform's proven ownership
        // model, whether or not their signal reads are syntactically visible.
        if (target !== undefined) warnUntrackedRenderPropRead(attribute, options);
        return;
      }
      const reads = inspectFunction(
        target,
        options.importSource,
        `${options.importSource}/runtime`,
        reactImportSource,
        new Set([functionPath.node]),
        true,
      ).readsValue;
      if (reads) warnUntrackedRenderPropRead(attribute, options);
    },
    // Destructuring from a tracked source is captured by the managed pass
    // (static expansion or a captured pattern), so it needs no warning here;
    // a pattern whose initializer calls a Hook is reported by that pass.
  });
}

function warnUnverifiableBarrelSignalTracking(
  path: NodePath<t.Function>,
  importSource: string,
  options: InternalTransformOptions,
): void {
  reportWarning(
    options,
    "RFGS005",
    path,
    `This useSignalTracking() call cannot be verified as "${importSource}"'s own export: it resolves ` +
      "only through a barrel/re-export module, and a single-file transform cannot follow that " +
      "chain to confirm the target. The component stays on the bare, best-effort useSignalTracking() " +
      `boundary. Import useSignalTracking directly from "${importSource}" ` +
      "instead to get the verified boundary.",
  );
}

// An `@signalTracking` annotation is only actionable once the transform can name
// the function it sits on: the boundary is attached to a component or hook
// identity. A component returned straight out of a HOC has no name of its own
// but does inherit the factory's (`getIdentityFactory`), and a component held
// in a keyed slot takes its key's (`getKeyedIdentityName`), so what is left
// here is the remainder those cannot reach -- a factory returning a factory
// (`(a) => (b) => (props) => <p />`), where the middle function has no name to
// inherit either, or a name that resolves but is neither PascalCase nor `useX`.
// Left silent, such an annotation reads as an opt-in that simply never
// happened. Warn instead, matching the barrel case above.
function warnUnnamedSignalTrackingAnnotation(
  path: NodePath<t.Function>,
  options: InternalTransformOptions,
): void {
  reportWarning(
    options,
    "RFGS006",
    path,
    "This @signalTracking annotation is ignored: the transform could not resolve a component " +
      "or hook identity for the annotated function, and the boundary is attached to that " +
      "identity. Give it a PascalCase (component) or useX (hook) name -- a binding, a named " +
      "function declaration, or an object property key -- to opt it in.",
  );
}

// The one anonymous `export default` shape `deriveModuleIdentityName` cannot
// name. Reported rather than skipped for exactly the reason the annotation
// warning above exists: the author wrote a component in a position the
// transform recognizes, and silence would read as "handled".
function warnUnnamedDefaultExport(path: NodePath<t.Function>, options: InternalTransformOptions): void {
  reportWarning(
    options,
    "RFGS007",
    path,
    "This anonymous default export is left untransformed: its component identity is derived " +
      "from the module's file name, and this module's name does not yield a PascalCase " +
      "identifier. Name the function (`export default function App() { ... }`), or assign it " +
      "to a PascalCase binding and export that binding, to opt it in.",
  );
}

// See the call site in `decideTransform`: the mixed call-and-mount shape that
// `isPlainCalledComponent` cannot give a boundary to without breaking the call.
function warnPlainCalledComponentAlsoMounted(
  path: NodePath<t.Function>,
  name: string,
  options: InternalTransformOptions,
): void {
  reportWarning(
    options,
    "RFGS008",
    path,
    `${name} is called as a plain function (${name}()) and also rendered as <${name} />. ` +
      "A plain call runs its body inside the caller's render, so it gets no tracking boundary " +
      "of its own (its signal reads are tracked by the calling component instead), and the " +
      `<${name} /> instance therefore only updates when its parent re-renders. Use one form ` +
      `consistently -- render it only as <${name} />, or only call it -- to remove the ambiguity.`,
  );
}

function hasModuleLevelUseServer(path: NodePath<t.Function>): boolean {
  const program = path.findParent((parent) => parent.isProgram());
  return program?.isProgram() === true && program.node.directives.some(
    (directive) => directive.value.value === "use server",
  );
}

function warnServerDirectiveComponent(
  path: NodePath<t.Function>,
  options: InternalTransformOptions,
): void {
  reportWarning(
    options,
    "RFGS009",
    path,
    'This component is left untransformed because its module has a top-level "use server" directive. ' +
      'A server-only module cannot receive the client tracking Hook. Move the component to a ' +
      '"use client" module if it needs automatic signal tracking.',
  );
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
// runtime hook binding to call.
interface TransformCodegenInput {
  body: FunctionBody;
  statements: NodePath<t.Statement>[];
  explicit: boolean;
  runtimeImport: RuntimeImport;
  /**
   * The import specifier the absorbed explicit call resolved to, when there is
   * one -- see `getAbsorbedSignalTrackingImport`. Only `applyManaged` absorbs, so
   * only it records this.
   */
  absorbedImport?: NodePath<t.ImportSpecifier> | undefined;
}

/**
 * What the `Function` visitor should do with one visited function, decided up
 * front by `decideTransform` so the two codegen strategies below never have to
 * re-derive eligibility themselves:
 * - `"skip"`: opted out, ineligible, or already covered by an unverifiable or
 *   late `useSignalTracking()` call the component keeps on its own.
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
 * explicit/annotated/automatic eligibility (plus the barrel-useSignalTracking
 * warning that eligibility check surfaces along the way), the
 * async/generator guard, and -- once a function is confirmed eligible for
 * real codegen -- acquiring the corresponding runtime hook import it will call.
 * Pure decision-making: no AST mutation happens here, so every early return is
 * just a `return`, not a `return` guarding mutations already made.
 */
function decideTransform(
  path: NodePath<t.Function>,
  state: PluginState,
  options: InternalTransformOptions,
  reactImportSource: string,
): TransformDecision {
  // A module-level server-action directive is positive evidence that its
  // exports are server-only. Do not infer this from the absence of "use
  // client": ordinary RSC Server Components and client modules are otherwise
  // indistinguishable to this single-file transform.
  if (hasModuleLevelUseServer(path)) {
    if (rendersJsx(path) && (options.mode !== "manual" || hasOwnedLeadingComment(path, useSignalTrackingComment))) {
      warnServerDirectiveComponent(path, options);
    }
    return { kind: "skip" };
  }

  // Computed once and given to every check below that would otherwise climb
  // through this same function's memo()/forwardRef() wrappers on its own --
  // see `getBindingIdentityName`'s matching parameter.
  const climbedParent = climbComponentWrappers(path, reactImportSource).parentPath;
  const identity =
    resolveComponentIdentity(path, reactImportSource, climbedParent) ??
    getDefaultExportIdentity(climbedParent, state.filename);
  // A `@signalTracking`/`@noSignalTracking` comment on a HOC factory is written for the
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

  if (ownsLeadingComment(noSignalTrackingComment)) return { kind: "skip" };

  const body = path.get("body");
  const statements = body.isBlockStatement() ? body.get("body") : [];
  const explicit = isExplicitSignalTracking(path, statements, options.importSource);
  if (isUnverifiableBarrelSignalTracking(path, statements, options.importSource, explicit)) {
    warnUnverifiableBarrelSignalTracking(path, options.importSource, options);
  }
  const managedRuntimeSource = `${options.importSource}/runtime`;
  const inspection = inspectFunction(
    path,
    options.importSource,
    managedRuntimeSource,
    reactImportSource,
  );
  inspectKnownRenderPropReads(path, options, reactImportSource);
  const annotation = ownsLeadingComment(useSignalTrackingComment);
  // A factory is not a component, so no automatic route and no annotation may
  // attach a boundary to it -- the component it returns carries one instead
  // (`getIdentityFactory`). An explicit, hand-written `useSignalTracking()` call is
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
  // taking a component-shaped parameter, silently and with its `@signalTracking`
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
    if (enclosing === null || !hasOwnedLeadingComment(enclosing, useSignalTrackingComment)) {
      warnUnnamedSignalTrackingAnnotation(path, options);
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
    rendersJsx(path) &&
    (options.mode === "all" || (options.mode === "auto" && inspection.readsValue))
  ) {
    warnUnnamedDefaultExport(path, options);
  }
  // A component that is both called (`Title()`) and mounted (`<Title />`) can
  // only be given one answer, and the plain call forces it: a boundary would be
  // a conditional hook call inside the caller. The `<Title />` instance then has
  // no subscription of its own and only refreshes when its parent re-renders --
  // a stale-UI risk this file reports rather than leaves silent. Only raised
  // where the function would otherwise have been transformed, so a component
  // with nothing to subscribe to stays quiet.
  if (
    !candidate &&
    !explicit &&
    !annotated &&
    !isFactory &&
    shouldAutomaticallyTransform(options.mode, inspection, identity) &&
    isComponentIdentity(identity) &&
    isPlainCalledComponent(path) &&
    isAlsoMountedThroughJsx(path)
  ) {
    warnPlainCalledComponentAlsoMounted(path, identity?.name ?? "component", options);
  }
  const automatic =
    !isFactory && candidate && shouldAutomaticallyTransform(options.mode, inspection, identity);
  if (!explicit && !annotated && !automatic) return { kind: "skip" };
  if (!explicit && (inspection.hasSignalTrackingCall || inspection.hasUseManagedSignalsCall)) {
    return { kind: "skip" };
  }
  if (options.transform === "inject" && explicit) return { kind: "directive-only", body };
  if (path.node.async || path.node.generator) {
    if (!explicit && !annotated) return { kind: "skip" };
    throw path.buildCodeFrameError(
      "useSignalTracking transform only supports synchronous, non-generator functions",
    );
  }
  // An explicit `useSignalTracking()` is a request for the runtime's ambient
  // render collector. Preserve that contract in managed mode: the per-read
  // capture transform only instruments statically proven `.value` reads and
  // cannot see deep-signal proxy properties such as `task.done`. Replacing the
  // hook with `useSignalCapture()` silently loses those dependencies. Authors
  // who want the newer exact per-read boundary can use `@signalTracking` (or
  // remove the explicit hook and let auto mode select the component).
  if (explicit && options.transform === "managed") {
    return { kind: "directive-only", body };
  }

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
    runtimeImport = addRuntimeImport(
      state.programPath,
      importSource,
      options.transform === "managed" ? "useSignalCapture" : "useSignalTracking",
      path,
    );
    imports.push(runtimeImport);
  }

  return {
    kind: options.transform,
    body,
    statements,
    explicit,
    runtimeImport,
    absorbedImport: explicit ? getAbsorbedSignalTrackingImport(path, statements) : undefined,
  };
}

/**
 * Does `param` itself evaluate a tracked `.value` read when the function is
 * called -- i.e. in a default value (`{ v = count.value }`, `n = count.value`)?
 *
 * Reads inside a nested function are skipped: a closure created by a default
 * (`format = () => count.value`) does not run during parameter binding, and if
 * the body calls it during render, it runs after the boundary is open anyway.
 */
function parameterReadsTrackedValue(
  param: NodePath,
  functionPath: NodePath<t.Function>,
): boolean {
  // A bare identifier has no default to evaluate -- the overwhelmingly common
  // `(props)` case never needs the walk.
  if (param.isIdentifier()) return false;
  let found = false;
  const visit = (path: NodePath<t.MemberExpression | t.OptionalMemberExpression>): void => {
    if (isTrackedValueRead(path.node, path, functionPath)) {
      found = true;
      path.stop();
    }
  };
  param.traverse({
    Function(nested) {
      nested.skip();
    },
    MemberExpression: visit,
    OptionalMemberExpression: visit,
  });
  return found;
}

/**
 * Would moving `moved` from the parameter list into the body change what any
 * name in them means? Two shapes do, and both are rare enough that the honest
 * answer is to leave the parameters exactly where they were:
 *
 * - A default refers to a name the body itself declares
 *   (`({ v = count.value }) => { const count = ...; }`). In the parameter list
 *   that name is the *outer* binding, because parameters get a scope of their
 *   own; moved into the body it would hit the body's declaration instead (and
 *   its temporal dead zone). Babel models parameters and body-level
 *   declarations as one function scope, which is precisely what makes this
 *   detectable: such a name resolves to an own binding that is not a parameter.
 * - A moved parameter is re-declared in the body (`var v;`, `function v() {}`),
 *   which is legal next to a parameter but a redeclaration error next to the
 *   `let` the move would emit. Babel records those as constant violations of
 *   the parameter binding.
 */
function hasRelocationConflict(path: NodePath<t.Function>, moved: NodePath[]): boolean {
  const movedNames = new Set(moved.flatMap((param) => Object.keys(t.getBindingIdentifiers(param.node))));
  const params = path.get("params");
  const firstMovedIndex = params.findIndex((param) => moved.some((candidate) => candidate.node === param.node));
  // A default in an earlier, unmoved parameter can create a closure over a
  // later parameter (`function C(read = () => value, value = count.value)`).
  // Once `value` is rebound as a body `let`, that closure still closes over the
  // parameter environment; replacing the parameter would silently make it see
  // an outer/global `value` instead. Direct forward references have the same
  // parameter-environment/TDZ distinction. Decline only this relocation.
  for (const param of params.slice(0, firstMovedIndex)) {
    let conflict = false;
    param.traverse({
      ReferencedIdentifier(reference) {
        if (!movedNames.has(reference.node.name)) return;
        const parameterBinding = path.scope.getOwnBinding(reference.node.name);
        if (parameterBinding !== undefined && reference.scope.getBinding(reference.node.name) === parameterBinding) {
          conflict = true;
          reference.stop();
        }
      },
    });
    if (conflict) return true;
  }
  for (const param of moved) {
    for (const name of Object.keys(t.getBindingIdentifiers(param.node))) {
      const binding = path.scope.getOwnBinding(name);
      if (
        binding?.constantViolations.some((violation) =>
          violation.isVariableDeclarator() ||
          violation.isFunctionDeclaration() ||
          violation.isClassDeclaration()
        )
      ) {
        return true;
      }
    }
    let conflict = false;
    param.traverse({
      ReferencedIdentifier(reference) {
        if (!reference.isIdentifier()) return;
        const binding = path.scope.getOwnBinding(reference.node.name);
        if (binding !== undefined && binding.kind !== "param") {
          conflict = true;
          reference.stop();
        }
      },
    });
    if (conflict) return true;
  }
  return false;
}

/**
 * Moves parameters with signal-reading defaults into the function body, after
 * the top-level capture Hook has opened the render-attempt capture.
 *
 * Parameter defaults are evaluated before the first statement of the body runs,
 * so in `function C({ v = count.value })` the read happens before the injected
 * `useSignalCapture()` call has run -- the read is real, `inspectFunction`
 * counts it, and the component should subscribe to it. Moving the pattern
 * into the body makes it run after the Hook:
 *
 * ```js
 * function C(_param) {
 *   const _signals = _useSignalCapture();
 *   let { v = _signals.capture(() => count.value) } = _param;
 *     ...
 * ```
 *
 * The rewrite is kept as small as it can be while staying faithful:
 *
 * - Nothing happens unless a parameter actually reads a signal; every other
 *   function keeps its parameter list untouched.
 * - From the first such parameter *onward*, every parameter moves, in order. A
 *   later default may refer to an earlier parameter (`(a = count.value, b =
 *   a)`), and it may have side effects whose order matters, so moving one
 *   parameter alone could change what the others see.
 * - Each moved parameter is replaced one-for-one by a generated identifier
 *   rather than removed, so the parameter *count* is unchanged and a
 *   `forwardRef` render function keeps its two-parameter `(props, ref)` shape
 *   (`length` can change where a default used to end the count, which React
 *   only inspects to warn about a `forwardRef` arity other than 0 or 2).
 * - A default still applies only on `undefined`: `v = count.value` becomes
 *   `let v = _param === undefined ? count.value : _param`, which is the exact
 *   rule a parameter default follows; a destructuring pattern's own nested
 *   defaults keep their meaning by moving verbatim.
 * - A type annotation travels to the generated parameter, so the signature
 *   still says what it accepts; `?` optional markers have no meaning on a
 *   `let` and are dropped from the moved pattern. In TypeScript the generated
 *   parameter is marked `?` wherever the original was optional.
 *
 * When the move cannot be done without changing meaning
 * (`hasRelocationConflict`), or a parameter is a TypeScript parameter property
 * (constructor-only, never a component), nothing moves and the read stays
 * untracked exactly as before -- an edge this declines rather than miscompiles.
 */
function relocateTrackedParameters(path: NodePath<t.Function>, typeScript: boolean): t.Statement[] {
  const params = path.get("params");
  const first = params.findIndex((param) => parameterReadsTrackedValue(param, path));
  if (first === -1) return [];
  const moved = params.slice(first);
  // Planned in full before anything is mutated, so a shape this does not know
  // how to move (a TypeScript parameter property, or anything unexpected)
  // leaves the whole parameter list exactly as it was rather than half-moved.
  const plan: { param: NodePath; pattern: BindablePattern; fallback?: t.Expression; rest?: t.RestElement }[] = [];
  for (const param of moved) {
    const node = param.node;
    if (t.isRestElement(node)) {
      if (!isBindablePattern(node.argument)) return [];
      plan.push({ param, pattern: node.argument, rest: node });
    } else if (t.isAssignmentPattern(node)) {
      if (!isBindablePattern(node.left)) return [];
      plan.push({ param, pattern: node.left, fallback: node.right });
    } else if (isBindablePattern(node)) {
      plan.push({ param, pattern: node });
    } else {
      return [];
    }
  }
  if (hasRelocationConflict(path, moved)) return [];
  // TypeScript treats a parameter as optional when it is marked `?`, or when it
  // has a default and every parameter after it is optional too. The generated
  // parameter keeps that, which is also what keeps it legal after a `?` one:
  // a required parameter there is a parse error in Oxc (and TS1016 in tsc).
  const optional: boolean[] = [];
  let laterOptional = true;
  for (let index = plan.length - 1; index >= 0; index -= 1) {
    const { pattern, fallback, rest } = plan[index]!;
    optional[index] = typeScript && rest === undefined
      && (pattern.optional === true || (fallback !== undefined && laterOptional));
    laterOptional &&= rest !== undefined || optional[index]!;
  }
  const declarations: t.Statement[] = [];
  for (const [index, { param, pattern, fallback, rest }] of plan.entries()) {
    const local = path.scope.generateUidIdentifier("param");
    const init = fallback === undefined
      ? t.cloneNode(local)
      : t.conditionalExpression(
        t.binaryExpression("===", t.cloneNode(local), t.identifier("undefined")),
        fallback,
        t.cloneNode(local),
      );
    let replacement: t.Identifier | t.RestElement = local;
    if (rest !== undefined) {
      // A rest parameter's annotation sits on the `RestElement` itself.
      replacement = t.restElement(t.cloneNode(local));
      replacement.typeAnnotation = rest.typeAnnotation ?? null;
    } else if (pattern.typeAnnotation !== null && pattern.typeAnnotation !== undefined) {
      // The signature keeps its type; the `let` gets the bare pattern.
      local.typeAnnotation = pattern.typeAnnotation;
    }
    if (optional[index]) local.optional = true;
    pattern.typeAnnotation = null;
    pattern.optional = null;
    declarations.push(t.variableDeclaration("let", [t.variableDeclarator(pattern, init)]));
    param.replaceWith(replacement);
  }
  return declarations;
}

/** The binding patterns a `let` declarator accepts, which is every shape a parameter binds through. */
type BindablePattern = t.Identifier | t.ObjectPattern | t.ArrayPattern;

function isBindablePattern(node: t.Node): node is BindablePattern {
  return t.isIdentifier(node) || t.isObjectPattern(node) || t.isArrayPattern(node);
}

/** Codegen: inject a bare `useSignalTracking()` call at the top of the function body. */
function applyInject(
  path: NodePath<t.Function>,
  { body, runtimeImport }: TransformCodegenInput,
  options: InternalTransformOptions,
  state: PluginState,
): void {
  const call = t.expressionStatement(
    t.callExpression(t.cloneNode(runtimeImport.identifier), []),
  );
  // Bound again right after the call, so a default's read is collected too.
  const relocated = relocateTrackedParameters(path, state.typeScript);
  if (body.isBlockStatement()) {
    body.unshiftContainer("body", [call, ...relocated]);
  } else {
    body.replaceWith(
      t.blockStatement([
        call,
        ...relocated,
        t.returnStatement(body.node as t.Expression),
      ]),
    );
  }
  const injectedBody = path.node.body;
  if (options.reactCompiler === "auto" && t.isBlockStatement(injectedBody)) {
    addNoMemoDirective(injectedBody);
  }
  path.scope.crawl();
  invalidateThisReferences(path);
  markTransformed(state);
}

function hasTrackedReadInMemberChain(
  path: NodePath,
  functionPath: NodePath<t.Function>,
  trackedAliases: Set<object>,
): boolean {
  let current: NodePath = path;
  while (current.isMemberExpression() || current.isOptionalMemberExpression()) {
    if (
      isTrackedValueRead(current.node, current, functionPath) ||
      isPotentialDynamicMemberRead(current.node, current, functionPath)
    ) return true;
    const object = unwrapTransparentPath(current.get("object") as NodePath);
    if (object.isCallExpression() || object.isOptionalCallExpression()) {
      return hasTrackedReadInExpression(object, functionPath, trackedAliases);
    }
    current = object;
  }
  return current.isIdentifier() && trackedAliases.has(current.scope.getBinding(current.node.name) as object);
}

/**
 * Results of `hasTrackedReadInExpression`, per alias set and owning function.
 * A member chain whose object is a call re-enters the expression check for that
 * call, so without this a call chain like `z.a().b().c()` re-walks every inner
 * call once per enclosing link (exponential in the chain length). The alias set
 * only grows; a size change invalidates the cached answers for it.
 */
const trackedReadCache = new WeakMap<Set<object>, { size: number; byFunction: WeakMap<t.Node, WeakMap<t.Node, boolean>> }>();

function hasTrackedReadInExpression(
  path: NodePath,
  functionPath: NodePath<t.Function>,
  trackedAliases: Set<object>,
): boolean {
  let entry = trackedReadCache.get(trackedAliases);
  if (entry === undefined || entry.size !== trackedAliases.size) {
    entry = { size: trackedAliases.size, byFunction: new WeakMap() };
    trackedReadCache.set(trackedAliases, entry);
  }
  let results = entry.byFunction.get(functionPath.node);
  if (results === undefined) entry.byFunction.set(functionPath.node, results = new WeakMap());
  const cached = results.get(path.node);
  if (cached !== undefined) return cached;
  const result = computeTrackedReadInExpression(path, functionPath, trackedAliases);
  results.set(path.node, result);
  return result;
}

function computeTrackedReadInExpression(
  path: NodePath,
  functionPath: NodePath<t.Function>,
  trackedAliases: Set<object>,
): boolean {
  if (path.isIdentifier()) {
    const binding = path.scope.getBinding(path.node.name);
    if (binding !== undefined && trackedAliases.has(binding)) return true;
  }
  const isTracked = (candidate: NodePath): boolean =>
    (candidate.isMemberExpression() || candidate.isOptionalMemberExpression()) &&
    (isTrackedValueRead(candidate.node, candidate, functionPath) ||
      isPotentialDynamicMemberRead(candidate.node, candidate, functionPath) ||
      hasTrackedReadInMemberChain(candidate, functionPath, trackedAliases));
  if (isTracked(path)) return true;
  let found = false;
  path.traverse({
    Function(nested) { nested.skip(); },
    MemberExpression(candidate) {
      if (isTracked(candidate)) {
        found = true;
        candidate.stop();
      }
    },
    OptionalMemberExpression(candidate) {
      if (isTracked(candidate)) {
        found = true;
        candidate.stop();
      }
    },
    // The alias itself, wherever it sits in the expression, is how the tracked
    // value travels: `u as T`, `flag ? u : other`, `[u]`, `{ u }`, `f(u)`,
    // `u ?? {}`. Whoever receives it reads through the same proxy.
    Identifier(candidate) {
      if (isTrackedAliasReference(candidate, functionPath, trackedAliases)) {
        found = true;
        candidate.stop();
      }
    },
  });
  return found;
}

function isTrackedAliasReference(
  path: NodePath<t.Identifier>,
  functionPath: NodePath<t.Function>,
  trackedAliases: Set<object>,
): boolean {
  if (trackedAliases.size === 0 || !path.isReferencedIdentifier()) return false;
  // A Hook's argument is handed to React in place, never read by a capture.
  const parent = path.parentPath;
  if (
    (parent.isCallExpression() || parent.isOptionalCallExpression()) &&
    parent.node.callee !== path.node && callNameIsHook(parent.node.callee)
  ) return false;
  const binding = path.scope.getBinding(path.node.name);
  return binding !== undefined && trackedAliases.has(binding) && !isDeferredReadContext(path, functionPath);
}

function functionCallsHook(functionPath: NodePath<t.Function>): boolean {
  let found = false;
  const inspectCall = (path: NodePath<t.CallExpression | t.OptionalCallExpression>): void => {
    const callee = unwrapTransparent(path.node.callee);
    const name = t.isIdentifier(callee)
      ? callee.name
      : t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)
        ? getStaticMemberChain(callee)?.keys.at(-1)
        : undefined;
    if (name !== undefined && isHookName(name)) {
      found = true;
      path.stop();
    }
  };
  functionPath.get("body").traverse({
    Function(nested) { nested.skip(); },
    CallExpression: inspectCall,
    OptionalCallExpression: inspectCall,
  });
  return found;
}

function externalCallMayReadTrackedValue(
  call: NodePath<t.CallExpression | t.OptionalCallExpression>,
  functionPath: NodePath<t.Function>,
  importSource: string,
  managedRuntimeSource: string,
  reactImportSource: string,
): boolean {
  const argument = getRenderCallbackArgument(call.node);
  let target: NodePath<t.Function> | undefined;
  if (argument !== undefined && isRenderCallbackInvocation(call.node, argument)) {
    const reference = unwrapTransparent(argument);
    if (t.isIdentifier(reference)) {
      target = resolveReferencedFunction(call, reference.name);
    } else {
      const argumentPath = call.get("arguments").find((candidate) => candidate.node === argument);
      if (argumentPath?.isArrowFunctionExpression() || argumentPath?.isFunctionExpression()) {
        target = argumentPath;
      }
    }
  }
  if (target === undefined) {
    const callee = unwrapTransparent(call.node.callee);
    if (t.isIdentifier(callee)) {
      if (isHookName(callee.name)) return false;
      target = resolveReferencedFunction(call, callee.name);
    } else if (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) {
      const chain = getStaticMemberChain(callee);
      const name = chain?.keys.at(-1);
      if (name === undefined || isHookName(name)) return false;
      target = resolveKeyedFunction(call, callee);
    }
  }
  if (target === undefined) {
    const callee = unwrapTransparent(call.node.callee);
    if (!t.isIdentifier(callee)) return false;
    const binding = call.scope.getBinding(callee.name);
    const importSpecifier = binding?.path;
    if (
      importSpecifier !== undefined &&
      (importSpecifier.isImportSpecifier() || importSpecifier.isImportDefaultSpecifier()) &&
      importSpecifier.parentPath.isImportDeclaration() &&
      importSpecifier.parentPath.node.importKind !== "type" &&
      importSpecifier.parentPath.node.source.value !== importSource &&
      importSpecifier.parentPath.node.source.value !== reactImportSource
    ) {
      const imported = importSpecifier.isImportSpecifier() ? importSpecifier.node.imported : undefined;
      const importedName = imported === undefined
        ? "default"
        : t.isIdentifier(imported) ? imported.name : imported.value;
      // The transform cannot inspect another module's implementation. Capture
      // the synchronous call itself so any signal reads it performs belong to
      // this render attempt. Hook-shaped imports stay as direct calls: wrapping
      // them in a callback would violate the Rules of Hooks.
      if (!isHookName(importedName) && !isComponentName(importedName) && !isComponentName(callee.name)) {
        return true;
      }
    }
    const declarator = binding?.path.isVariableDeclarator() ? binding.path : undefined;
    const init = declarator?.get("init");
    // A locally assigned computed member can be a render callback alias even
    // when its concrete target depends on a runtime key. Capturing its direct
    // synchronous invocation preserves the owner without inserting a Hook in
    // the aliased function.
    return init?.isMemberExpression() === true && init.node.computed &&
      getReadPropertyName(init.node) === undefined;
  }
  // Iterating a generator runs its body later, outside this call; the loop
  // that pulls from it captures those steps (see the `for...of` visitor).
  if (target.node.generator) return false;
  return cachedTargetMayRead(target, importSource, managedRuntimeSource, reactImportSource);
}

interface ReadContext {
  importSource: string;
  managedRuntimeSource: string;
  reactImportSource: string;
}

/**
 * Method names taken as the builtin when the receiver is a value the function
 * owns (see `ownership`). The name alone proves nothing: an imported object can
 * define `map` or `toString` itself.
 */
const pureMethodNames = new Set([
  "map", "filter", "reduce", "reduceRight", "forEach", "some", "every", "flatMap", "flat",
  "find", "findIndex", "findLast", "findLastIndex", "at", "includes",
  "slice", "concat", "join", "indexOf", "lastIndexOf", "sort", "reverse", "toSorted",
  "toReversed", "push", "pop", "shift", "unshift", "splice",
  "toString", "toUpperCase", "toLowerCase", "toLocaleUpperCase", "toLocaleLowerCase",
  "trim", "trimStart", "trimEnd", "split", "replace", "replaceAll", "padStart", "padEnd",
  "startsWith", "endsWith", "charAt", "charCodeAt", "codePointAt", "localeCompare",
  "substring", "repeat", "normalize", "toFixed", "toPrecision", "toLocaleString",
  "toLocaleDateString", "toLocaleTimeString", "toISOString", "toJSON", "valueOf",
]);

/**
 * Standard globals whose functions, and static members (`Math.max`,
 * `JSON.stringify`, `Object.keys`), are the engine's own. Any other free name
 * (`window.store`, a global a script defined) is unresolved module code.
 */
const standardGlobals = new Set([
  "Math", "JSON", "Object", "Array", "Number", "String", "Boolean", "Symbol", "BigInt", "Date",
  "Reflect", "Intl", "Promise", "Map", "Set", "WeakMap", "WeakSet", "RegExp", "Error", "TypeError",
  "RangeError", "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent",
  "encodeURI", "decodeURI", "console", "structuredClone", "URL", "URLSearchParams", "TextEncoder", "TextDecoder",
  "ArrayBuffer", "DataView", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
  "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
]);

/**
 * Builtins that call a function they are handed: the argument index of that
 * function. That function runs inside the call, so it must be proven too.
 */
const builtinCallbackArguments: ReadonlyMap<string, number> = new Map([
  ["map", 0], ["filter", 0], ["forEach", 0], ["some", 0], ["every", 0], ["flatMap", 0],
  ["find", 0], ["findIndex", 0], ["findLast", 0], ["findLastIndex", 0],
  ["reduce", 0], ["reduceRight", 0], ["sort", 0], ["toSorted", 0],
  ["replace", 1], ["replaceAll", 1],
]);
const globalCallbackArguments: ReadonlyMap<string, number> = new Map([
  ["Array.from", 1], ["JSON.stringify", 1], ["JSON.parse", 1], ["Object.groupBy", 1], ["Map.groupBy", 1],
]);
/** Builtins whose callback receives receiver elements (and, for `reduce*`, an accumulator first). */
const elementCallbackMethods = new Set([
  "map", "filter", "forEach", "some", "every", "flatMap", "find", "findIndex", "findLast", "findLastIndex",
  "reduce", "reduceRight", "sort", "toSorted",
]);

/** React Hooks whose results are plain state the component owns. */
const stateHookNames = new Set([
  "useState", "useReducer", "useDeferredValue", "useTransition", "useOptimistic", "useActionState", "useId",
]);

/** How much is known about a value's provenance; see `ownership`. */
const enum Ownership {
  /** Nothing proven: it may be an object with its own `map`/`toString`. */
  Unknown = 0,
  /** The value itself is a builtin (array, string, number), but not its elements. */
  Builtin = 1,
  /**
   * The value and everything read from it: a primitive, a literal of such
   * values, or -- by convention, not by proof -- props and React state.
   */
  Deep = 2,
}

/** Builtin methods that return one of the receiver's elements. */
const elementReturningMethods = new Set(["pop", "shift", "at", "find", "findLast"]);
/**
 * Builtin methods whose result is whatever their callback or initial value
 * returns (`items.reduce(() => extStore, extStore)`), not a receiver element.
 */
const callbackResultMethods = new Set(["reduce", "reduceRight"]);
/** Builtin methods whose result holds only the receiver's own elements, or is the receiver. */
const elementPreservingMethods = new Set([
  "filter", "slice", "sort", "reverse", "toSorted", "toReversed", "splice", "flat", "valueOf",
]);
/** Builtin methods whose result is a new array of callback results or arguments. */
const newCollectionMethods = new Set(["map", "flatMap", "concat"]);
/** Builtin methods that put their arguments into the receiver. */
const insertingMethods: ReadonlyMap<string, number> = new Map([
  ["push", 0], ["unshift", 0], ["splice", 2], ["fill", 0], ["set", 1], ["add", 0],
]);

/**
 * May a call skip capture because its callee is a builtin method of data the
 * function owns? The receiver must hold such data (`ownership`), the method
 * name must be a builtin one, and a function the builtin calls back must be
 * provable as well (`calledBackIsKnown`).
 */
function receiverIsLocalData(
  call: NodePath<t.CallExpression | t.OptionalCallExpression>,
  callee: t.MemberExpression | t.OptionalMemberExpression,
  context: ReadContext,
): boolean {
  return ownership(call, callee.object, 0, context) !== Ownership.Unknown;
}

/**
 * Is a function a builtin is handed, and will call, one whose reads are
 * decided elsewhere? An inline function or a never-reassigned local function
 * is inspected by the call-site checks; a standard global (`String`) is the
 * engine's. A function from props, an import, or any other value is not.
 */
function calledBackIsKnown(
  call: NodePath<t.CallExpression | t.OptionalCallExpression | t.NewExpression>,
  index: number | undefined,
): boolean {
  if (index === undefined) return true;
  const argument = call.node.arguments[index];
  if (argument === undefined) return true;
  const value = unwrapTransparent(argument);
  if (t.isArrowFunctionExpression(value) || t.isFunctionExpression(value)) return true;
  if (t.isNullLiteral(value)) return true;
  if (!t.isIdentifier(value)) return false;
  if (value.name === "undefined" && call.scope.getBinding("undefined") === undefined) return true;
  if (call.scope.getBinding(value.name) === undefined) return standardGlobals.has(value.name);
  return resolveReferencedFunction(call, value.name) !== undefined;
}

/** `Math.max` / `JSON.stringify` / `String`: the dotted name of a standard global function, if it is one. */
function standardGlobalCallee(call: NodePath, callee: t.Node): string | undefined {
  if (t.isIdentifier(callee)) {
    return call.scope.getBinding(callee.name) === undefined && standardGlobals.has(callee.name) ? callee.name : undefined;
  }
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return undefined;
  const chain = getStaticMemberChain(callee);
  if (chain === undefined) return undefined;
  const root = unwrapTransparent(chain.root);
  if (!t.isIdentifier(root) || call.scope.getBinding(root.name) !== undefined || !standardGlobals.has(root.name)) {
    return undefined;
  }
  // `.call`/`.apply`/`.bind` choose `this` and the arguments at run time.
  const last = chain.keys.at(-1);
  if (last === "call" || last === "apply" || last === "bind") return undefined;
  return [root.name, ...chain.keys].join(".");
}

/** Is `value` the receiver, a member of it, or nested deeper (`x`, `x.a`, `x[0].b`)? */
function climbMemberChain(reference: NodePath): NodePath {
  let current = reference;
  while (
    current.parentPath !== null &&
    (current.parentPath.isMemberExpression() || current.parentPath.isOptionalMemberExpression()) &&
    current.parentPath.node.object === current.node
  ) {
    current = current.parentPath;
  }
  return current;
}

type Binding = NonNullable<ReturnType<NodePath["scope"]["getBinding"]>>;

const mutationCache = new WeakMap<object, Ownership>();

/**
 * Is `path` (a member chain) written to: the left side of an assignment, a
 * slot inside a destructuring assignment pattern, or a loop head? Returns the
 * assignment when it is a plain `x.k = v`, `true` for any other write.
 */
function memberWrite(path: NodePath): NodePath<t.AssignmentExpression> | boolean {
  let current = path;
  for (;;) {
    const parent = current.parentPath;
    if (parent === null) return false;
    if (parent.isObjectProperty() && parent.node.value === current.node && parent.parentPath?.isObjectPattern()) {
      current = parent.parentPath;
    } else if (parent.isArrayPattern() || parent.isRestElement() || (parent.isAssignmentPattern() && parent.node.left === current.node)) {
      current = parent;
    } else if (parent.isAssignmentExpression() && parent.node.left === current.node) {
      return current === path ? parent : true;
    } else if ((parent.isForOfStatement() || parent.isForInStatement()) && parent.node.left === current.node) {
      return true;
    } else {
      return false;
    }
  }
}

/** The standard functions that write their later arguments into their first. */
const objectWriters = new Set([
  "Object.assign", "Object.defineProperty", "Object.defineProperties", "Reflect.set", "Reflect.defineProperty",
  "Object.setPrototypeOf", "Reflect.setPrototypeOf",
]);

/**
 * Where else a reference's value goes: the bindings of a `const alias = value`
 * (through a choice or a TS wrapper) or of a destructuring declaration
 * (`const { list } = value`, whose parts are still the value's own),
 * `"assigned"` when it is stored in a place this module cannot follow by name,
 * or undefined.
 */
function referenceAlias(reference: NodePath): Binding[] | "assigned" | undefined {
  let current = climbTransparentWrappers(reference);
  for (;;) {
    const parent = current.parentPath;
    if (parent === null) return undefined;
    if (
      (parent.isConditionalExpression() && parent.node.test !== current.node) || parent.isLogicalExpression() ||
      (parent.isSequenceExpression() && parent.node.expressions.at(-1) === current.node) ||
      parent.isParenthesizedExpression() || isTransparentWrapper(parent.node)
    ) {
      current = parent;
      continue;
    }
    if (parent.isVariableDeclarator() && parent.node.init === current.node) {
      const names = Object.keys(t.getBindingIdentifiers(parent.node.id));
      const bindings = names.map((name) => parent.scope.getBinding(name));
      return bindings.every((binding) => binding !== undefined) ? bindings as Binding[] : "assigned";
    }
    if (parent.isAssignmentExpression() && parent.node.right === current.node) {
      // `copy = value`: follow what is done through `copy`; a member target stores it out of reach.
      const target = t.isIdentifier(parent.node.left) ? parent.scope.getBinding(parent.node.left.name) : undefined;
      return target === undefined ? "assigned" : [target];
    }
    return undefined;
  }
}

/**
 * The most a binding can still be trusted for after the writes this module
 * makes into it, directly or through a `const` alias: `list.push(extStore)`
 * or `list[0] = extStore` put values of other provenance in its elements
 * (Builtin at most); an assignment to a named member (`m.get = p.g`), a
 * destructuring or loop-head write, `Object.assign(list, ...)`, or storing the
 * value somewhere that cannot be followed by name can replace one of its
 * methods (Unknown). A value handed to code this module cannot see may be
 * written there as well; that is not followed.
 */
function mutationLimit(binding: Binding, context: ReadContext, depth: number): Ownership {
  return memoizedOwnership(mutationCache, binding, () => computeMutationLimit(binding, context, depth));
}

function computeMutationLimit(binding: Binding, context: ReadContext, depth: number): Ownership {
  let limit = Ownership.Deep;
  const lower = (to: Ownership): void => { if (to < limit) limit = to; };
  const isDeep = (path: NodePath, node: t.Node): boolean => ownership(path, node, depth + 1, context) === Ownership.Deep;
  for (const reference of binding.referencePaths) {
    const top = climbMemberChain(reference);
    const parent = top.parentPath;
    if (parent === null) continue;
    if (top !== reference) {
      const write = memberWrite(top);
      if (write !== false) {
        const key = getReadPropertyName(top.node as t.MemberExpression);
        const element = key !== undefined && /^\d+$/.test(key);
        if (write !== true) {
          const { operator, right } = write.node;
          const logical = operator === "??=" || operator === "||=" || operator === "&&=";
          // `x.n += 1` stores a primitive.
          if (operator !== "=" && !logical) continue;
          // An element may take trusted data; any other key may become a method (`m.get = p.g`).
          if (element ? isDeep(write, right) : isPrimitiveExpression(right)) continue;
        }
        lower(element ? Ownership.Builtin : Ownership.Unknown);
        continue;
      }
      if ((parent.isCallExpression() || parent.isOptionalCallExpression()) && parent.node.callee === top.node) {
        const method = getStaticMemberChain(top.node as t.MemberExpression)?.keys.at(-1);
        const from = method === undefined ? undefined : insertingMethods.get(method);
        if (from !== undefined && !parent.node.arguments.slice(from).every((argument) => isDeep(parent, argument))) {
          lower(Ownership.Builtin);
        }
      }
      continue;
    }
    // `Object.assign(list, extra)` writes the later arguments into the first.
    if ((parent.isCallExpression() || parent.isOptionalCallExpression()) && parent.node.arguments[0] === top.node) {
      const callee = standardGlobalCallee(parent, unwrapTransparent(parent.node.callee));
      if (callee !== undefined && objectWriters.has(callee) && !parent.node.arguments.slice(1).every((argument) => isDeep(parent, argument))) {
        lower(Ownership.Unknown);
      }
      continue;
    }
    const alias = referenceAlias(reference);
    if (alias === "assigned") lower(Ownership.Unknown);
    else if (alias !== undefined) {
      for (const target of alias) if (target !== binding) lower(mutationLimit(target, context, depth + 1));
    }
  }
  return limit;
}

/**
 * Can code this module shows rewrite a member of the object a binding holds
 * in a way a single slot assignment does not show: `Object.assign(o, ...)`,
 * `Object.defineProperty(o, ...)`, a destructuring or loop-head write, or a
 * write through an alias (`const a = o; a.total = ...`)?
 */
function objectMayBeRewritten(binding: Binding, seen: Set<Binding> = new Set()): boolean {
  if (seen.has(binding)) return false;
  seen.add(binding);
  for (const reference of binding.referencePaths) {
    const top = climbMemberChain(reference);
    const parent = top.parentPath;
    if (parent === null) continue;
    if (top !== reference) {
      if (memberWrite(top) === true) return true;
      continue;
    }
    if ((parent.isCallExpression() || parent.isOptionalCallExpression()) && parent.node.arguments[0] === top.node) {
      const callee = standardGlobalCallee(parent, unwrapTransparent(parent.node.callee));
      if (callee !== undefined && objectWriters.has(callee)) return true;
      continue;
    }
    const alias = referenceAlias(reference);
    if (alias === "assigned") return true;
    for (const target of alias ?? []) {
      if (objectMayBeRewritten(target, seen)) return true;
      // Any member write through the alias counts: it is not the slot use the caller checks.
      if (target.referencePaths.some((aliasReference) => {
        const aliasTop = climbMemberChain(aliasReference);
        return aliasTop !== aliasReference && memberWrite(aliasTop) !== false;
      })) return true;
    }
  }
  return false;
}

/**
 * What a parameter holds. Props (and a forwarded ref) of a component are
 * trusted by convention: the transform has no types to prove them. A callback
 * a builtin array method calls with the receiver's elements gets that
 * receiver's trust (`items.map((item) => ...)`), except `reduce`'s
 * accumulator. Any other parameter -- a helper's, an IIFE's, a Hook's, one of
 * a callback some other function calls -- holds whatever its caller passes.
 */
function parameterOwnership(binding: Binding, context: ReadContext, depth: number): Ownership {
  const owner = binding.scope.path;
  // `function h(v) { v = extStore; ... }`: the parameter no longer holds what was passed.
  if (!owner.isFunction() || binding.constantViolations.length > 0) return Ownership.Unknown;
  const parameterPath = (owner.get("params") as NodePath[]).find((param) =>
    param === binding.path || param.node === binding.path.node || binding.path.isDescendant(param));
  const parameter = parameterPath?.node;
  const index = parameterPath === undefined ? -1 : (owner.get("params") as NodePath[]).indexOf(parameterPath);
  let trust = Ownership.Unknown;
  if (isComponentIdentity(resolveComponentIdentity(owner, context.reactImportSource))) {
    trust = Ownership.Deep;
  } else if (parameter !== undefined) {
    trust = elementCallbackOwnership(owner, index, context, depth);
    if (trust === Ownership.Unknown && t.isIdentifier(parameter)) trust = helperArgumentOwnership(owner, index, context, depth);
  }
  if (trust === Ownership.Unknown || parameter === undefined) return Ownership.Unknown;
  // `{ store = extStore }`: a default value is visible code with its own provenance.
  let defaultsTrusted = true;
  const checkDefaults = (node: t.Node): void => {
    if (!defaultsTrusted) return;
    if (t.isAssignmentPattern(node)) {
      if (ownership(owner, node.right, depth + 1, context) !== Ownership.Deep) defaultsTrusted = false;
      checkDefaults(node.left);
    } else if (t.isObjectPattern(node)) {
      for (const property of node.properties) checkDefaults(t.isRestElement(property) ? property.argument : property.value);
    } else if (t.isArrayPattern(node)) {
      for (const element of node.elements) if (element !== null) checkDefaults(element);
    } else if (t.isRestElement(node)) {
      checkDefaults(node.argument);
    }
  };
  checkDefaults(parameter);
  return defaultsTrusted ? trust : Ownership.Unknown;
}

/**
 * `items.map((item) => ...)`: the elements a builtin array method hands its
 * callback carry the receiver's trust; `reduce`'s accumulator does not.
 */
function elementCallbackOwnership(owner: NodePath, index: number, context: ReadContext, depth: number): Ownership {
  const slot = climbTransparentWrappers(owner);
  const call = slot.parentPath;
  if (call === null || !(call.isCallExpression() || call.isOptionalCallExpression()) || call.node.arguments[0] !== slot.node) {
    return Ownership.Unknown;
  }
  const callee = unwrapTransparent(call.node.callee);
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return Ownership.Unknown;
  const method = getStaticMemberChain(callee)?.keys.at(-1);
  if (method === undefined || !elementCallbackMethods.has(method) || (callbackResultMethods.has(method) && index === 0)) {
    return Ownership.Unknown;
  }
  return ownership(call, callee.object, depth + 1, context) === Ownership.Deep ? Ownership.Deep : Ownership.Unknown;
}

/**
 * A module function that is only ever called directly in this module
 * (`function label(item) {...}` ... `label(row)`) holds, in a parameter,
 * what the weakest of those calls passes. A function that is exported,
 * handed elsewhere, or reassigned can be called with anything.
 */
function helperArgumentOwnership(owner: NodePath<t.Function>, index: number, context: ReadContext, depth: number): Ownership {
  let binding: Binding | undefined;
  if (owner.isFunctionDeclaration() && owner.node.id) {
    binding = owner.parentPath.scope.getBinding(owner.node.id.name);
  } else {
    const slot = climbTransparentWrappers(owner).parentPath;
    if (slot?.isVariableDeclarator() && t.isIdentifier(slot.node.id)) binding = slot.scope.getBinding(slot.node.id.name);
  }
  if (binding === undefined || binding.constantViolations.length > 0 || binding.referencePaths.length === 0) return Ownership.Unknown;
  if (binding.path.parentPath?.isExportNamedDeclaration() || binding.path.parentPath?.parentPath?.isExportNamedDeclaration() ||
    binding.path.parentPath?.isExportDefaultDeclaration()) return Ownership.Unknown;
  return weakestArgument(binding, index, context, depth);
}

function weakestArgument(binding: Binding, index: number, context: ReadContext, depth: number): Ownership {
  let trust = Ownership.Deep;
  for (const reference of binding.referencePaths) {
    const site = climbTransparentWrappers(reference);
    const call = site.parentPath;
    if (call === null || !(call.isCallExpression() || call.isOptionalCallExpression())) return Ownership.Unknown;
    if (call.node.callee !== site.node) {
      // `items.map(label)`: the builtin calls it with the receiver's elements.
      if (call.node.arguments[0] !== site.node) return Ownership.Unknown;
      trust = Math.min(trust, elementCallbackOwnership(site as NodePath<t.Function>, index, context, depth));
      if (trust === Ownership.Unknown) return trust;
      continue;
    }
    const args = call.node.arguments;
    if (args.slice(0, index + 1).some((argument) => t.isSpreadElement(argument))) return Ownership.Unknown;
    const argument = args[index];
    // A missing argument is `undefined`.
    if (argument !== undefined) trust = Math.min(trust, ownership(call, argument, depth + 1, context));
    if (trust === Ownership.Unknown) return trust;
  }
  return trust;
}

/**
 * Does `expression` provably evaluate to data the function owns? Proven by
 * where the value comes from, never by being a local name:
 * - Deep (the value and anything read from it): a primitive-valued expression
 *   (literal, template, arithmetic, comparison), an array or object literal of
 *   such values, props of a component and members of them, React state
 *   (`const [rows] = useState(...)`), the elements a builtin array method hands
 *   its callback from such data, element-preserving and element-returning
 *   builtin methods applied to such data, and builtin methods that return a
 *   primitive.
 * - Builtin (the value only): any other array literal, and the new array
 *   `map`/`flatMap`/`concat` build from callback results or arguments. An
 *   element read from such an array (`[extStore][0]`, `box.pop()`,
 *   `ids.map(() => extStore)[0]`) is Unknown.
 * - Unknown: everything else, including `reduce`/`reduceRight` results, any
 *   other call, `this`, module-level values, imports, and parameters other
 *   than props and element callbacks (see `parameterOwnership`).
 * A conditional/logical choice is the weaker of its branches; a
 * never-reassigned local is its initializer, capped by the writes made into it
 * (`mutationLimit`).
 */
/** An expression whose value is always a primitive, whatever its operands are. */
function isPrimitiveExpression(node: t.Node): boolean {
  const expression = unwrapTransparent(node);
  return t.isStringLiteral(expression) || t.isNumericLiteral(expression) || t.isBooleanLiteral(expression) ||
    t.isNullLiteral(expression) || t.isBigIntLiteral(expression) || t.isTemplateLiteral(expression) ||
    t.isBinaryExpression(expression) || t.isUpdateExpression(expression) ||
    (t.isUnaryExpression(expression) && expression.operator !== "delete");
}

/**
 * Answers per expression node for the current file. A node whose answer is
 * still being computed reads as Unknown, so a cycle (a helper passing its own
 * parameter on, a literal that refers back to itself) only ever errs toward
 * capturing, and every node is decided once instead of once per path to it.
 */
const ownershipCache = new WeakMap<t.Node, Ownership>();
const ownershipInProgress = new Set<object>();
let provisionalOwnership = 0;

/**
 * Runs `compute` for `key` once: a key asked for again while it is being
 * answered reads as Unknown, and an answer that relied on such a reading is
 * not kept unless nothing else is still open (it is then the cycle's own,
 * pessimistic, answer).
 */
function memoizedOwnership(cache: WeakMap<object, Ownership>, key: object, compute: () => Ownership): Ownership {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  if (ownershipInProgress.has(key)) {
    provisionalOwnership += 1;
    return Ownership.Unknown;
  }
  ownershipInProgress.add(key);
  const before = provisionalOwnership;
  let result: Ownership;
  try {
    result = compute();
  } finally {
    ownershipInProgress.delete(key);
  }
  if (provisionalOwnership === before || ownershipInProgress.size === 0) cache.set(key, result);
  return result;
}

function ownership(path: NodePath, node: t.Node, depth: number, context: ReadContext): Ownership {
  if (depth > 16) return Ownership.Unknown;
  const expression = unwrapTransparent(node);
  return memoizedOwnership(ownershipCache, expression, () => computeOwnership(path, expression, depth, context));
}

function computeOwnership(path: NodePath, expression: t.Node, depth: number, context: ReadContext): Ownership {
  if (isPrimitiveExpression(expression)) return Ownership.Deep;
  if (t.isArrayExpression(expression) || t.isObjectExpression(expression)) {
    return literalHoldsOnly(path, expression, depth, context) ? Ownership.Deep : t.isArrayExpression(expression) ? Ownership.Builtin : Ownership.Unknown;
  }
  if (t.isConditionalExpression(expression)) {
    return Math.min(ownership(path, expression.consequent, depth + 1, context), ownership(path, expression.alternate, depth + 1, context));
  }
  if (t.isLogicalExpression(expression)) {
    return Math.min(ownership(path, expression.left, depth + 1, context), ownership(path, expression.right, depth + 1, context));
  }
  if (t.isSequenceExpression(expression)) {
    const last = expression.expressions.at(-1);
    return last === undefined ? Ownership.Unknown : ownership(path, last, depth + 1, context);
  }
  if (t.isAssignmentExpression(expression)) {
    if (expression.operator === "=") return ownership(path, expression.right, depth + 1, context);
    // `x ??= extStore` is either the old value or the new one; `+=` and the like produce a primitive.
    if (expression.operator === "??=" || expression.operator === "||=" || expression.operator === "&&=") {
      return Math.min(ownership(path, expression.left, depth + 1, context), ownership(path, expression.right, depth + 1, context));
    }
    return Ownership.Deep;
  }
  if (t.isMemberExpression(expression) || t.isOptionalMemberExpression(expression)) {
    // Only a member of props, state, or a literal of primitives is known; an
    // element of another local array or a property of an object can be anything.
    return ownership(path, expression.object, depth + 1, context) === Ownership.Deep ? Ownership.Deep : Ownership.Unknown;
  }
  if (t.isCallExpression(expression) || t.isOptionalCallExpression(expression)) {
    const callee = unwrapTransparent(expression.callee);
    if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return Ownership.Unknown;
    const method = getStaticMemberChain(callee)?.keys.at(-1);
    if (method === undefined || !pureMethodNames.has(method)) return Ownership.Unknown;
    const receiver = ownership(path, callee.object, depth + 1, context);
    if (receiver === Ownership.Unknown || callbackResultMethods.has(method)) return Ownership.Unknown;
    if (elementReturningMethods.has(method)) return receiver === Ownership.Deep ? Ownership.Deep : Ownership.Unknown;
    if (elementPreservingMethods.has(method)) return receiver;
    if (newCollectionMethods.has(method)) {
      return method === "concat" && receiver === Ownership.Deep &&
          expression.arguments.every((argument) => ownership(path, argument, depth + 1, context) === Ownership.Deep)
        ? Ownership.Deep
        : Ownership.Builtin;
    }
    // Every other builtin in the list returns a primitive (or `split`'s array of strings).
    return Ownership.Deep;
  }
  if (!t.isIdentifier(expression)) return Ownership.Unknown;
  const binding = path.scope.getBinding(expression.name);
  if (binding === undefined || binding.scope.path.isProgram()) return Ownership.Unknown;
  if (binding.kind === "param") {
    const trust = parameterOwnership(binding, context, depth + 1);
    return trust === Ownership.Unknown ? trust : Math.min(trust, mutationLimit(binding, context, depth + 1));
  }
  if (!binding.path.isVariableDeclarator() || binding.constantViolations.length > 0) return Ownership.Unknown;
  const declarator = binding.path.node;
  const init = declarator.init == null ? undefined : unwrapTransparent(declarator.init);
  if (init === undefined) return Ownership.Unknown;
  let trust: Ownership;
  if (t.isIdentifier(declarator.id)) {
    trust = ownership(binding.path, init, depth + 1, context);
  } else if (t.isArrayPattern(declarator.id) && (t.isCallExpression(init) || t.isOptionalCallExpression(init)) &&
    t.isIdentifier(unwrapTransparent(init.callee)) && stateHookNames.has((unwrapTransparent(init.callee) as t.Identifier).name)) {
    // `const [rows, setRows] = useState(...)`: React state, not an object with methods.
    trust = Ownership.Deep;
  } else {
    // `const { a, b: [c] } = props`: a part of trusted data is trusted, unless
    // a default value of other provenance can stand in for it.
    trust = ownership(binding.path, init, depth + 1, context) === Ownership.Deep &&
        patternDefaultsAreDeep(binding.path, declarator.id, depth, context)
      ? Ownership.Deep
      : Ownership.Unknown;
  }
  return trust === Ownership.Unknown ? trust : Math.min(trust, mutationLimit(binding, context, depth + 1));
}

function patternDefaultsAreDeep(path: NodePath, pattern: t.Node, depth: number, context: ReadContext): boolean {
  if (t.isAssignmentPattern(pattern)) {
    return ownership(path, pattern.right, depth + 1, context) === Ownership.Deep &&
      patternDefaultsAreDeep(path, pattern.left, depth, context);
  }
  if (t.isObjectPattern(pattern)) {
    return pattern.properties.every((property) =>
      patternDefaultsAreDeep(path, t.isRestElement(property) ? property.argument : property.value, depth, context));
  }
  if (t.isArrayPattern(pattern)) {
    return pattern.elements.every((element) => element === null || patternDefaultsAreDeep(path, element, depth, context));
  }
  if (t.isRestElement(pattern)) return patternDefaultsAreDeep(path, pattern.argument, depth, context);
  return true;
}

/** Does an array/object literal hold only Deep data properties (no methods, accessors, or other values)? */
function literalHoldsOnly(
  path: NodePath,
  node: t.ArrayExpression | t.ObjectExpression,
  depth: number,
  context: ReadContext,
): boolean {
  if (t.isArrayExpression(node)) {
    return node.elements.every((element) =>
      element === null || (!t.isSpreadElement(element) && ownership(path, element, depth + 1, context) === Ownership.Deep));
  }
  return node.properties.every((property) =>
    t.isObjectProperty(property) &&
    (!property.computed || ownership(path, property.key, depth + 1, context) === Ownership.Deep) &&
    ownership(path, property.value, depth + 1, context) === Ownership.Deep);
}

/**
 * A synchronous call whose callee this module cannot resolve to a function
 * body may still read signals while it runs, so it is captured unless the
 * callee is proven:
 * - a Hook or component-shaped name (never moved into a closure),
 * - a never-reassigned local or module function, or a function expression
 *   called in place (decided by its body instead),
 * - a standard global (`Math.max`, `JSON.stringify`, `String`) or an import
 *   from the library or React,
 * - a builtin-named method of data the function owns (`items.map`, `s.trim`;
 *   see `ownership`),
 * and, for a builtin that calls a function it is handed (`items.map(fn)`,
 * `JSON.stringify(v, fn)`), that function is proven as well.
 *
 * How the callee is reached does not matter: `(flag ? a : b).total()`,
 * `(0, a.total)()`, `getStore().total()`, and `[0].map(() => a)[0].total()`
 * are all captured, because none of them proves what `total` is.
 *
 * User code a proven builtin runs implicitly on a value that is not a tracked
 * alias -- `toString`/`valueOf` while converting, a getter, `toJSON`, an
 * iterator, `Symbol.species`, a Proxy trap -- is not followed, exactly as for
 * `"" + extStore`.
 */
function unresolvedCallMayRead(
  call: NodePath<t.CallExpression | t.OptionalCallExpression>,
  context: ReadContext,
): boolean {
  if (callNameIsHook(call.node.callee)) return false;
  const callee = unwrapTransparent(call.node.callee);
  // An IIFE (async included: it runs up to its first `await` right here) is
  // judged by its body where it is called.
  if (t.isArrowFunctionExpression(callee) || t.isFunctionExpression(callee)) return false;
  const global = standardGlobalCallee(call, callee);
  if (global !== undefined) return !calledBackIsKnown(call, globalCallbackArguments.get(global));
  if (t.isIdentifier(callee)) {
    if (isComponentName(callee.name) || resolveReferencedFunction(call, callee.name) !== undefined) return false;
    const binding = call.scope.getBinding(callee.name);
    if (binding === undefined) return true;
    const specifier = binding.path;
    if (specifier.isImportSpecifier() || specifier.isImportDefaultSpecifier() || specifier.isImportNamespaceSpecifier()) {
      return importIsForeign(specifier, context);
    }
    return true;
  }
  if (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) {
    const name = getStaticMemberChain(callee)?.keys.at(-1);
    if (name !== undefined && isComponentName(name)) return false;
    if (
      name !== undefined && pureMethodNames.has(name) && receiverIsLocalData(call, callee, context) &&
      calledBackIsKnown(call, builtinCallbackArguments.get(name))
    ) return false;
    if (resolveKeyedFunction(call, callee) !== undefined) return false;
    // `new Intl.NumberFormat().format(n)`: a fresh instance of a standard class has only its methods.
    if (
      name !== undefined && isStandardInstance(call, callee.object, context) &&
      calledBackIsKnown(call, builtinCallbackArguments.get(name))
    ) return false;
    // Namespace members of the library or React: `ns.signal(1)`.
    const root = unwrapTransparent(getStaticMemberChain(callee)?.root ?? callee);
    if (t.isIdentifier(root)) {
      const specifier = call.scope.getBinding(root.name)?.path;
      if (
        specifier !== undefined &&
        (specifier.isImportSpecifier() || specifier.isImportDefaultSpecifier() || specifier.isImportNamespaceSpecifier())
      ) {
        return importIsForeign(specifier, context);
      }
    }
    return true;
  }
  // Any other callee expression -- a conditional, a sequence, a call result --
  // selects its function at run time.
  return true;
}

/** `new Object(x)` returns `x` itself, so only these constructors are known to build a fresh instance. */
function freshInstanceConstructor(path: NodePath, node: t.NewExpression): boolean {
  const name = standardGlobalCallee(path, unwrapTransparent(node.callee));
  return name !== undefined && name !== "Object" && name !== "Function";
}

/** `new Map()`, or a never-reassigned local holding one whose methods are never replaced. */
function isStandardInstance(path: NodePath, node: t.Node, context: ReadContext): boolean {
  const expression = unwrapTransparent(node);
  if (t.isNewExpression(expression)) return freshInstanceConstructor(path, expression);
  if (!t.isIdentifier(expression)) return false;
  const binding = path.scope.getBinding(expression.name);
  if (
    binding === undefined || binding.constantViolations.length > 0 || !binding.path.isVariableDeclarator() ||
    !t.isIdentifier(binding.path.node.id) || binding.path.node.init == null
  ) return false;
  const init = unwrapTransparent(binding.path.node.init);
  return t.isNewExpression(init) && freshInstanceConstructor(binding.path, init) &&
    mutationLimit(binding, context, 0) !== Ownership.Unknown;
}

/**
 * Does `new C(...)` run module code? Only a standard constructor is proven;
 * `new Promise(executor)` also runs its executor right away.
 */
function constructorMayRead(path: NodePath<t.NewExpression>): boolean {
  const name = standardGlobalCallee(path, unwrapTransparent(path.node.callee));
  if (name === undefined) return !callNameIsHook(path.node.callee);
  return name === "Promise" && !calledBackIsKnown(path, 0);
}

/** Does a tagged template's tag run module code? Only a standard global (`String.raw`) or a library/React import is proven. */
function templateTagMayRead(path: NodePath<t.TaggedTemplateExpression>, context: ReadContext): boolean {
  const tag = unwrapTransparent(path.node.tag);
  if (callNameIsHook(tag) || standardGlobalCallee(path, tag) !== undefined) return false;
  const root = t.isMemberExpression(tag) || t.isOptionalMemberExpression(tag) ? unwrapTransparent(getStaticMemberChain(tag)?.root ?? tag) : tag;
  if (t.isIdentifier(root)) {
    const specifier = path.scope.getBinding(root.name)?.path;
    if (specifier !== undefined && (specifier.isImportSpecifier() || specifier.isImportDefaultSpecifier() || specifier.isImportNamespaceSpecifier())) {
      return importIsForeign(specifier, context);
    }
  }
  return true;
}

/**
 * `items.filter(isBig)`, `new Promise(executor)`: a named local or module
 * function handed to a call runs during it, exactly like an inline callback.
 * `calledBackIsKnown` only says such a function is one this module can see;
 * this is where its body is judged.
 */
function namedArgumentMayRead(
  call: NodePath<t.CallExpression | t.OptionalCallExpression | t.NewExpression>,
  context: ReadContext,
  trackedAliases: Set<object> = noAliases,
): boolean {
  if (callNameIsHook(call.node.callee)) return false;
  return (call.get("arguments") as NodePath[]).some((argument) => {
    const value = unwrapTransparentPath(argument);
    if (!value.isIdentifier()) return false;
    const target = resolveReferencedFunction(value, value.node.name);
    return target !== undefined && functionTargetMayReadTrackedValue(
      target, context.importSource, context.managedRuntimeSource, context.reactImportSource, true, trackedAliases,
    );
  });
}

/** Is an import from a module other than this library or React? */
function importIsForeign(specifier: NodePath, context: ReadContext): boolean {
  const source = (specifier.parentPath as NodePath<t.ImportDeclaration>).node.source.value;
  return source !== context.importSource && source !== context.managedRuntimeSource &&
    !isReactSource(source, context.reactImportSource);
}

const targetMayReadTrackedValue = new WeakMap<t.Node, boolean>();
const targetAliasReadCache = new WeakMap<Set<object>, { size: number; byFunction: WeakMap<t.Node, boolean> }>();

/** Cached `targetFunctionMayReadTrackedValue` for a resolved function. */
function functionTargetMayReadTrackedValue(
  target: NodePath<t.Function>,
  importSource: string,
  managedRuntimeSource: string,
  reactImportSource: string,
  // An async function runs up to its first `await` inside the call that
  // starts it, so a function a call runs counts its body. Its result is a
  // Promise, though, never the value read, so it is not an alias source.
  allowAsync = false,
  trackedAliases: Set<object> = noAliases,
): boolean {
  if ((target.node.async && !allowAsync) || target.node.generator) return false;
  if (targetAliasGraphMayRead(target, trackedAliases, importSource, managedRuntimeSource, reactImportSource)) return true;
  return cachedTargetMayRead(target, importSource, managedRuntimeSource, reactImportSource);
}

/**
 * A helper can read through a Deep Signal proxy captured by its caller even
 * though the helper contains no `.value` read itself. Check that case against
 * the caller's alias set, following only synchronous helper edges. Results are
 * scoped to that alias set and invalidated as its data-flow pass grows it.
 */
function targetAliasGraphMayRead(
  target: NodePath<t.Function>,
  trackedAliases: Set<object>,
  importSource: string,
  managedRuntimeSource: string,
  reactImportSource: string,
): boolean {
  if (trackedAliases.size === 0) return false;
  let entry = targetAliasReadCache.get(trackedAliases);
  if (entry === undefined || entry.size !== trackedAliases.size) {
    entry = { size: trackedAliases.size, byFunction: new WeakMap() };
    targetAliasReadCache.set(trackedAliases, entry);
  }
  const cached = entry.byFunction.get(target.node);
  if (cached !== undefined) return cached;

  const pending: NodePath<t.Function>[] = [target];
  const seen = new Set<t.Node>();
  let result = false;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current.node)) continue;
    seen.add(current.node);
    // A Hook in any reachable helper must never be moved into a generated
    // capture closure. Preserve the conservative behavior for Hook callers.
    if (functionCallsHook(current)) break;
    let readsAlias = false;
    (current.get("body") as NodePath).traverse({
      Function(nested) { nested.skip(); },
      Identifier(path) {
        if (!path.isReferencedIdentifier() || isDeferredReadContext(path, current)) return;
        const binding = path.scope.getBinding(path.node.name);
        if (binding !== undefined && trackedAliases.has(binding)) {
          readsAlias = true;
          path.stop();
        }
      },
    });
    if (readsAlias) {
      result = true;
      break;
    }
    for (const edge of synchronousScan(current, importSource, managedRuntimeSource, reactImportSource).edges) {
      pending.push(edge.target);
    }
  }
  entry.byFunction.set(target.node, result);
  return result;
}

function resolvedCallMayReadTrackedValue(
  call: NodePath<t.CallExpression | t.OptionalCallExpression | t.NewExpression>,
  context: ReadContext,
  trackedAliases: Set<object>,
): boolean {
  if (callNameIsHook(call.node.callee)) return false;
  const callee = unwrapTransparent(call.node.callee);
  const target = t.isIdentifier(callee)
    ? resolveReferencedFunction(call, callee.name)
    : t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)
      ? resolveKeyedFunction(call, callee)
      : undefined;
  // This is the call-site-specific addition to the existing generic helper
  // analysis. The caller still runs its normal fallback when this returns
  // false; do not recursively re-run that context-free analysis here.
  return target !== undefined && targetAliasGraphMayRead(
    target,
    trackedAliases,
    context.importSource,
    context.managedRuntimeSource,
    context.reactImportSource,
  );
}

/**
 * The answer depends only on the target function, so a helper called from
 * many sites is inspected once instead of once per call. A helper that
 * reaches itself again (recursion) is answered by its other reads meanwhile.
 */
function cachedTargetMayRead(
  target: NodePath<t.Function>,
  importSource: string,
  managedRuntimeSource: string,
  reactImportSource: string,
): boolean {
  const cached = targetMayReadTrackedValue.get(target.node);
  if (cached !== undefined) return cached;
  if (targetsInProgress.has(target.node)) {
    // Answered by its other reads for now; whoever asked must not keep the answer.
    provisionalAnswers += 1;
    return false;
  }
  targetsInProgress.add(target.node);
  const before = provisionalAnswers;
  let result: boolean;
  try {
    result = targetFunctionMayReadTrackedValue(target, importSource, managedRuntimeSource, reactImportSource);
  } finally {
    targetsInProgress.delete(target.node);
  }
  // `a` calls `b` calls `a`: `b`'s answer while `a` is open assumed `a` reads
  // nothing. Keep it only once no such assumption is pending, i.e. at the
  // outermost function of the cycle, or when it read anyway.
  if (result || provisionalAnswers === before || targetsInProgress.size === 0) {
    targetMayReadTrackedValue.set(target.node, result);
  }
  return result;
}

const targetsInProgress = new Set<t.Node>();
let provisionalAnswers = 0;

/** Per function: does it call a Hook and also read signals synchronously? */
const hookCallingReader = new WeakMap<t.Node, boolean>();

function targetFunctionMayReadTrackedValue(
  target: NodePath<t.Function>,
  importSource: string,
  managedRuntimeSource: string,
  reactImportSource: string,
): boolean {
  const identity = resolveComponentIdentity(target, reactImportSource);
  if (
    (isComponentIdentity(identity) || isHookIdentity(identity)) &&
    !isPlainCalledComponent(target) &&
    !isRenderCallback(target)
  ) {
    return false;
  }
  if (functionCallsHook(target)) return false;
  const inspection = inspectFunction(
    target,
    importSource,
    managedRuntimeSource,
    reactImportSource,
    undefined,
    true,
  );
  if (inspection.readsValue || hasDynamicCallTarget(target)) return true;
  // A call in the helper that this module cannot prove (`extStore.total()`,
  // a callback from its caller) may read signals just as a call written at
  // the call site would.
  const body = target.get("body") as NodePath;
  return bodyReadsTrackedValue(body, target, noAliases, { importSource, managedRuntimeSource, reactImportSource });
}

/** Does a synchronous helper invoke a function selected through a dynamic key? */
function hasDynamicCallTarget(functionPath: NodePath<t.Function>): boolean {
  let found = false;
  functionPath.traverse({
    Function(nested) { nested.skip(); },
    CallExpression(path) {
      const callee = unwrapTransparent(path.node.callee);
      if (
        (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
        callee.computed && getReadPropertyName(callee) === undefined
      ) {
        found = true;
        path.stop();
      }
    },
    OptionalCallExpression(path) {
      const callee = unwrapTransparent(path.node.callee);
      if (
        (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
        callee.computed && getReadPropertyName(callee) === undefined
      ) {
        found = true;
        path.stop();
      }
    },
  });
  return found;
}

const noAliases: Set<object> = new Set();

/** The bindings a declaration pattern introduces, as seen from `path`'s scope. */
function patternBindings(path: NodePath, node: t.Node): object[] {
  return Object.values(t.getBindingIdentifiers(node) as Record<string, t.Identifier>)
    .map((identifier) => path.scope.getBinding(identifier.name)!);
}

/**
 * The bindings that hold a value read through a tracked source (the `.value`
 * of a signal, or anything reached through it), so later reads of them
 * subscribe too. Each assignment-shaped statement is a flow from the bindings
 * its source mentions to the bindings it writes; the flows are closed with one
 * worklist, so the cost stays linear in the function however the statements
 * are ordered.
 */
function collectTrackedReadAliases(
  functionPath: NodePath<t.Function>,
  context: ReadContext,
): Set<object> {
  const trackedAliases = new Set<object>();
  // Per binding: the targets of every flow that mentions it.
  const dependents = new Map<object, object[][]>();
  const pending: object[] = [];
  const alias = (binding: object): void => {
    if (!trackedAliases.has(binding)) {
      trackedAliases.add(binding);
      pending.push(binding);
    }
  };
  const isLocalVariable = (binding: ReturnType<NodePath["scope"]["getBinding"]>): binding is NonNullable<typeof binding> =>
    binding !== undefined && (binding.kind === "const" || binding.kind === "let" || binding.kind === "var") &&
    binding.scope.getFunctionParent()?.path.node === functionPath.node;
  const resolvedCallReads = (call: NodePath<t.CallExpression | t.OptionalCallExpression>): boolean => {
    if (resolvedCallMayReadTrackedValue(call, context, trackedAliases)) return true;
    if (callNameIsHook(call.node.callee)) return false;
    const callee = unwrapTransparent(call.node.callee);
    const target = t.isIdentifier(callee)
      ? resolveReferencedFunction(call, callee.name)
      : t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)
        ? resolveKeyedFunction(call, callee)
        : undefined;
    return target !== undefined && functionTargetMayReadTrackedValue(
      target,
      context.importSource,
      context.managedRuntimeSource,
      context.reactImportSource,
    );
  };
  /**
   * Does `source` read a tracked value without help from any alias -- and if
   * not, which bindings does it mention (so the flow fires when one becomes an
   * alias)?
   */
  const scanSource = (source: NodePath, deps: Set<object>): boolean => {
    if (hasTrackedReadInExpression(source, functionPath, noAliases)) return true;
    let seeded = false;
    const reference = (candidate: NodePath<t.Identifier>): void => {
      if (!candidate.isReferencedIdentifier() || isDeferredReadContext(candidate, functionPath)) return;
      const binding = candidate.scope.getBinding(candidate.node.name);
      if (binding !== undefined) deps.add(binding);
    };
    const call = (candidate: NodePath<t.CallExpression | t.OptionalCallExpression>): void => {
      if (resolvedCallReads(candidate)) {
        seeded = true;
        candidate.stop();
      }
    };
    // `{ get total() { return count.value * 2 } }`: reading the getter is a
    // tracked read, and a getter that mentions an alias reads through it.
    const object = unwrapTransparentPath(source);
    if (object.isObjectExpression()) {
      for (const property of object.get("properties") as NodePath[]) {
        if (!property.isObjectMethod() || property.node.kind !== "get" || property.node.async) continue;
        const body = property.get("body");
        if (bodyReadsTrackedValue(body, property, noAliases, context)) return true;
        body.traverse({ Function(nested) { nested.skip(); }, Identifier: reference });
      }
    }
    if (source.isIdentifier()) reference(source);
    else if (source.isCallExpression() || source.isOptionalCallExpression()) call(source);
    if (seeded) return true;
    source.traverse({
      Function(nested) { nested.skip(); },
      Identifier: reference,
      CallExpression: call,
      OptionalCallExpression: call,
    });
    return seeded;
  };
  const flow = (targets: object[], sources: NodePath[]): void => {
    const deps = new Set<object>();
    for (const source of sources) {
      if (scanSource(source, deps)) {
        for (const target of targets) alias(target);
        return;
      }
    }
    for (const dep of deps) {
      const list = dependents.get(dep);
      if (list === undefined) dependents.set(dep, [targets]);
      else list.push(targets);
    }
  };
  // `visible.push(task)`, `box[0] = task`: a local container that receives an
  // alias holds tracked values from then on.
  const containerRoot = (path: NodePath): object | undefined => {
    let current: NodePath = path;
    while (current.isMemberExpression() || current.isOptionalMemberExpression() || isTransparentWrapper(current.node)) {
      current = (isTransparentWrapper(current.node) ? current.get("expression") : current.get("object")) as NodePath;
    }
    if (!current.isIdentifier()) return undefined;
    const binding = current.scope.getBinding(current.node.name);
    return isLocalVariable(binding) ? binding : undefined;
  };
  const containerMethods = new Set(["push", "unshift", "add", "set"]);
  const container = (call: NodePath<t.CallExpression | t.OptionalCallExpression>): void => {
    const callee = unwrapTransparentPath(call.get("callee") as NodePath);
    if (!callee.isMemberExpression() && !callee.isOptionalMemberExpression()) return;
    const method = getReadPropertyName(callee.node);
    if (method === undefined || !containerMethods.has(method)) return;
    const target = containerRoot(callee.get("object") as NodePath);
    if (target === undefined) return;
    flow([target], (call.get("arguments") as NodePath[]).map((argument) =>
      argument.isSpreadElement() ? argument.get("argument") as NodePath : argument));
  };
  functionPath.traverse({
    Function(nested) {
      nested.skip();
    },
    VariableDeclarator(path) {
      const init = path.get("init");
      if (!init.node) return;
      // Every name a pattern binds holds a value read through the tracked
      // source, whatever the pattern's shape (defaults, rest, arrays).
      flow(patternBindings(path, path.node.id), [init]);
    },
    AssignmentExpression(path) {
      // `let items; items = state.value.items;` aliases as a declaration would.
      const operator = path.node.operator;
      if (operator !== "=" && operator !== "||=" && operator !== "&&=" && operator !== "??=") return;
      const left = path.get("left");
      if (left.isIdentifier()) {
        const binding = path.scope.getBinding(left.node.name);
        if (binding === undefined || binding.scope.getFunctionParent()?.path.node !== functionPath.node) return;
        flow([binding], [path.get("right")]);
      } else if (left.isMemberExpression() || left.isOptionalMemberExpression()) {
        const target = containerRoot(left);
        if (target !== undefined) flow([target], [path.get("right")]);
      }
    },
    ForOfStatement(path) {
      // `for (const task of state.value.tasks) task.title`: each element of a
      // tracked iterable is read through the same deep proxy as its source.
      const left = path.get("left");
      if (left.isVariableDeclaration()) {
        flow(patternBindings(path, left.node.declarations[0]!.id), [path.get("right")]);
      } else if (left.isIdentifier()) {
        const binding = path.scope.getBinding(left.node.name);
        if (isLocalVariable(binding)) flow([binding], [path.get("right")]);
      }
    },
    CallExpression: container,
    OptionalCallExpression: container,
  });
  while (pending.length > 0) {
    for (const targets of dependents.get(pending.pop()!) ?? []) {
      for (const target of targets) alias(target);
    }
  }
  return trackedAliases;
}

function isWriteTarget(path: NodePath): boolean {
  let target = path;
  while (target.parentPath !== null) {
    const parent = target.parentPath;
    if (
      (parent.isMemberExpression() || parent.isOptionalMemberExpression()) &&
      parent.get("object").node === target.node
    ) {
      target = parent;
      continue;
    }
    if (
      (parent.isTSAsExpression() || parent.isTSTypeAssertion() || parent.isTSNonNullExpression()) &&
      parent.get("expression").node === target.node
    ) {
      target = parent;
      continue;
    }
    if (parent.isObjectProperty() && parent.get("value").node === target.node) {
      target = parent;
      continue;
    }
    if (parent.isRestElement() && parent.get("argument").node === target.node) {
      target = parent;
      continue;
    }
    if (parent.isAssignmentPattern() && parent.get("left").node === target.node) {
      target = parent;
      continue;
    }
    if (parent.isObjectPattern() && parent.node.properties.some((property) => property === target.node)) {
      target = parent;
      continue;
    }
    if (parent.isArrayPattern() && parent.node.elements.some((element) => element === target.node)) {
      target = parent;
      continue;
    }
    break;
  }
  const parent = target.parentPath;
  if (parent === null) return false;
  if (parent.isAssignmentExpression()) return parent.get("left") === target;
  if (parent.isUpdateExpression()) return parent.get("argument") === target;
  if (parent.isForInStatement() || parent.isForOfStatement()) {
    return parent.get("left").node === target.node;
  }
  return parent.isUnaryExpression({ operator: "delete" }) && parent.get("argument") === target;
}

function callNameIsHook(node: t.Node): boolean {
  const callee = unwrapTransparent(node);
  // `(flag ? useA : useB)()`, `(0, useA)()`: any function the callee may pick.
  if (t.isConditionalExpression(callee)) return callNameIsHook(callee.consequent) || callNameIsHook(callee.alternate);
  if (t.isLogicalExpression(callee)) return callNameIsHook(callee.left) || callNameIsHook(callee.right);
  if (t.isSequenceExpression(callee)) {
    const last = callee.expressions.at(-1);
    return last !== undefined && callNameIsHook(last);
  }
  const name = t.isIdentifier(callee)
    ? callee.name
    : t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)
      ? getStaticMemberChain(callee)?.keys.at(-1)
      : undefined;
  // React 19's `use` follows the same no-closure rule for this purpose.
  return name !== undefined && (isHookName(name) || name === "use");
}

/** Does evaluating this expression call a Hook outside nested functions? */
function expressionCallsHook(path: NodePath): boolean {
  if ((path.isCallExpression() || path.isOptionalCallExpression()) && callNameIsHook(path.node.callee)) return true;
  let found = false;
  const inspectCall = (call: NodePath<t.CallExpression | t.OptionalCallExpression>): void => {
    if (callNameIsHook(call.node.callee)) {
      found = true;
      call.stop();
    }
  };
  path.traverse({
    Function(nested) { nested.skip(); },
    CallExpression: inspectCall,
    OptionalCallExpression: inspectCall,
  });
  return found;
}

/**
 * Does an inline callback read a tracked value when it runs? Callbacks nested
 * in its own call arguments are followed too (`rows.map(r => r.cells.filter(c
 * => c.value))`), and so are the calls its body makes (`items.filter((x) =>
 * matches(x))` reads through `matches`); async, generator, Hook-calling, and
 * event-handler functions are not synchronous render reads.
 */
function inlineCallbackReadsTrackedValue(
  path: NodePath,
  trackedAliases: Set<object>,
  context: ReadContext,
): boolean {
  let target = path;
  while (target.isTSAsExpression() || target.isTSSatisfiesExpression() || target.isTSNonNullExpression() || target.isParenthesizedExpression()) {
    target = target.get("expression") as NodePath;
  }
  if (!target.isArrowFunctionExpression() && !target.isFunctionExpression()) return false;
  // An async callback runs up to its first `await` during the call; a
  // generator's body runs only when it is iterated.
  if (target.node.generator || functionCallsHook(target)) return false;
  return bodyReadsTrackedValue(target.get("body") as NodePath, target, trackedAliases, context);
}

/**
 * Does evaluating `body` (the body of `owner`, a callback or an accessor) read
 * a tracked value: directly, through a call that reaches one, or through a
 * callback it hands to a call?
 */
function bodyReadsTrackedValue(
  body: NodePath,
  owner: NodePath<t.Function>,
  trackedAliases: Set<object>,
  context: ReadContext,
): boolean {
  if (hasTrackedReadInExpression(body, owner, trackedAliases)) return true;
  const callReads = (call: NodePath<t.CallExpression | t.OptionalCallExpression | t.NewExpression>): boolean => {
    if (callNameIsHook(call.node.callee)) return false;
    // Resolve local helper closure reads with the current alias context before
    // the context-free external-call fallback recursively analyzes the helper
    // graph. This also keeps long helper chains iterative.
    if (resolvedCallMayReadTrackedValue(call, context, trackedAliases)) return true;
    if (call.isNewExpression() && constructorMayRead(call)) return true;
    if (
      !call.isNewExpression() &&
      (externalCallMayReadTrackedValue(
        call,
        owner,
        context.importSource,
        context.managedRuntimeSource,
        context.reactImportSource,
      ) || unresolvedCallMayRead(call, context))
    ) return true;
    return [call.get("callee") as NodePath, ...(call.get("arguments") as NodePath[])]
      .some((argument) => inlineCallbackReadsTrackedValue(argument, trackedAliases, context)) ||
      namedArgumentMayRead(call, context, trackedAliases);
  };
  // `traverse` does not visit its root, which is the call in an expression body.
  if ((body.isCallExpression() || body.isOptionalCallExpression() || body.isNewExpression()) && callReads(body)) {
    return true;
  }
  let found = false;
  const inspectCall = (call: NodePath<t.CallExpression | t.OptionalCallExpression | t.NewExpression>): void => {
    if (callReads(call)) {
      found = true;
      call.stop();
    }
  };
  body.traverse({
    Function(nested) { nested.skip(); },
    CallExpression: inspectCall,
    OptionalCallExpression: inspectCall,
    NewExpression: inspectCall,
    TaggedTemplateExpression(path) {
      if (templateTagMayRead(path, context)) {
        found = true;
        path.stop();
      }
    },
  });
  return found;
}

/**
 * A capture scope only sees reads made while it is open. When a tracked value
 * is handed to a call (`JSON.stringify(state.value.profile)`, a local helper)
 * or an inline callback reads one (`items.filter((item) => item.done.value)`,
 * an IIFE), the reads happen inside the call, so the whole call is captured.
 */
function callReadsTrackedValue(
  call: NodePath<t.CallExpression | t.OptionalCallExpression | t.NewExpression>,
  functionPath: NodePath<t.Function>,
  trackedAliases: Set<object>,
  context: ReadContext,
): boolean {
  if (callNameIsHook(call.node.callee)) return false;
  const callee = call.get("callee") as NodePath;
  if (inlineCallbackReadsTrackedValue(callee, trackedAliases, context)) return true;
  for (const argument of call.get("arguments") as NodePath[]) {
    const value = argument.isSpreadElement() ? argument.get("argument") as NodePath : argument;
    if (inlineCallbackReadsTrackedValue(value, trackedAliases, context)) return true;
    if (!value.isFunction() && hasTrackedReadInExpression(value, functionPath, trackedAliases)) return true;
  }
  return false;
}

/** `{ ...state.value.profile }` / `[...state.value.list]` read the source while spreading. */
function spreadsTrackedValue(
  path: NodePath<t.ObjectExpression | t.ArrayExpression>,
  functionPath: NodePath<t.Function>,
  trackedAliases: Set<object>,
): boolean {
  const entries = (path.isObjectExpression() ? path.get("properties") : path.get("elements")) as NodePath[];
  return entries.some((entry) =>
    entry.isSpreadElement() &&
    hasTrackedReadInExpression(entry.get("argument"), functionPath, trackedAliases));
}

/**
 * Managed codegen: capture statically proven synchronous `.value` reads and
 * runtime-key computed member reads in a short-lived scope. The latter are
 * candidates only: the runtime records a dependency only when the key resolves
 * to a tracked accessor. Alias data-flow is handled by the tracked-alias set;
 * unknown callback execution remains outside the proof boundary.
 */
/**
 * Callbacks this transform generates around captured reads. The top-level
 * `Function` visitor skips them: they are never components or Hooks, and
 * deciding on each one re-inspected every helper once per captured call.
 */
const generatedCaptureCallbacks = new WeakSet<t.Node>();

function generatedCallback(
  params: t.Identifier[],
  body: t.Expression | t.BlockStatement,
): t.ArrowFunctionExpression {
  const callback = t.arrowFunctionExpression(params, body);
  generatedCaptureCallbacks.add(callback);
  return callback;
}

/** Operators that run ToPrimitive/ToNumeric on object operands. `===` and `!==` do not coerce. */
const COERCING_BINARY_OPERATORS: ReadonlySet<string> = new Set([
  "+", "-", "*", "/", "%", "**", "<", ">", "<=", ">=", "==", "!=",
  "&", "|", "^", "<<", ">>", ">>>", "instanceof",
]);
const COERCING_COMPOUND_ASSIGNMENTS: ReadonlySet<string> = new Set([
  "+=", "-=", "*=", "/=", "%=", "**=", "&=", "|=", "^=", "<<=", ">>=", ">>>=",
]);

const HOOK_IN_CAPTURED_CALL_WARNING =
  "A Hook call shares this call with signal reads that only the call itself performs. " +
  "The managed transform keeps Hooks out of capture closures, so those reads are not tracked here. " +
  "Call the Hook in its own statement and pass its result to the call.";
const HOOK_CALLING_HELPER_WARNING =
  "This call runs a function that both calls a Hook and reads signals inside the caller's render. " +
  "The managed transform keeps Hooks out of capture closures, so those reads are not tracked here. " +
  "Render it as a component (<Title />) or make it a custom Hook (useTitle()) so it gets its own tracking.";
const HOOK_IN_CAPTURED_READ_WARNING =
  "A Hook call is nested inside this signal read expression. " +
  "The managed transform keeps Hooks out of capture closures, so this read is not tracked. " +
  "Call the Hook in its own statement and read the signal from its result.";

function captureTrackedReadExpressions(
  functionPath: NodePath<t.Function>,
  store: t.Identifier,
  importSource: string,
  managedRuntimeSource: string,
  reactImportSource: string,
  trackedAliases: Set<object>,
  options: InternalTransformOptions,
): void {
  const generated = new WeakSet<t.Node>();
  const context: ReadContext = { importSource, managedRuntimeSource, reactImportSource };
  const wrap = (path: NodePath<t.Expression>): void => {
    path.replaceWith(
      t.callExpression(
        t.memberExpression(t.cloneNode(store), t.identifier("capture")),
        [generatedCallback([], t.cloneNode(path.node, true))],
      ),
    );
    path.skip();
  };
  /**
   * `{Title()}` where `Title` calls a Hook and reads signals: its body runs in
   * this render but cannot be captured without moving the Hook into a closure.
   */
  const warnHookCallingHelperRead = (path: NodePath<t.CallExpression | t.OptionalCallExpression>): void => {
    const callee = unwrapTransparent(path.node.callee);
    const target = t.isIdentifier(callee)
      ? resolveReferencedFunction(path, callee.name)
      : t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)
        ? resolveKeyedFunction(path, callee)
        : undefined;
    if (target === undefined || target.node.async || target.node.generator) return;
    let reads = hookCallingReader.get(target.node);
    if (reads === undefined) {
      reads = functionCallsHook(target) &&
        inspectFunction(target, importSource, managedRuntimeSource, reactImportSource, undefined, true).readsValue;
      hookCallingReader.set(target.node, reads);
    }
    if (reads) reportWarning(options, "RFGS002", path, HOOK_CALLING_HELPER_WARNING);
  };
  /**
   * Wraps a whole coercing operation (`a + b`, a template literal, ...) when
   * an operand reads a tracked value: the coercion calls the operand's
   * `toString`/`valueOf`/`Symbol.toPrimitive`, which can read signals. Hooks
   * stay outside; their operands' own reads are still captured one by one.
   */
  const wrapCoercion = (path: NodePath<t.Expression>, operands: NodePath[]): void => {
    if (
      !operands.some((operand) => hasTrackedReadInExpression(operand, functionPath, trackedAliases)) ||
      isDeferredReadContext(path, functionPath) ||
      expressionCallsHook(path)
    ) return;
    wrap(path);
  };
  /** Would `visitCall` capture this call, or does it produce an iterator that reads when pulled? */
  const iteratedCallMayRead = (call: NodePath<t.CallExpression | t.OptionalCallExpression>): boolean => {
    const callee = unwrapTransparent(call.node.callee);
    const target = t.isIdentifier(callee)
      ? resolveReferencedFunction(call, callee.name)
      : t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)
        ? resolveKeyedFunction(call, callee)
        : undefined;
    if (target !== undefined) {
      return target.node.generator === true && !target.node.async &&
        targetFunctionMayReadTrackedValue(target, importSource, managedRuntimeSource, reactImportSource);
    }
    return unresolvedCallMayRead(call, context) ||
      externalCallMayReadTrackedValue(call, functionPath, importSource, managedRuntimeSource, reactImportSource);
  };
  const visitCall = (path: NodePath<t.CallExpression | t.OptionalCallExpression>): void => {
    if (generated.has(path.node)) {
      path.skip();
      return;
    }
    if (isDeferredReadContext(path, functionPath)) return;
    // A Hook call itself (`useEffect(() => ...)`, `useMemo(...)`) is never
    // captured and its callbacks belong to React, so there is nothing to warn
    // about here; reads in its arguments are still visited one by one.
    if (callNameIsHook(path.node.callee)) return;
    const callee = unwrapTransparentPath(path.get("callee") as NodePath);
    // Reads only the call itself performs: a tracked callee, a parameter or
    // helper invoked synchronously, or an inline callback it runs.
    const readsInsideCall =
      ((callee.isMemberExpression() || callee.isOptionalMemberExpression()) &&
        hasTrackedReadInExpression(callee, functionPath, trackedAliases)) ||
      (callee.isIdentifier() && path.scope.getBinding(callee.node.name)?.kind === "param") ||
      resolvedCallMayReadTrackedValue(path, context, trackedAliases) ||
      externalCallMayReadTrackedValue(path, functionPath, importSource, managedRuntimeSource, reactImportSource) ||
      [callee as NodePath, ...(path.get("arguments") as NodePath[])]
        .some((part) => inlineCallbackReadsTrackedValue(part.isSpreadElement() ? part.get("argument") as NodePath : part, trackedAliases, context)) ||
      namedArgumentMayRead(path, context, trackedAliases);
    // A callee the module cannot see into (a method of an imported object, a
    // function held in a variable) is captured as a precaution. Unlike the
    // reads above this is not proof, so a Hook sharing the call is left alone
    // without a warning.
    const unresolved = !readsInsideCall && unresolvedCallMayRead(path, context);
    if (!readsInsideCall && !unresolved && !callReadsTrackedValue(path, functionPath, trackedAliases, context)) {
      warnHookCallingHelperRead(path);
      return;
    }
    if (expressionCallsHook(path)) {
      // Never move a Hook call into a capture closure. Reads in the arguments
      // are still captured one by one as the traversal continues; reads the
      // call performs internally cannot be, so say so.
      if (readsInsideCall) reportWarning(options, "RFGS001", path, HOOK_IN_CAPTURED_CALL_WARNING);
      return;
    }
    wrap(path as NodePath<t.Expression>);
  };
  /**
   * `useStore().value.name`: evaluate the Hook in place, as authored, and
   * capture only the reads that follow it. Returns false when a Hook appears
   * anywhere other than the chain's base call.
   */
  const wrapAfterHookBase = (path: NodePath<t.MemberExpression | t.OptionalMemberExpression>): boolean => {
    let base: NodePath = path;
    while (base.isMemberExpression() || base.isOptionalMemberExpression()) {
      if (base.node.computed && expressionCallsHook(base.get("property") as NodePath)) return false;
      base = base.get("object") as NodePath;
    }
    if (!(base.isCallExpression() || base.isOptionalCallExpression()) || !callNameIsHook(base.node.callee)) return false;
    const result = path.scope.generateUidIdentifier("hookResult");
    const hookCall = t.cloneNode(base.node, true);
    base.replaceWith(t.cloneNode(result));
    const read = t.callExpression(
      generatedCallback([t.cloneNode(result)], t.callExpression(
        t.memberExpression(t.cloneNode(store), t.identifier("capture")),
        [generatedCallback([], t.cloneNode(path.node, true))],
      )),
      [hookCall],
    );
    generated.add(read);
    path.replaceWith(read);
    path.skip();
    visitHookCallArguments(path as unknown as NodePath<t.CallExpression>);
    return true;
  };
  /**
   * The extracted Hook call stays outside the capture closure, but the reads
   * in its own arguments are captured one by one, exactly as for a Hook call
   * visited directly. `call` is `(_hookResult => ...)(hookCall)`.
   */
  const visitHookCallArguments = (call: NodePath<t.CallExpression>): void => {
    (call.get("arguments")[0] as NodePath).traverse(visitor);
  };
  /**
   * Splits `useStore().value.items` into the Hook call, evaluated in place by
   * the caller, and the read that follows it on `_hookResult`. Returns
   * undefined when a Hook appears anywhere other than the chain's base.
   * Mutates `path`; the caller replaces it.
   */
  const splitHookBase = (
    path: NodePath<t.Expression>,
    scope: NodePath["scope"],
  ): { result: t.Identifier; hookCall: t.Expression; read: t.Expression } | undefined => {
    let base: NodePath = path;
    while (base.isMemberExpression() || base.isOptionalMemberExpression() || isTransparentWrapper(base.node)) {
      if ((base.isMemberExpression() || base.isOptionalMemberExpression()) && base.node.computed &&
        expressionCallsHook(base.get("property") as NodePath)) return undefined;
      base = (isTransparentWrapper(base.node) ? base.get("expression") : base.get("object")) as NodePath;
    }
    if (!(base.isCallExpression() || base.isOptionalCallExpression()) || !callNameIsHook(base.node.callee)) return undefined;
    const result = scope.generateUidIdentifier("hookResult");
    const hookCall = t.cloneNode(base.node, true);
    base.replaceWith(t.cloneNode(result));
    return { result, hookCall, read: t.cloneNode(path.node, true) };
  };
  /**
   * `KIND { ...authored pattern } = INIT` evaluated inside one capture, with
   * the bound names handed back out: every read the pattern performs
   * (property getters, defaults, rest, array iteration) happens in its
   * authored order inside the capture.
   */
  const capturedDestructuring = (
    kind: t.VariableDeclaration["kind"],
    pattern: t.Node,
    init: t.Expression,
  ): t.VariableDeclaration => {
    const names = Object.keys(t.getBindingIdentifiers(pattern));
    const handOut = (): t.ObjectExpression =>
      t.objectExpression(names.map((name) => t.objectProperty(t.identifier(name), t.identifier(name), false, true)));
    const call = t.callExpression(
      t.memberExpression(t.cloneNode(store), t.identifier("capture")),
      [generatedCallback([], t.blockStatement([
        t.variableDeclaration("const", [t.variableDeclarator(t.cloneNode(pattern, true) as t.ObjectPattern | t.ArrayPattern, t.cloneNode(init, true))]),
        t.returnStatement(handOut()),
      ]))],
    );
    generated.add(call);
    const outer = t.objectPattern(names.map((name) => t.objectProperty(t.identifier(name), t.identifier(name), false, true)));
    return t.variableDeclaration(kind, [t.variableDeclarator(outer, call)]);
  };
  const visitMember = (path: NodePath<t.MemberExpression | t.OptionalMemberExpression>): void => {
    // `!`, `as`, and `satisfies` erase to nothing, so the slot that decides
    // whether this member is the object of a longer chain, a call's callee
    // (whose `this` must stay attached), or a tagged template's tag is the
    // one above those wrappers.
    const slot = climbTransparentWrappers(path);
    const parent = slot.parentPath;
    if (
      ((parent?.isMemberExpression() || parent?.isOptionalMemberExpression()) && parent.node.object === slot.node) ||
      ((parent?.isCallExpression() || parent?.isOptionalCallExpression()) && parent.node.callee === slot.node) ||
      (parent?.isTaggedTemplateExpression() && parent.node.tag === slot.node) ||
      isWriteTarget(path) ||
      !hasTrackedReadInMemberChain(path, functionPath, trackedAliases)
    ) return;
    wrapMemberRead(path);
  };
  const wrapMemberRead = (path: NodePath<t.MemberExpression | t.OptionalMemberExpression>): void => {
    if (!expressionCallsHook(path)) {
      wrap(path as NodePath<t.Expression>);
      return;
    }
    if (!wrapAfterHookBase(path)) reportWarning(options, "RFGS001", path, HOOK_IN_CAPTURED_READ_WARNING);
  };
  const visitor: Visitor = {
    Function(path) {
      // Reads inside another function need a call-site boundary. Capturing the
      // body itself would leave a stale handle in callbacks that escape render;
      // known synchronous helper/render-callback calls are wrapped as a whole
      // by the CallExpression visitor below.
      path.skip();
    },
    CallExpression: { enter: visitCall },
    OptionalCallExpression: { enter: visitCall },
    NewExpression: {
      enter(path) {
        const callee = path.get("callee");
        if (
          (hasTrackedReadInExpression(callee, functionPath, trackedAliases) ||
            callReadsTrackedValue(path, functionPath, trackedAliases, context) ||
            namedArgumentMayRead(path, context, trackedAliases) ||
            constructorMayRead(path)) &&
          !expressionCallsHook(path) &&
          !isDeferredReadContext(path, functionPath)
        ) {
          wrap(path as NodePath<t.Expression>);
        }
      },
    },
    ForOfStatement: {
      enter(path) {
        // The loop pulls each element after the iterable expression returns,
        // outside any capture. `iterate` captures the source, GetIterator, and
        // each `next()`/`return()` call as the loop makes it, so laziness,
        // early exit, mutation during iteration, and iterator closing stay
        // exactly as authored.
        const right = path.get("right");
        // A `for...in` already converted below carries its generated source.
        if (path.node.await || generated.has(right.node)) return;
        if (!hasTrackedReadInExpression(right, functionPath, trackedAliases)) {
          // `for (const v of gen())`: a call that runs module code produces
          // the iterator, and the loop pulls from it later -- outside the
          // capture the call itself would get.
          const source = unwrapTransparentPath(right);
          if (
            !(source.isCallExpression() || source.isOptionalCallExpression()) ||
            callNameIsHook(source.node.callee) || expressionCallsHook(source) ||
            !iteratedCallMayRead(source)
          ) return;
        }
        const iterate = (source: t.Expression): t.CallExpression => t.callExpression(
          t.memberExpression(t.cloneNode(store), t.identifier("iterate")),
          [generatedCallback([], source)],
        );
        let captured: t.CallExpression;
        let hookSplit = false;
        if (expressionCallsHook(right)) {
          // `for (const item of useTodos().value.items)`: call the Hook in
          // place, then iterate what is read from its result.
          const split = splitHookBase(right as NodePath<t.Expression>, path.scope);
          if (split === undefined) {
            reportWarning(options, "RFGS001", right, HOOK_IN_CAPTURED_READ_WARNING);
            return;
          }
          captured = t.callExpression(generatedCallback([split.result], iterate(split.read)), [split.hookCall]);
          hookSplit = true;
        } else {
          captured = iterate(t.cloneNode(right.node, true) as t.Expression);
        }
        generated.add(captured);
        right.replaceWith(captured);
        right.skip();
        if (hookSplit) visitHookCallArguments(right as unknown as NodePath<t.CallExpression>);

        // A destructuring loop head reads from each element after the step,
        // outside the iteration's captures. Bind the element to a temporary
        // and evaluate the authored pattern inside a capture in the body.
        const left = path.get("left");
        if (left.isObjectPattern() || left.isArrayPattern()) {
          // `for ({ a } of items)` assigns existing variables: bind the element
          // to a temporary and perform the authored assignment inside a
          // capture first thing in the body, in the same order as before.
          const item = path.scope.generateUidIdentifier("item");
          const assignment = t.callExpression(
            t.memberExpression(t.cloneNode(store), t.identifier("capture")),
            [generatedCallback([], t.assignmentExpression("=", t.cloneNode(left.node, true), t.cloneNode(item)))],
          );
          generated.add(assignment);
          left.replaceWith(t.variableDeclaration("const", [t.variableDeclarator(item)]));
          left.skip();
          // The authored body stays in its own block, so a default or
          // computed target in the pattern still resolves in the scope the
          // loop head had, never to a name the body declares.
          const body = path.get("body");
          body.replaceWith(t.blockStatement([t.expressionStatement(assignment), body.node as t.Statement]));
          return;
        }
        if (!left.isVariableDeclaration()) return;
        const declarator = left.node.declarations[0];
        if (declarator === undefined || t.isIdentifier(declarator.id)) return;
        const item = path.scope.generateUidIdentifier("item");
        const destructured = capturedDestructuring(left.node.kind, declarator.id, t.cloneNode(item));
        left.replaceWith(t.variableDeclaration(left.node.kind, [t.variableDeclarator(item)]));
        left.skip();
        // The pattern's names are declared next to the authored body, which
        // stays in its own nested block: defaults resolve outside the body's
        // declarations and the body may redeclare a bound name.
        const body = path.get("body");
        body.replaceWith(t.blockStatement([destructured, body.node as t.Statement]));
        const [inserted] = (path.get("body") as NodePath<t.BlockStatement>).get("body");
        // The names now bind inside the wrapper; keep them tracked aliases so
        // later reads such as `entry.n` are captured too.
        inserted!.scope.registerDeclaration(inserted!);
        for (const name of Object.keys(t.getBindingIdentifiers(declarator.id))) {
          const binding = inserted!.scope.getBinding(name);
          if (binding !== undefined) trackedAliases.add(binding);
        }
      },
    },
    ForInStatement: {
      enter(path) {
        // The key enumeration (own and inherited, via proxy traps) happens
        // when the loop starts, outside any capture. `forIn` enumerates inside
        // one and hands the keys out lazily, skipping keys deleted before
        // their turn. It is a `for...of` over those keys from here on.
        const right = path.get("right");
        if (!hasTrackedReadInExpression(right, functionPath, trackedAliases) || isDeferredReadContext(path, functionPath)) return;
        const forIn = (source: t.Expression): t.CallExpression => t.callExpression(
          t.memberExpression(t.cloneNode(store), t.identifier("forIn")),
          [generatedCallback([], source)],
        );
        let captured: t.CallExpression;
        let hookSplit = false;
        if (expressionCallsHook(right)) {
          const split = splitHookBase(right as NodePath<t.Expression>, path.scope);
          if (split === undefined) {
            reportWarning(options, "RFGS001", right, HOOK_IN_CAPTURED_READ_WARNING);
            return;
          }
          captured = t.callExpression(generatedCallback([split.result], forIn(split.read)), [split.hookCall]);
          hookSplit = true;
        } else {
          captured = forIn(t.cloneNode(right.node, true) as t.Expression);
        }
        generated.add(captured);
        path.replaceWith(t.forOfStatement(path.node.left, captured, path.node.body));
        const converted = (path as unknown as NodePath<t.ForOfStatement>).get("right");
        converted.skip();
        if (hookSplit) visitHookCallArguments(converted as unknown as NodePath<t.CallExpression>);
      },
    },
    VariableDeclarator: {
      enter(path) {
        // Patterns the static expansion did not take (array patterns,
        // defaults, rest, `let`) read the source while they bind. Evaluate
        // the authored declaration inside one capture and hand its bindings out.
        const id = path.get("id");
        const init = path.get("init");
        if ((!id.isObjectPattern() && !id.isArrayPattern()) || !init.node) return;
        if (!hasTrackedReadInExpression(init, functionPath, trackedAliases) || isDeferredReadContext(path, functionPath)) return;
        if (expressionCallsHook(init)) {
          const hookCall = unwrapTransparentPath(init);
          if (
            (hookCall.isCallExpression() || hookCall.isOptionalCallExpression()) &&
            callNameIsHook(hookCall.node.callee)
          ) {
            // The Hook itself and its destructuring stay in place. Reads in
            // its arguments are visited and captured individually below, so
            // this common `useState(signal.value)` form does not lose tracking.
            return;
          }
          reportWarning(options, "RFGS001", init, HOOK_IN_CAPTURED_READ_WARNING);
          return;
        }
        const declaration = path.parentPath;
        if (!declaration.isVariableDeclaration()) return;
        const replacement = capturedDestructuring(declaration.node.kind, id.node, init.node);
        path.replaceWith(replacement.declarations[0]!);
        path.skip();
      },
    },
    AssignmentExpression: {
      enter(path) {
        // `({ a } = state.value)` and `state.value.count ??= 1` read before
        // they write; capture the whole assignment.
        const left = path.get("left");
        // `text += state.value.tags` coerces the right operand after the read.
        if (
          COERCING_COMPOUND_ASSIGNMENTS.has(path.node.operator) &&
          (left.isIdentifier() || left.isMemberExpression()) &&
          hasTrackedReadInExpression(path.get("right"), functionPath, trackedAliases) &&
          !isDeferredReadContext(path, functionPath) &&
          !expressionCallsHook(path)
        ) {
          wrap(path as NodePath<t.Expression>);
          return;
        }
        const destructuring = path.node.operator === "=" && (left.isObjectPattern() || left.isArrayPattern());
        // The target chain of `state.value.count ??= 1` is read, although
        // the generic read checks treat assignment targets as writes only.
        const targetReadsTrackedValue = (): boolean => {
          let current: NodePath = left;
          while (current.isMemberExpression() || current.isOptionalMemberExpression() || isTransparentWrapper(current.node)) {
            if ((current.isMemberExpression() || current.isOptionalMemberExpression()) &&
              getTrackedReadPropertyName(current) === "value") return true;
            current = (isTransparentWrapper(current.node) ? current.get("expression") : current.get("object")) as NodePath;
          }
          return current.isIdentifier() && trackedAliases.has(current.scope.getBinding(current.node.name) as object);
        };
        const readingWrite = path.node.operator !== "=" &&
          (left.isMemberExpression() || left.isOptionalMemberExpression()) && targetReadsTrackedValue();
        if (!destructuring && !readingWrite) return;
        if (destructuring && !hasTrackedReadInExpression(path.get("right"), functionPath, trackedAliases)) return;
        if (isDeferredReadContext(path, functionPath)) return;
        if (expressionCallsHook(path)) {
          reportWarning(options, "RFGS001", path, HOOK_IN_CAPTURED_READ_WARNING);
          return;
        }
        wrap(path as NodePath<t.Expression>);
      },
    },
    UpdateExpression: {
      enter(path) {
        // `count.value++` and `state.value.count++` read the old value before
        // writing. Capturing the whole operator preserves prefix/postfix return
        // values, getter/setter order, and any proxy/key evaluation.
        if (
          hasTrackedReadInExpression(path.get("argument"), functionPath, trackedAliases) &&
          !isDeferredReadContext(path, functionPath) &&
          !expressionCallsHook(path)
        ) wrap(path as NodePath<t.Expression>);
      },
    },
    JSXSpreadAttribute: {
      enter(path) {
        // `<p {...state.value.props} />` copies the props inside the JSX
        // runtime, after the source read. Copy them inside the capture.
        const argument = path.get("argument");
        if (!hasTrackedReadInExpression(argument, functionPath, trackedAliases) || isDeferredReadContext(path, functionPath)) return;
        if (expressionCallsHook(argument)) {
          reportWarning(options, "RFGS001", argument, HOOK_IN_CAPTURED_READ_WARNING);
          return;
        }
        const copied = t.callExpression(
          t.memberExpression(t.cloneNode(store), t.identifier("capture")),
          [generatedCallback([], t.objectExpression([t.spreadElement(t.cloneNode(argument.node, true))]))],
        );
        generated.add(copied);
        argument.replaceWith(copied);
        argument.skip();
      },
    },
    BinaryExpression: {
      enter(path) {
        // `"key" in state.value.profile` runs the proxy `has` trap after the
        // right operand has been evaluated.
        if (
          path.node.operator === "in" &&
          hasTrackedReadInExpression(path.get("right"), functionPath, trackedAliases) &&
          !expressionCallsHook(path)
        ) {
          wrap(path as NodePath<t.Expression>);
          return;
        }
        // `"" + state.value.tags` or `state.value.tags < "b"` coerce the
        // operand (ToPrimitive: `toString`, `valueOf`, `Symbol.toPrimitive`)
        // after the read has returned. Capture the whole operation.
        if (COERCING_BINARY_OPERATORS.has(path.node.operator) && !t.isPrivateName(path.node.left)) {
          wrapCoercion(path as NodePath<t.Expression>, [path.get("left") as NodePath, path.get("right") as NodePath]);
        }
      },
    },
    UnaryExpression: {
      enter(path) {
        if (path.node.operator === "delete") {
          // Deleting a nested property still evaluates the signal-backed base
          // and can invoke reactive Proxy traps. Preserve the delete boolean by
          // capturing the complete operation, while a direct `delete s.value`
          // remains an ordinary property deletion with no getter read.
          if (
            hasTrackedReadInExpression(path.get("argument"), functionPath, trackedAliases) &&
            !isDeferredReadContext(path, functionPath) &&
            !expressionCallsHook(path)
          ) wrap(path as NodePath<t.Expression>);
        } else if (path.node.operator === "+" || path.node.operator === "-" || path.node.operator === "~") {
          wrapCoercion(path as NodePath<t.Expression>, [path.get("argument")]);
        }
      },
    },
    TemplateLiteral: {
      enter(path) {
        // `${state.value.tags}` coerces its operands after they were read. A
        // tagged template's quasi hands the tag raw strings and values, so
        // nothing is coerced there.
        const parent = path.parentPath;
        if (parent.isTaggedTemplateExpression() && parent.node.quasi === path.node) return;
        wrapCoercion(path as NodePath<t.Expression>, path.get("expressions") as NodePath[]);
      },
    },
    ObjectExpression: {
      enter(path) {
        if (spreadsTrackedValue(path, functionPath, trackedAliases) && !expressionCallsHook(path)) {
          wrap(path as NodePath<t.Expression>);
        }
      },
    },
    ArrayExpression: {
      enter(path) {
        if (spreadsTrackedValue(path, functionPath, trackedAliases) && !expressionCallsHook(path)) {
          wrap(path as NodePath<t.Expression>);
        }
      },
    },
    TaggedTemplateExpression: {
      enter(path) {
        const tag = path.get("tag");
        if (
          !(hasTrackedReadInExpression(tag, functionPath, trackedAliases) || templateTagMayRead(path, context)) ||
          isDeferredReadContext(path, functionPath)
        ) return;
        if (expressionCallsHook(path)) {
          // The tag keeps its `this` only when the whole tagged template is
          // captured, which a Hook in the template forbids.
          reportWarning(options, "RFGS001", path, HOOK_IN_CAPTURED_CALL_WARNING);
          return;
        }
        wrap(path as NodePath<t.Expression>);
      },
    },
    MemberExpression: { enter: visitMember },
    OptionalMemberExpression: { enter: visitMember },
  };
  functionPath.get("body").traverse(visitor);
}

/**
 * A plain identifier declarator can become a tracked alias directly, but a
 * destructuring pattern hides each property read from that analysis. Expand
 * only a `const` object pattern made entirely of static identifier keys,
 * identifier bindings, and nested object patterns. The initializer is moved
 * to one generated declarator, then each property read is represented once as
 * an ordinary member expression; the normal capture pass and alias analysis
 * handle those reads.
 *
 * Defaults, rest, computed keys, mutable declarations, reassigned bindings,
 * and patterns with TS annotations stay untouched because rewriting them
 * needs additional proof to preserve their binding/evaluation semantics.
 */
function expandTrackedObjectDestructuring(
  functionPath: NodePath<t.Function>,
  trackedAliases: Set<object>,
): boolean {
  const candidates: NodePath<t.VariableDeclarator>[] = [];
  functionPath.get("body").traverse({
    Function(nested) { nested.skip(); },
    VariableDeclarator(candidate) {
      candidates.push(candidate);
    },
  });

  const expansions = new Map<t.VariableDeclaration, Map<t.VariableDeclarator, t.VariableDeclarator[]>>();
  for (const candidate of candidates) {
    if (candidate.removed || !candidate.isVariableDeclarator()) continue;
    const declaration = candidate.parentPath;
    const init = candidate.get("init");
    const bindings = getStaticConstDestructuredBindings(candidate);
    if (
      bindings === undefined ||
      !init.node ||
      !hasTrackedReadInExpression(init, functionPath, trackedAliases)
    ) continue;

    const source = candidate.scope.generateUidIdentifier("trackedSource");
    const expanded: t.VariableDeclarator[] = [
      t.variableDeclarator(t.cloneNode(source), t.cloneNode(init.node, true)),
    ];
    const appendProperties = (pattern: StaticConstObjectPattern, base: t.Identifier): void => {
      for (const property of pattern.properties) {
        if ("id" in property) {
          expanded.push(t.variableDeclarator(
            t.cloneNode(property.id),
            t.memberExpression(t.cloneNode(base), t.cloneNode(property.key)),
          ));
        } else {
          const nested = candidate.scope.generateUidIdentifier("trackedNested");
          expanded.push(t.variableDeclarator(
            t.cloneNode(nested),
            t.memberExpression(t.cloneNode(base), t.cloneNode(property.key)),
          ));
          appendProperties(property.pattern, nested);
        }
      }
    };
    appendProperties(bindings, source);
    let declarations = expansions.get(declaration.node);
    if (declarations === undefined) {
      declarations = new Map();
      expansions.set(declaration.node, declarations);
    }
    declarations.set(candidate.node, expanded);
  }

  // The alias collector already closes over statically proven const aliases,
  // including lexically ordered destructuring chains. Apply every proven
  // replacement from this snapshot together so we rebuild scopes once per
  // function instead of once per destructuring. Keep declaration order intact:
  // each source and its extracted properties stay at the original declarator's
  // position among neighboring initializers.
  for (const [declaration, replacements] of expansions) {
    declaration.declarations = declaration.declarations.flatMap((candidate) =>
      replacements.get(candidate) ?? [candidate]
    );
  }
  return expansions.size > 0;
}

/** Codegen: add a top-level capture hook and wrap proven synchronous reads. */
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
  const relocated = relocateTrackedParameters(path, state.typeScript);
  if (path.get("params").some(containsSyntacticValueRead)) {
    warnUncapturedParameterRead(path, options);
  }
  const originalStatements = body.isBlockStatement()
    ? statements.slice(explicit ? 1 : 0).map((statement) => statement.node)
    : [t.returnStatement(body.node as t.Expression)];
  const directives = body.isBlockStatement() ? body.node.directives : [];
  body.replaceWith(t.blockStatement([...relocated, ...originalStatements]));
  const readContext: ReadContext = {
    importSource: options.importSource,
    managedRuntimeSource: `${options.importSource}/runtime`,
    reactImportSource: options.reactImportSource,
  };
  let trackedAliases = collectTrackedReadAliases(path, readContext);
  while (expandTrackedObjectDestructuring(path, trackedAliases)) {
    path.scope.crawl();
    trackedAliases = collectTrackedReadAliases(path, readContext);
  }
  captureTrackedReadExpressions(
    path,
    store,
    options.importSource,
    `${options.importSource}/runtime`,
    options.reactImportSource,
    trackedAliases,
    options,
  );
  const transformedBody = t.blockStatement([declaration, ...(body.node as t.BlockStatement).body]);
  transformedBody.directives = directives;
  if (options.reactCompiler === "auto") addNoMemoDirective(transformedBody);
  body.replaceWith(transformedBody);
  path.scope.crawl();
  invalidateThisReferences(path);
  // The author's own call is gone; whether its import is now dead can only be
  // answered once every function in the file has been visited, so record it and
  // let `Program.exit` decide.
  if (absorbedImport !== undefined) state.absorbedImports.push(absorbedImport);
  markTransformed(state);
}

/**
 * Drops an `import { useSignalTracking } from "<importSource>"` the managed transform
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

// The per-file JSX pragmas every JSX compiler reads from a comment:
// `@jsxImportSource`, `@jsxRuntime`, `@jsx` and `@jsxFrag`.
const jsxPragmaComment = /@jsx(?:ImportSource|Runtime|Frag)?(?![\w$])/;

/**
 * Puts a per-file JSX pragma back in front of the code once a generated import
 * has been placed ahead of it.
 *
 * In a file with no import of its own, `addRuntimeImport` has to put the
 * runtime import first, and Babel keeps the author's leading comments attached
 * to the statement they were written above -- so a first-line
 * `/** @jsxImportSource react-fine-grained-signals *\/` ends up printed after
 * that import. Oxc (and so Vite) only honors a JSX pragma that comes before the
 * first statement, so the pragma was silently ignored: the file compiled against
 * `react/jsx-runtime`, and a signal child then reached React as an object and
 * threw on mount.
 *
 * Every leading comment up to and including the last pragma moves onto the
 * first generated import, in order, so a license header above the pragma stays
 * above it; comments after the last pragma -- typically the first statement's
 * own doc comment -- stay where they were. A file without a pragma is left
 * exactly as it was. This runs at `Program.exit`, after every function has been
 * decided, because `@signalTracking` / `@noSignalTracking` are read from those
 * same leading comments.
 */
function keepJsxPragmasFirst(programPath: NodePath<t.Program>, state: PluginState): void {
  if (!state.importFree) return;
  const body = programPath.node.body;
  // The file had no imports, so any at the top are the ones this walk added.
  const authored = body.findIndex((statement) => !t.isImportDeclaration(statement));
  if (authored <= 0) return;
  const comments = body[authored]!.leadingComments;
  if (comments === null || comments === undefined) return;
  let lastPragma = -1;
  for (const [index, comment] of comments.entries()) {
    if (jsxPragmaComment.test(comment.value)) lastPragma = index;
  }
  if (lastPragma === -1) return;
  const generated = body[0]!;
  const staying = comments.slice(lastPragma + 1);
  generated.leadingComments = [...(generated.leadingComments ?? []), ...comments.slice(0, lastPragma + 1)];
  body[authored]!.leadingComments = staying;
  // After a shebang, Babel also records these comments as trailing comments of
  // the `#!` line, and prints them from there first; the ones that stay with the
  // statement have to go from that copy too, or they print above the import.
  const interpreter = programPath.node.interpreter;
  if (interpreter?.trailingComments) {
    interpreter.trailingComments = interpreter.trailingComments.filter((comment) => !staying.includes(comment));
  }
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
          state.managedRuntimeImports = findRuntimeImports(
            path,
            managedRuntimeSource,
            "useSignalCapture",
          );
          state.directImports = findRuntimeImports(path, options.importSource, "useSignalTracking");
          state.absorbedImports = [];
          state.typeScript = state.file.opts.parserOpts?.plugins?.includes("typescript") === true;
          state.importFree = !path.node.body.some((statement) => t.isImportDeclaration(statement));
          (state.file.metadata as Record<string, unknown>)[transformedMetadataKey] = false;
        },
        exit(path, state) {
          removeAbsorbedImports(path, state);
          keepJsxPragmasFirst(path, state);
        },
      },
      Function(path, state) {
        if (generatedCaptureCallbacks.has(path.node)) return;
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
 * - explicit opt-in needs `useSignalTracking`; annotation opt-in and opt-out
 *   need `@signalTracking` or `@noSignalTracking`;
 * - `auto` needs a `.value` read, so it needs the text `value`;
 * - `all` additionally wraps JSX components, so it needs a `<` -- but its
 *   custom-hook rule still needs a `.value` read.
 *
 * Each test is a plain substring scan and each one is deliberately wider than
 * what the AST check accepts, so this can only ever bail out on files the walk
 * would have rejected anyway.
 */
function mightTransform(code: string, mode: ReactFineGrainedSignalsMode): boolean {
  if (
    code.includes("useSignalTracking") ||
    code.includes("@signalTracking") ||
    code.includes("@noSignalTracking")
  ) return true;
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
    // A stack overflow is not a parse failure: the module parsed, and the
    // analysis recursed deeper than the JavaScript stack allows (in practice a
    // chain of several hundred same-module helpers that call each other).
    // Saying "could not parse" would send the author looking for a syntax error.
    if (error instanceof RangeError && /call stack/i.test(detail)) {
      throw new Error(
        `unplugin-react-fine-grained-signals could not analyze ${cleanId}: ` +
          `its function calls nest deeper than the JavaScript call stack allows (${detail}). ` +
          "This usually means a chain of several hundred same-module helper functions that " +
          "call each other; split the chain up or move part of it to another module.",
        { cause: error },
      );
    }
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
  if (result.map === null) return { code: result.code };
  const { file, names, sources, sourcesContent, ...map } = result.map;
  return {
    code: result.code,
    map: {
      ...map,
      names: [...names],
      // Preserve source indexes from the mapping data if Babel emitted an
      // unknown source entry; bundler source-map inputs require strings.
      sources: sources.map((source) => source ?? ""),
      ...(sourcesContent === undefined ? {} : { sourcesContent: [...sourcesContent] }),
      ...(file === null ? {} : { file }),
    },
  };
}
