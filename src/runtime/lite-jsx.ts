import type * as React from "react";
import { isSignal } from "../core/index.js";
import {
  createClassicElement,
  createJsxPropsTransform,
  findSignalStyleEntry,
  hasBindingPropKey,
  hasDefinedProp,
  normalizeChildrenProp,
  passesSignalThrough,
  type HostProps,
} from "./jsx-shared.js";

/**
 * The lite runtime renders Signal children only. Wherever the full runtime
 * would bind a Signal prop it throws instead; wherever the full runtime passes
 * a Signal through (custom elements, see `passesSignalThrough`) it does too.
 */
function transformLiteHostProps(tagName: string, props: HostProps): HostProps {
  if (hasDefinedProp(props, "bindValue") || hasDefinedProp(props, "bindChecked")) {
    throw new TypeError(
      "The lite JSX runtime supports Signal children only; form bindings require the default JSX runtime.",
    );
  }
  for (const [name, value] of Object.entries(props)) {
    if (isSignal(value) && !passesSignalThrough(name, tagName)) {
      throw new TypeError(
        `The lite JSX runtime does not support Signal-valued ${name} props on <${tagName}>; use a Signal child or the default JSX runtime.`,
      );
    }
  }
  const signalStyleEntry = findSignalStyleEntry(props.style);
  if (signalStyleEntry !== undefined) {
    throw new TypeError(
      `The lite JSX runtime does not support Signal-valued style.${signalStyleEntry[0]} on <${tagName}>; use the default JSX runtime.`,
    );
  }
  // A binding prop left `undefined` is absent, but must not reach the DOM.
  if (hasBindingPropKey(props)) {
    const rest = { ...props };
    delete rest.bindValue;
    delete rest.bindChecked;
    return normalizeChildrenProp(rest);
  }
  return normalizeChildrenProp(props);
}

export const transformLiteJsxProps = createJsxPropsTransform(transformLiteHostProps);

export function createLiteSignalAwareElement(
  type: React.ElementType,
  config?: HostProps | null,
  ...children: unknown[]
): React.ReactElement {
  return createClassicElement(transformLiteHostProps, type, config, children);
}
