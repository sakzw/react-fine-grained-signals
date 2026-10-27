/** @jsxImportSource react-fine-grained-signals/jsx */

import { computed, signal, useSignal, type ReadonlySignal, type Signal } from "../src/index.js";

// Type-only checks, verified by `pnpm typecheck`.

// A structural { value, peek } object is not a Signal or a ReadonlySignal.
const fake = { value: "x", peek: () => "x" };
// @ts-expect-error a structural object is not a ReadonlySignal.
export const fakeReadonly: ReadonlySignal<string> = fake;
// @ts-expect-error a structural object is not a Signal.
export const fakeWritable: Signal<string> = { ...fake };

// Signal<T> is invariant: it is also written through.
export const narrow = signal<"a" | "b">("a");
// @ts-expect-error Signal<"a" | "b"> cannot stand in for Signal<string>.
export const widened: Signal<string> = narrow;
// @ts-expect-error Signal<string> cannot stand in for Signal<"a" | "b">.
export const narrowed: Signal<"a" | "b"> = signal("a" as string);

// ReadonlySignal<T> stays covariant.
export const readonlyNarrow: ReadonlySignal<string> = computed(() => "a" as "a" | "b");

// A Signal is a ReadonlySignal, not the other way round.
export const asReadonly: ReadonlySignal<string> = signal("x");
// @ts-expect-error a ReadonlySignal is not writable.
export const asWritable: Signal<string> = computed(() => "x");

// Return types of the creators.
export const created: Signal<number> = signal(1);
export const createdReadonly: ReadonlySignal<number> = computed(() => 1);
export const createdWritable: Signal<number> = computed({ get: () => 1, set: (_next: number) => {} });
export function hook(): Signal<number> {
  return useSignal(1);
}

// Bindings take Signal<T> directly; option bindings also take narrower unions.
const text = signal("a");
const choice = signal<"x" | "y">("x");
const choices = signal<("x" | "y")[]>([]);
export const textBinding = <input bindValue={text} />;
// @ts-expect-error a text binding writes any string, so a literal-union signal is rejected.
export const narrowTextBinding = <input bindValue={choice} />;
export const radioBinding = <input type="radio" name="n" value="x" bindValue={choice} />;
export const selectBinding = (
  <select bindValue={choice}>
    <option value="x">x</option>
  </select>
);
export const groupBinding = <input type="checkbox" value="x" bindValue={choices} />;
// @ts-expect-error a ReadonlySignal cannot be bound for writing.
export const readonlyBinding = <input bindValue={computed(() => "a")} />;
