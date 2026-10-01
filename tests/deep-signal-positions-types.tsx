/** @jsxImportSource react-fine-grained-signals */

// Compile-time contract (v0.2): positions that only observe a signal's root
// value reject a `deepSignal`, because nested mutations would never update
// them. Everything else that accepts an ordinary signal keeps accepting it.

import { computed, deepSignal, signal, useDeepSignalValue, useSignalValue } from "../src/index.js";
import type { DeepSignal, ReadonlySignal, Signal } from "../src/index.js";

const deepStyle = deepSignal({ color: "red" });
const deepList = deepSignal(["a"]);
const plainStyle = signal({ color: "red" });
const text = signal("text");
const derived = computed(() => text.value.length);

function Positions() {
  // Root-only readers accept ordinary signals and computeds...
  const value: string = useSignalValue(text);
  const length: number = useSignalValue(derived);
  // ...and reject deep signals.
  // @ts-expect-error useSignalValue observes root replacement only.
  useSignalValue(deepList);
  // The deep-aware reader stays the supported way to select from deep state.
  const first: string | undefined = useDeepSignalValue(deepList, (list) => list[0], []);

  return (
    <>
      <div style={plainStyle}>{text}</div>
      {/* @ts-expect-error A deep signal is not a supported style binding. */}
      <div style={deepStyle} />
      {/* @ts-expect-error A deep signal is not a supported child. */}
      <p>{deepList}</p>
      <output>{value}{length}{first}</output>
    </>
  );
}

// A deep signal is still assignable to the general signal types.
const asSignal: Signal<string[]> = deepList;
const asReadonly: ReadonlySignal<string[]> = deepList;
const typed: DeepSignal<{ color: string }> = deepStyle;

void [Positions, asSignal, asReadonly, typed];
