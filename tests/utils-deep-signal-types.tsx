import { deepCollectionSignal, deepSignal, isSignal, signal } from "../src/index.js";
import type { DeepCollectionSignal, DeepSignal, ReadonlySignal } from "../src/index.js";
import { For, Index, Match, Show, Switch, type SignalInput } from "react-fine-grained-signals/utils";

// Type-only checks, verified by `pnpm typecheck`. The control-flow components
// read a deep signal inside their own tracking scope (see control-flow.test.tsx),
// so they accept one, and infer the plain state type from `.value` rather
// than the `DeepReadonly` type of `peek()`.

type Todo = { id: string; done: boolean; tags: string[] };
const todo = (): Todo => ({ id: "a", done: false, tags: ["x"] });

const todos = deepSignal([todo()]);
const readonlyTodos = deepSignal<readonly Todo[]>([todo()]);
const collectionTodos = deepCollectionSignal([todo()]);
const todoSet = deepCollectionSignal(new Set([todo()]));
const todoMap = deepCollectionSignal(new Map([["a", todo()]]));
const state = deepSignal({ todos: [todo()], open: true });

// For over a deep array: the item is a mutable Todo, so a row can write to it.
const keyedDeep = (
  <For each={todos} by={(item) => item.id}>
    {(item) => {
      const plain: Todo = item;
      return (
        <button
          onClick={() => {
            item.done = !item.done;
            item.tags.push("y");
          }}
        >
          {plain.id}
        </button>
      );
    }}
  </For>
);
const keyedReadonlyRoot = (
  <For each={readonlyTodos} by={(item) => item.id}>
    {(item) => {
      const plain: Todo = item;
      return <p>{plain.id}</p>;
    }}
  </For>
);
const keyedCollectionArray = (
  <For each={collectionTodos} by={(item) => item.id}>
    {(item) => {
      const plain: Todo = item;
      return <p>{plain.id}</p>;
    }}
  </For>
);
const keyedDeepSet = (
  <For each={todoSet} by={(item) => item.id}>
    {(item) => {
      const plain: Todo = item;
      return <p>{plain.id}</p>;
    }}
  </For>
);
const keyedDeepMap = (
  <For each={todoMap} by={([id]) => id}>
    {([id, item]) => {
      const plain: Todo = item;
      return <p>{`${id}:${plain.id}`}</p>;
    }}
  </For>
);
// A nested array read through `.value` is a plain array input.
const keyedNested = (
  <For each={state.value.todos} by={(item) => item.id}>
    {(item) => {
      const plain: Todo = item;
      return <p>{plain.id}</p>;
    }}
  </For>
);

const indexedDeep = (
  <Index each={todos}>
    {(item) => {
      const plain: Todo = item();
      return <p>{plain.id}</p>;
    }}
  </Index>
);
const indexedCollectionArray = (
  <Index each={collectionTodos}>
    {(item) => {
      const plain: Todo = item();
      return <p>{plain.id}</p>;
    }}
  </Index>
);

const shownDeep = (
  <Show when={state}>
    {(value) => {
      const plain: { todos: Todo[]; open: boolean } = value;
      return <p>{String(plain.open)}</p>;
    }}
  </Show>
);
const matchedDeep = (
  <Switch>
    <Match when={state}>
      {(value) => {
        const plain: { todos: Todo[]; open: boolean } = value;
        return <p>{String(plain.open)}</p>;
      }}
    </Match>
  </Switch>
);

// A deep signal over something that is not the expected collection is rejected.
const objectAsList = (
  // @ts-expect-error a plain-object deep signal is not a list.
  <For each={state} by={(item) => String(item)}>
    {() => null}
  </For>
);
// @ts-expect-error a Set has no positions.
const setAsIndex = <Index each={todoSet}>{() => null}</Index>;
const mapAsItems = (
  // @ts-expect-error a Map deep signal yields entries, not items.
  <For each={todoMap} by={(item: Todo) => item.id}>
    {() => null}
  </For>
);

void [keyedDeep, keyedReadonlyRoot, keyedCollectionArray, keyedDeepSet, keyedDeepMap, keyedNested];
void [indexedDeep, indexedCollectionArray, shownDeep, matchedDeep, objectAsList, setAsIndex, mapAsItems];

// SignalInput infers the `.value` type for every kind of input.
declare function read<T>(input: SignalInput<T>): T;
export const fromDeepObject: { todos: Todo[]; open: boolean } = read(state);
export const fromDeepArray: Todo[] = read(todos);
export const fromDeepSet: Set<Todo> = read(todoSet);
export const fromSignal: number = read(signal(1));
export const fromLiteralSignal: "a" | "b" = read(signal<"a" | "b">("a"));
export const fromPlain: string = read("x");

// isSignal: every deep signal is a ReadonlySignal<unknown> (its peek() type is
// DeepReadonly<T>, which unknown accepts), so the guard covers them, and
// narrowing a union keeps the deep signal's own type.
export const deepAsUnknownSignal: ReadonlySignal<unknown> = todos;
export const collectionAsUnknownSignal: ReadonlySignal<unknown> = todoSet;
export function narrowDeep(input: number | DeepSignal<Todo[]>): number {
  if (isSignal(input)) {
    const narrowed: DeepSignal<Todo[]> = input;
    return narrowed.value.length;
  }
  const rest: number = input;
  return rest;
}
export function narrowCollection(input: string | DeepCollectionSignal<Set<Todo>>): string | Set<Todo> {
  return isSignal(input) ? input.value : input;
}
export function narrowUnknown(input: unknown): unknown {
  return isSignal(input) ? input.value : input;
}
