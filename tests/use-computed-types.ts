import { useComputed, useWritableComputed } from "../src/index.js";
import type { ReadonlySignal, Signal } from "../src/index.js";

// Type-only checks, verified by `pnpm typecheck`.

export function readOnlyForm(): ReadonlySignal<number> {
  return useComputed(() => 1);
}

export function writableForm(): Signal<number> {
  return useWritableComputed({ get: () => 1, set: (_next: number) => {} });
}

export function useComputedRejectsOptions() {
  // @ts-expect-error useComputed takes a getter only; use useWritableComputed.
  return useComputed({ get: () => 1, set: (_next: number) => {} });
}

export function useWritableComputedRejectsGetter() {
  // @ts-expect-error useWritableComputed takes { get, set } only.
  return useWritableComputed(() => 1);
}

export function readOnlyIsNotWritable(): Signal<number> {
  // @ts-expect-error a read-only computed is not a writable signal.
  return useComputed(() => 1);
}
