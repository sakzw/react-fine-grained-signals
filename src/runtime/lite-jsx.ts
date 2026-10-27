import { Fragment, jsx as reactJsx } from "react/jsx-runtime";
import { createElement } from "react";
import type * as React from "react";
import { isSignal } from "../core/index.js";
import { normalizeChild } from "./jsx-children.js";

type CreateElement = typeof reactJsx;

function assertSupportedProps(props: Record<string, unknown> | null | undefined): void {
  if (props == null) return;
  if (
    Object.prototype.hasOwnProperty.call(props, "bindValue") ||
    Object.prototype.hasOwnProperty.call(props, "bindChecked")
  ) {
    throw new TypeError(
      "The lite JSX runtime supports Signal children only; form bindings require the default JSX runtime.",
    );
  }
  for (const [name, value] of Object.entries(props)) {
    if (name === "children") continue;
    if (isSignal(value)) {
      throw new TypeError(
        `The lite JSX runtime does not support Signal-valued ${name} props; use a Signal child or the default JSX runtime.`,
      );
    }
    if (name === "style" && typeof value === "object" && value !== null) {
      const signalStyleProperty = Object.entries(value).find(([, entry]) => isSignal(entry));
      if (signalStyleProperty !== undefined) {
        throw new TypeError(
          `The lite JSX runtime does not support Signal-valued style.${signalStyleProperty[0]}; use the default JSX runtime.`,
        );
      }
    }
  }
}

export function createLiteJsxWrapper(factory: CreateElement): CreateElement {
  return (type, props, key) => {
    if (typeof type !== "string" && type !== Fragment) return factory(type, props, key);
    if (props == null || typeof props !== "object") return factory(type, props, key);
    const hostProps = props as Record<string, unknown>;
    assertSupportedProps(hostProps);
    if (!("children" in hostProps)) return factory(type, props, key);
    const children = hostProps.children;
    if (!isSignal(children) && !Array.isArray(children)) return factory(type, props, key);
    return factory(type, { ...hostProps, children: normalizeChild(children) }, key);
  };
}

export function createLiteSignalAwareElement(
  type: React.ElementType,
  config?: Record<string, unknown> | null,
  ...children: unknown[]
): React.ReactElement {
  if (typeof type !== "string" && type !== Fragment) {
    return createElement(type, config, ...(children as React.ReactNode[]));
  }
  assertSupportedProps(config as Record<string, unknown> | null | undefined);
  if (children.length > 0) {
    return createElement(type, config, ...children.map((child) => normalizeChild(child)));
  }
  if (config != null && "children" in config) {
    const value = config.children;
    if (isSignal(value) || Array.isArray(value)) {
      return createElement(type, config, normalizeChild(value));
    }
  }
  return createElement(type, config);
}
