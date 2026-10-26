import { signal } from "../src/index.js";
import { For, Index, Match, Show, Switch, type MatchProps, type Truthy } from "react-fine-grained-signals/utils";

const users = signal([{ id: "ada", name: "Ada" }]);
const tags = signal(new Set(["react"]));
const usersById = signal(new Map([["ada", { name: "Ada" }]]));

const keyedArray = (
  <For each={users} by={(user) => user.id}>
    {(user, index) => <p>{`${index}:${user.name}`}</p>}
  </For>
);

const keyedSet = (
  <For each={tags} by={(tag) => tag}>
    {(tag) => <p>{tag}</p>}
  </For>
);

const keyedMap = (
  <For each={usersById} by={([id]) => id}>
    {([id, user]) => <p>{`${id}:${user.name}`}</p>}
  </For>
);

const indexed = (
  <Index each={users}>
    {(user, index) => <p>{`${index}:${user().name}`}</p>}
  </Index>
);

const mode = signal<"list" | "details" | undefined>("list");
const matched = (
  <Switch>
    <Match when={mode} equals="list">
      {(value) => {
        const exact: "list" = value;
        return <p>{exact}</p>;
      }}
    </Match>
    <Match when={mode} equals={undefined}>
      {(value) => {
        const exact: undefined = value;
        return <p>{String(exact)}</p>;
      }}
    </Match>
    <Match when={mode}>
      {(value) => {
        const nonNull: "list" | "details" = value;
        return <p>{nonNull}</p>;
      }}
    </Match>
  </Switch>
);

const falsy = signal<false | 0 | "" | null | undefined>(false);
const falsyMatch = <Match when={falsy} equals={false}>{(value) => {
  const exact: false = value;
  return <p>{String(exact)}</p>;
}}</Match>;
const zeroMatch = <Match when={signal<number>(0)} equals={0}>{(value) => {
  return <p>{value}</p>;
}}</Match>;
const nullMatch = <Match when={signal<null | string>(null)} equals={null}>{(value) => {
  const exact: null = value;
  return <p>{String(exact)}</p>;
}}</Match>;
const emptyStringMatch = <Match when={signal<string>("")} equals="">{(value) => {
  const exact: "" = value;
  return <p>{exact}</p>;
}}</Match>;

// A broad primitive type still narrows to the equals literal for callback children.
const broadStringMatch = <Match when={signal<string>("list")} equals="list">{(value) => {
  const exact: "list" = value;
  return <p>{exact.toUpperCase()}</p>;
}}</Match>;
const broadNumberMatch = <Match when={signal<number>(1)} equals={1}>{(value) => {
  return <p>{value}</p>;
}}</Match>;

type View = "list" | "details";
const unionMatch = <Match when={signal<View>("list")} equals="list">{(value) => {
  const exact: "list" = value;
  return <p>{exact}</p>;
}}</Match>;

const directStringInput = signal<string>("list");
const directEqualsProps: MatchProps<string, "list"> = {
  when: directStringInput,
  equals: "list",
  children: (value) => {
    const exact: "list" = value;
    return <p>{exact.toUpperCase()}</p>;
  },
};
const directLegacyProps: MatchProps<string> = {
  when: directStringInput,
  children: (value) => {
    const exact: string = value;
    return <p>{exact}</p>;
  },
};
const directFalseProps: MatchProps<false | true, false> = {
  when: signal<false | true>(false),
  equals: false,
  children: (value) => {
    const exact: false = value;
    return <p>{String(exact)}</p>;
  },
};
const directZeroProps: MatchProps<number, 0> = {
  when: signal<number>(0),
  equals: 0,
  children: (value) => {
    const exact: 0 = value;
    return <p>{exact}</p>;
  },
};
const directUndefinedProps: MatchProps<string | undefined, undefined> = {
  when: signal<string | undefined>(undefined),
  equals: undefined,
  children: (value) => {
    const exact: undefined = value;
    return <p>{String(exact)}</p>;
  },
};

// @ts-expect-error MatchProps rejects equals values outside of T.
const invalidDirectEquals: MatchProps<string, 42> = { when: directStringInput, equals: 42, children: <p /> };

const explicitUndefinedMatch = <Match when={mode} equals={undefined}>{(value) => {
  const exact: undefined = value;
  return <p>{String(exact)}</p>;
}}</Match>;

// @ts-expect-error equals must be assignable to the value type of when.
const invalidEquals = <Match when={mode} equals={42}><p>invalid</p></Match>;

// @ts-expect-error For requires an identity key; use Index for positional lists.
const missingKey = <For each={users}>{(user) => <p>{user.name}</p>}</For>;

void [keyedArray, keyedSet, keyedMap, indexed, missingKey, matched, falsyMatch, invalidEquals];
void [zeroMatch, nullMatch, emptyStringMatch, broadStringMatch, broadNumberMatch, unionMatch,
  directEqualsProps, directLegacyProps, directFalseProps, directZeroProps, invalidDirectEquals,
  directUndefinedProps, explicitUndefinedMatch];

// Show and Match (without equals) hand the callback a truthy value: the falsy
// members of the union are removed, not only null and undefined.
const count = signal<0 | 1 | 2 | null>(1);
const truthyShow = (
  <Show when={count}>
    {(value) => {
      const nonZero: 1 | 2 = value;
      // @ts-expect-error 0 is falsy, so it is not part of the callback value.
      const zero: 0 = value;
      return <p>{nonZero + zero}</p>;
    }}
  </Show>
);

const flag = signal<boolean>(true);
const booleanShow = (
  <Show when={flag}>
    {(value) => {
      const only: true = value;
      return <p>{String(only)}</p>;
    }}
  </Show>
);

const label = signal<"" | "a" | undefined>("a");
const labelMatch = (
  <Match when={label}>
    {(value) => {
      const only: "a" = value;
      // @ts-expect-error "" is falsy, so it is not part of the callback value.
      const empty: "" = value;
      return <p>{only + empty}</p>;
    }}
  </Match>
);

const wideNumber = signal<number | null>(1);
const wideShow = (
  <Show when={wideNumber}>
    {(value) => {
      // A wide number can be nonzero, so it stays number.
      const n: number = value;
      // @ts-expect-error null is removed.
      const nil: null = value;
      return <p>{n}{String(nil)}</p>;
    }}
  </Show>
);

const truthyPlain: Truthy<0 | "" | false | null | undefined | 0n | "x" | 2> = "x";
// @ts-expect-error falsy literals are not Truthy.
const falsyPlain: Truthy<0 | ""> = 0;

void [truthyShow, booleanShow, labelMatch, wideShow, truthyPlain, falsyPlain];
