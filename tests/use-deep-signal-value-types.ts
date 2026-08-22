import { useDeepSignal, useDeepSignalValue } from "../src/index.js";

type State = {
  user: {
    name: string;
    optional?: { label: string };
  };
  tasks: Array<{ id: number; done: boolean }>;
};

function TypeContract({ prefix }: { prefix: string }) {
  const state = useDeepSignal<State>({
    user: { name: "Ada" },
    tasks: [{ id: 1, done: false }],
  });
  const name: string = useDeepSignalValue(state, (value) => value.user.name, []);
  const firstTaskDone: boolean | undefined = useDeepSignalValue(
    state,
    (value) => value.tasks[0]?.done,
    [],
  );
  const optionalLabel: string | undefined = useDeepSignalValue(
    state,
    (value) => value.user.optional?.label,
    [],
  );
  const label: string = useDeepSignalValue(
    state,
    (value) => `${prefix}: ${value.user.name}`,
    [prefix],
  );
  // @ts-expect-error selected primitive values retain their inferred type.
  const badName: number = useDeepSignalValue(state, (value) => value.user.name, []);
  // @ts-expect-error selectors only receive the declared root state shape.
  useDeepSignalValue(state, (value) => value.missing, []);
  // @ts-expect-error selector snapshots must be primitive values, not proxies.
  useDeepSignalValue(state, (value) => value.user, []);

  void [name, firstTaskDone, optionalLabel, label, badName];
}

void TypeContract;
