/** @jsxImportSource react-fine-grained-signals */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  computed,
  isSignal,
  useSignal,
  type ReadonlySignal,
} from "react-fine-grained-signals";
import type { DemoState } from "./state.js";

function HydrationMarker() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
    return () => {
      delete document.documentElement.dataset.hydrated;
    };
  }, []);
  return null;
}

function CustomSignalConsumer({
  source,
}: {
  source: ReadonlySignal<string>;
}) {
  return (
    <output
      id="custom-value"
      data-received-signal={String(isSignal(source))}
    >
      {source.value}
    </output>
  );
}

function WritableComputedFormBinding() {
  const source = useSignal("123");
  const inputEvents = useSignal(0);
  const changeEvents = useSignal(0);
  const digits = useMemo(() => computed({
    get: () => source.value,
    set: (next: string) => {
      if (/^\d+$/.test(next)) source.value = next;
    },
  }), [source]);

  return (
    <section aria-labelledby="computed-form-heading">
      <h2 id="computed-form-heading">Writable computed form binding</h2>
      <input
        id="computed-form-input"
        aria-label="writable computed form input"
        bindValue={digits}
        onInput={() => { inputEvents.value += 1; }}
        onChange={() => { changeEvents.value += 1; }}
      />
      <output id="computed-form-source">{source}</output>
      <output id="computed-form-input-count">{inputEvents}</output>
      <output id="computed-form-change-count">{changeEvents}</output>
    </section>
  );
}

function NumberFormBinding() {
  const amount = useSignal("1.5");
  const parsed = useMemo(() => computed(() => amount.value === "" ? "empty" : String(Number(amount.value))), [amount]);
  const ownerRenders = useRef(0);
  ownerRenders.current += 1;

  return (
    <section aria-labelledby="number-form-heading">
      <h2 id="number-form-heading">Number input string binding</h2>
      <form id="number-form">
        <input
          id="number-bound-input"
          aria-label="number-bound-input"
          type="number"
          min="0"
          max="10"
          step="0.5"
          required
          bindValue={amount}
        />
        <output id="number-bound-signal">{amount}</output>
        <output id="number-bound-parsed">{parsed}</output>
        <output id="number-bound-owner-renders">{ownerRenders.current}</output>
        <button id="number-bound-write" type="button" onClick={() => { amount.value = "3.5"; }}>
          Write number signal
        </button>
        <button id="number-bound-reset" type="reset">Reset number form</button>
      </form>
    </section>
  );
}

function RebindingComputedFormBinding() {
  const source = useSignal("123");
  const replacement = useSignal("123x");
  const digits = useMemo(() => computed({
    get: () => source.value,
    set: (next: string) => {
      if (/^\d+$/.test(next)) source.value = next;
    },
  }), [source]);
  const [useReplacement, setUseReplacement] = useState(false);

  return (
    <section aria-labelledby="rebound-form-heading">
      <h2 id="rebound-form-heading">Rebound writable computed form binding</h2>
      <input
        id="rebound-form-input"
        aria-label="rebound writable computed form input"
        bindValue={useReplacement ? replacement : digits}
        onChange={() => setUseReplacement(true)}
      />
      <output id="rebound-form-current-value">{useReplacement ? replacement : digits}</output>
    </section>
  );
}

function InputValueGroups() {
  const choice = useSignal("a");
  const selected = useSignal<string[]>(["a"]);
  return (
    <section aria-labelledby="input-group-heading">
      <h2 id="input-group-heading">Input value groups</h2>
      <form id="input-value-groups">
        <input id="group-radio-a" type="radio" name="group-choice" value="a" bindValue={choice} />
        <input id="group-radio-b" type="radio" name="group-choice" value="b" bindValue={choice} />
        <input id="group-checkbox-a" type="checkbox" name="group-features" value="a" bindValue={selected} />
        <input id="group-checkbox-b" type="checkbox" name="group-features" value="b" bindValue={selected} />
        <output id="group-choice-value" data-value={choice}>{choice}</output>
        <output id="group-selected-values" data-value={selected.value.join(",")}>{selected.value.join(",")}</output>
      </form>
    </section>
  );
}

function IndependentRadioFormOwners() {
  const firstChoice = useSignal("a");
  const secondChoice = useSignal("b");
  return (
    <section aria-labelledby="independent-radio-owner-heading">
      <h2 id="independent-radio-owner-heading">Independent radio form owners</h2>
      <form id="independent-radio-owner-a">
        <input id="independent-radio-a" type="radio" name="independent-choice" value="a" bindValue={firstChoice} />
      </form>
      <form id="independent-radio-owner-b">
        <input id="independent-radio-b" type="radio" name="independent-choice" value="b" bindValue={secondChoice} />
      </form>
      <output id="independent-radio-signals">{firstChoice}|{secondChoice}</output>
    </section>
  );
}

export function App({ state }: { state: DemoState }) {
  const renders = useRef(0);
  renders.current += 1;

  return (
    <main>
      <HydrationMarker />
      <h1>react-fine-grained-signals browser PoC</h1>

      <section aria-labelledby="child-heading">
        <h2 id="child-heading">Signal child</h2>
        <output id="signal-child">{state.count}</output>
        <output id="parent-renders">{renders.current}</output>
        <button
          id="increment-signal-child"
          onClick={() => {
            state.count.value += 1;
          }}
        >
          Increment signal child
        </button>
      </section>

      <section aria-labelledby="binding-heading">
        <h2 id="binding-heading">Direct host bindings</h2>
        <button
          id="bound-button"
          title={state.title}
          hidden={state.hidden}
          disabled={state.disabled}
          data-status={state.status}
        >
          Bound button
        </button>
        <button
          id="toggle-bindings"
          onClick={() => {
            state.title.value = "updated title";
            state.hidden.value = true;
            state.disabled.value = true;
            state.status.value = "active";
          }}
        >
          Toggle bindings
        </button>
      </section>

      <WritableComputedFormBinding />
      <NumberFormBinding />
      <RebindingComputedFormBinding />
      <InputValueGroups />
      <IndependentRadioFormOwners />

      <section aria-labelledby="component-heading">
        <h2 id="component-heading">React component boundary</h2>
        <CustomSignalConsumer source={state.customLabel} />
        <button
          id="update-custom-component"
          onClick={() => {
            state.customLabel.value = "custom updated";
          }}
        >
          Update custom component
        </button>
      </section>

      <section aria-labelledby="style-heading">
        <h2 id="style-heading">Style binding</h2>
        <div id="styled-box" style={state.boxStyle} />
        <button
          id="toggle-style"
          onClick={() => {
            state.boxStyle.value = {
              width: "160px",
              height: "40px",
              background: "seagreen",
            };
          }}
        >
          Toggle style
        </button>
      </section>

      <section aria-labelledby="ime-heading">
        <h2 id="ime-heading">IME composition</h2>
        <input
          id="ime-field"
          aria-label="ime field"
          bindValue={state.imeText}
        />
        <button
          id="external-ime-write"
          onClick={() => {
            state.imeText.value = "external update";
          }}
        >
          External IME write
        </button>
      </section>

      <section aria-labelledby="reset-heading">
        <h2 id="reset-heading">Bound form reset</h2>
        <form id="bound-reset-form" action={() => {
          state.resetText.value = "action value";
          state.resetChecked.value = true;
          state.resetChoice.value = "b";
          state.resetChoices.value = ["b", "c"];
        }}>
          <output
            id="bound-reset-signals"
            data-text={state.resetText}
            data-checked={state.resetChecked}
            data-choice={state.resetChoice}
            data-choices={state.resetChoices.value.join(",")}
          />
          <input
            id="bound-reset-text"
            aria-label="bound reset text"
            bindValue={state.resetText}
          />
          <input
            id="bound-reset-checkbox"
            aria-label="bound reset checkbox"
            type="checkbox"
            bindChecked={state.resetChecked}
          />
          <select id="bound-reset-choice" aria-label="bound reset choice" bindValue={state.resetChoice}>
            <option value="a">A</option><option value="b">B</option><option value="c">C</option>
          </select>
          <select id="bound-reset-choices" aria-label="bound reset choices" multiple bindValue={state.resetChoices}>
            <option value="a">A</option><option value="b">B</option><option value="c">C</option>
          </select>
          <button id="bound-reset-submit" type="button" onClick={() => {
            state.resetText.value = "signal updated";
            state.resetChecked.value = true;
            state.resetChoice.value = "c";
            state.resetChoices.value = ["a", "c"];
          }}>Write signals</button>
          <button id="bound-reset-action" type="submit">Submit action</button>
          <button id="bound-reset-button" type="reset">Reset</button>
        </form>
      </section>
    </main>
  );
}
