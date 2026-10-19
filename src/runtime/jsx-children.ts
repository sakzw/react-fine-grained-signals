import { createElement } from "react";
import type * as React from "react";
import { isSignal, type ReadonlySignal } from "../core/index.js";
import type { NotDeepSignal } from "../core/deep-signal.js";
import { useSignalValue } from "../react/hooks.js";

export type SignalChild = React.ReactNode | (ReadonlySignal<SignalChild> & NotDeepSignal) | readonly SignalChild[];

/** A leaf keeps the subscription local to the rendered child. */
export function SignalValue({ source }: { source: ReadonlySignal<SignalChild> }): React.ReactNode {
  return normalizeChild(useSignalValue(source));
}

export function normalizeChild(value: unknown): React.ReactNode {
  if (isSignal(value)) {
    return createElement(SignalValue, { source: value as ReadonlySignal<SignalChild> });
  }

  if (Array.isArray(value)) return value.map(normalizeArrayItem);
  return value as React.ReactNode;
}

function normalizeArrayItem(value: unknown, index: number): React.ReactNode {
  if (isSignal(value)) {
    return createElement(SignalValue, {
      source: value as ReadonlySignal<SignalChild>,
      key: `rfgs-signal:${index}`,
    });
  }
  return normalizeChild(value);
}
