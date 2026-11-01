import { createElement, Fragment } from "react";
import type * as React from "react";
import { isSignal } from "../core/index.js";
import { normalizeChild } from "./jsx-children.js";

/**
 * What the full and lite JSX runtimes share: which Signal-valued host props
 * are bound, passed through or rejected, how `children` is normalized, and
 * how each JSX entry hands props to React. Each runtime supplies only its own
 * host-prop transform, so the two cannot drift on anything else.
 */

export type HostProps = Record<string, unknown>;

/**
 * The host props the full runtime binds directly when given a Signal (`style`
 * as a whole Signal; Signal entries inside a plain style object are bound
 * too). The lite runtime rejects exactly these, because it has no bindings.
 */
const DIRECT_SIGNAL_PROP_NAMES = new Set(["title", "id", "className", "hidden", "disabled", "style"]);

export function isDirectSignalPropName(name: string): boolean {
  return DIRECT_SIGNAL_PROP_NAMES.has(name) || name.startsWith("data-") || name.startsWith("aria-");
}

/**
 * Whether a Signal-valued prop the runtime does not bind reaches React as the
 * Signal object itself. Custom elements own their property contract, so they
 * receive it; on any other host React would stringify it, so it is an error.
 */
export function passesSignalThrough(name: string, tagName: string): boolean {
  return name === "children" || (tagName.includes("-") && !isDirectSignalPropName(name));
}

/** A prop explicitly set to `undefined` is absent, as React treats it. */
export function hasDefinedProp(props: HostProps, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(props, name) && props[name] !== undefined;
}

/** Whether either binding prop is present, even as `undefined`; neither may reach the DOM. */
export function hasBindingPropKey(props: HostProps): boolean {
  return (
    Object.prototype.hasOwnProperty.call(props, "bindValue") ||
    Object.prototype.hasOwnProperty.call(props, "bindChecked")
  );
}

/** A style value that is an object of CSS properties (not an array or a Signal). */
export function isStyleObject(value: unknown): value is HostProps {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !isSignal(value);
}

/** The first Signal-valued entry of a style object, if any. */
export function findSignalStyleEntry(style: unknown): readonly [string, unknown] | undefined {
  if (!isStyleObject(style)) return undefined;
  for (const entry of Object.entries(style)) if (isSignal(entry[1])) return entry;
  return undefined;
}

/** Whether `children` is a Signal or an array, the only values `normalizeChild` changes. */
export function needsChildNormalization(props: HostProps): boolean {
  if (!("children" in props)) return false;
  const children = props.children;
  return isSignal(children) || Array.isArray(children);
}

/** `props` itself when `children` needs no change, else a copy with it normalized. */
export function normalizeChildrenProp<P>(props: P): P {
  if (props == null || typeof props !== "object" || !needsChildNormalization(props as HostProps)) return props;
  return { ...props, children: normalizeChild((props as HostProps).children) };
}

/** Props for one element: host props go through the runtime's transform, Fragment normalizes children, the rest pass. */
export type JsxPropsTransform = (type: unknown, props: unknown) => unknown;

export function createJsxPropsTransform(
  transformHost: (type: string, props: HostProps) => HostProps,
): JsxPropsTransform {
  return (type, props) => {
    // Every other type -- components, `memo`, `forwardRef`, Context, Suspense,
    // lazy, ... -- receives its props exactly as its caller passed them.
    if (typeof type === "string") return transformHost(type, (props ?? {}) as HostProps);
    if (type === Fragment) return normalizeChildrenProp(props);
    return props;
  };
}

type JsxFactory = (type: React.ElementType, props: unknown, key?: React.Key) => React.ReactElement;

export function createJsxFactory<F extends JsxFactory>(factory: F, transform: JsxPropsTransform): F {
  return ((type: React.ElementType, props: unknown, key?: React.Key) =>
    factory(type, transform(type, props), key)) as F;
}

/**
 * The classic-runtime `createElement` the automatic runtime falls back to for
 * `<div {...props} key="k" />`. `key` and `ref` stay in the config for React's
 * own `createElement` to extract.
 */
export function createClassicElement(
  transformHost: (type: string, props: HostProps) => HostProps,
  type: React.ElementType,
  config: HostProps | null | undefined,
  children: readonly unknown[],
): React.ReactElement {
  if (typeof type !== "string" && type !== Fragment) {
    return createElement(type, config, ...(children as React.ReactNode[]));
  }
  // The host transform already normalizes a `children` prop; a Fragment only
  // needs that when no positional children replace it.
  const props =
    typeof type === "string"
      ? transformHost(type, config ?? {})
      : children.length === 0
        ? normalizeChildrenProp(config)
        : config;
  if (children.length === 0) return createElement(type, props);
  return createElement(type, props, ...children.map((child) => normalizeChild(child)));
}
