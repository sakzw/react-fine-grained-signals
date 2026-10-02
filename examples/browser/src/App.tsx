/** @jsxImportSource react-fine-grained-signals */

import {
  Activity,
  Component,
  StrictMode,
  Suspense,
  memo,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  isSignal,
  type ReadonlySignal,
  type Signal,
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

class RefErrorBoundary extends Component<
  { id: string; children: ReactNode },
  { message: string | null }
> {
  override state = { message: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { message: error.message };
  }
  override render() {
    return this.state.message === null ? (
      this.props.children
    ) : (
      <output id={this.props.id}>{this.state.message}</output>
    );
  }
}

const throwingCleanupRef = (node: Element | null) => {
  if (node) {
    return () => {
      throw new Error("ref cleanup boom");
    };
  }
};

const throwingAttachRef = (node: Element | null) => {
  if (node) throw new Error("ref attach boom");
};

/** User refs that throw must not leave the element's bindings subscribed. */
function ThrowingRefs({ source }: { source: Signal<string> }) {
  const [cleanupTargetVisible, setCleanupTargetVisible] = useState(true);
  const [attachTargetVisible, setAttachTargetVisible] = useState(false);
  return (
    <section aria-labelledby="ref-errors-heading">
      <h2 id="ref-errors-heading">Throwing user refs</h2>
      <RefErrorBoundary id="ref-cleanup-error">
        {cleanupTargetVisible ? (
          <output id="ref-cleanup-target" title={source} ref={throwingCleanupRef}>
            cleanup target
          </output>
        ) : null}
      </RefErrorBoundary>
      <RefErrorBoundary id="ref-attach-error">
        {attachTargetVisible ? (
          <output id="ref-attach-target" title={source} ref={throwingAttachRef}>
            attach target
          </output>
        ) : null}
      </RefErrorBoundary>
      <button id="unmount-ref-cleanup-target" onClick={() => setCleanupTargetVisible(false)}>
        Unmount cleanup target
      </button>
      <button id="mount-ref-attach-target" onClick={() => setAttachTargetVisible(true)}>
        Mount attach target
      </button>
      <button
        id="write-ref-error-signal"
        onClick={() => {
          source.value = "ref after error";
        }}
      >
        Write ref signal
      </button>
    </section>
  );
}

// Memoized so revealing the Activity does not re-render the bound element:
// the binding has to clear the dropped key on its own.
const ActivityStyledBox = memo(function ActivityStyledBox({
  source,
}: {
  source: Signal<Record<string, string>>;
}) {
  return <div id="activity-box" style={source} />;
});

let resumeSuspendedBox: (() => void) | undefined;
let suspendedBoxPromise: Promise<void> | undefined;

function SuspendWhilePending() {
  if (suspendedBoxPromise !== undefined) throw suspendedBoxPromise;
  return null;
}

/** A new style binding clears keys React wrote from its render-time snapshot. */
function StyleOwnership({ state }: { state: DemoState }) {
  const [mode, setMode] = useState<"visible" | "hidden">("visible");
  const [attempt, setAttempt] = useState(0);
  return (
    <section aria-labelledby="style-ownership-heading">
      <h2 id="style-ownership-heading">Style ownership</h2>
      <Activity mode={mode}>
        <ActivityStyledBox source={state.activityStyle} />
      </Activity>
      <button id="hide-activity-box" onClick={() => setMode("hidden")}>
        Hide box
      </button>
      <button
        id="drop-activity-key"
        onClick={() => {
          state.activityStyle.value = { width: "80px", height: "40px" };
        }}
      >
        Drop outline
      </button>
      <button id="reveal-activity-box" onClick={() => setMode("visible")}>
        Reveal box
      </button>

      <Suspense fallback={<span id="suspense-box-fallback">loading</span>}>
        <div id="suspense-box" style={state.suspenseStyle}>
          suspense box
        </div>
        <SuspendWhilePending key={attempt} />
      </Suspense>
      <button
        id="suspend-box"
        onClick={() => {
          state.suspenseStyle.value = { display: "grid", color: "rgb(0, 0, 255)" };
          suspendedBoxPromise = new Promise<void>((resolve) => {
            resumeSuspendedBox = () => {
              suspendedBoxPromise = undefined;
              resolve();
            };
          });
          setAttempt((current) => current + 1);
        }}
      >
        Suspend box
      </button>
      <button
        id="drop-suspense-display"
        onClick={() => {
          state.suspenseStyle.value = { color: "rgb(0, 128, 0)" };
        }}
      >
        Drop display
      </button>
      <button id="resume-box" onClick={() => resumeSuspendedBox?.()}>
        Resume box
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
          value={state.imeText}
          onChange={(event) => {
            state.imeText.value = event.target.value;
          }}
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

      <StrictMode>
        <BindingLifecycle source={state.lifecycleTitle} />
      </StrictMode>

      <ThrowingRefs source={state.refErrorTitle} />
      <StyleOwnership state={state} />
    </main>
  );
}
