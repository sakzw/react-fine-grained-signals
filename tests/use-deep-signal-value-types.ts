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
  const signalOnlyName: string = useDeepSignalValue(state, (value) => value.user.name);
  const firstTaskDone: boolean | undefined = useDeepSignalValue(state, (value) => value.tasks[0]?.done, []);
  const optionalLabel: string | undefined = useDeepSignalValue(state, (value) => value.user.optional?.label, []);
  const label: string = useDeepSignalValue(state, (value) => `${prefix}: ${value.user.name}`, [prefix]);
  // @ts-expect-error selected primitive values retain their inferred type.
  const badName: number = useDeepSignalValue(state, (value) => value.user.name, []);
  // @ts-expect-error selectors only receive the declared root state shape.
  useDeepSignalValue(state, (value) => value.missing, []);
  // @ts-expect-error Object selectors are rejected because mutable snapshots lack stable identity.
  useDeepSignalValue(state, (value) => value.user, []);
  // @ts-expect-error Object snapshots remain rejected when dependencies are omitted.
  useDeepSignalValue(state, (value) => value.user);

  void [name, signalOnlyName, firstTaskDone, optionalLabel, label, badName];
}

void TypeContract;
