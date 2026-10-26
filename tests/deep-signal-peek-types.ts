import { deepSignal, isSignal } from "../src/index.js";
import type { DeepReadonly, DeepSignal, ReadonlySignal, Signal } from "../src/index.js";

// Type-only checks, verified by `pnpm typecheck`.

const state = deepSignal({
  count: 0,
  items: [1, 2, 3],
  nested: { name: "Ada", tags: ["a"] },
  when: new Date(0),
  run: () => 1,
});

// Reading through peek() works and keeps the element types.
export const count: number = state.peek().count;
export const first: number | undefined = state.peek().items[0];
export const name: string = state.peek().nested.name;
export const when: Date = state.peek().when;
export const run: () => number = state.peek().run;

// Writing through peek() is rejected; the same writes through .value compile.
// @ts-expect-error peek() is read-only.
state.peek().count = 1;
// @ts-expect-error arrays from peek() are ReadonlyArray.
state.peek().items.push(4);
// @ts-expect-error nested properties are read-only too.
state.peek().nested.name = "Grace";
// @ts-expect-error nested arrays are ReadonlyArray.
state.peek().nested.tags.push("b");
state.value.count = 1;
state.value.items.push(4);

// DeepReadonly leaves leaf values alone.
export const leaf: DeepReadonly<string | number | null> = null;
export const wide: DeepReadonly<number> = 1;

// A DeepSignal still narrows through isSignal and is not a ReadonlySignal<T>.
export function narrowed(value: unknown) {
  if (isSignal(value)) return value;
  return undefined;
}
export const asDeep: DeepSignal<{ count: number }> = deepSignal({ count: 1 });
// For reading, a plain-object root is still structurally a ReadonlySignal (readonly does
// not affect assignability), but arrays and collections are not. It is never a Signal.
// @ts-expect-error a DeepSignal is not a writable Signal, even for a plain-object root.
export const objectAsSignal: Signal<{ count: number }> = asDeep;
export const objectRoot: ReadonlySignal<{ count: number }> = asDeep;
// @ts-expect-error a DeepSignal over an array is not a ReadonlySignal of that array.
export const arrayRoot: ReadonlySignal<number[]> = deepSignal([1]);
