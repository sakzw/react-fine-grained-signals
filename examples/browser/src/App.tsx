/** @jsxImportSource react-alien-signals */

import { StrictMode, useEffect, useRef, useState } from "react";
import {
  isSignal,
  type ReadonlySignal,
  type Signal,
} from "react-alien-signals";
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

function BindingLifecycle({ source }: { source: Signal<string> }) {
  const [visible, setVisible] = useState(true);
  return (
    <section aria-labelledby="lifecycle-heading">
      <h2 id="lifecycle-heading">Binding cleanup</h2>
      {visible ? (
        <output id="detached-binding" title={source}>
          attached
        </output>
      ) : null}
      <button id="unmount-binding" onClick={() => setVisible(false)}>
        Unmount binding
      </button>
      <button
        id="update-detached-signal"
        onClick={() => {
          source.value =
            source.value === "lifecycle initial"
              ? "lifecycle updated"
              : "lifecycle after unmount";
        }}
      >
        Update detached signal
      </button>
    </section>
  );
}

export function App({ state }: { state: DemoState }) {
  const renders = useRef(0);
  renders.current += 1;

  return (
    <main>
      <HydrationMarker />
      <h1>react-alien-signals browser PoC</h1>

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

      <StrictMode>
        <BindingLifecycle source={state.lifecycleTitle} />
      </StrictMode>
    </main>
  );
}
