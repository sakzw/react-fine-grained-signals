/** @jsxImportSource react-fine-grained-signals */

import {
  Activity,
  Component,
  StrictMode,
  Suspense,
  memo,
  startTransition,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  computed,
  isSignal,
  useSignal,
  useSignalTracking,
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

let dropReattachOutline = false;

/**
 * Drops the outline in its layout effect, during the owner's re-render commit.
 * No dependency array: it runs in every commit that re-renders it.
 */
function DropOutlineOnLayout({ source }: { source: Signal<Record<string, string>> }) {
  useLayoutEffect(() => {
    if (!dropReattachOutline) return;
    dropReattachOutline = false;
    source.value = { width: "80px", height: "40px" };
  });
  return null;
}

/** A kept style binding clears keys from the snapshot it re-attaches for. */
function StyleReattach({ source }: { source: Signal<Record<string, string>> }) {
  const [renders, setRenders] = useState(0);
  return (
    <section aria-labelledby="style-reattach-heading">
      <h2 id="style-reattach-heading">Style re-attach</h2>
      <div id="reattach-box" data-renders={renders} style={source}>
        <DropOutlineOnLayout source={source} />
      </div>
      <button
        id="add-reattach-outline"
        onClick={() => {
          source.value = { width: "80px", height: "40px", outline: "3px solid crimson" };
        }}
      >
        Add outline
      </button>
      <button
        id="rerender-and-drop-outline"
        onClick={() => {
          dropReattachOutline = true;
          setRenders((current) => current + 1);
        }}
      >
        Re-render and drop outline
      </button>
    </section>
  );
}

/**
 * A binding switched to a plain value while a sibling binding on the same
 * element keeps its ref alive: React's plain value must win.
 */
function SiblingBindingSwitch({ state }: { state: DemoState }) {
  const [plainClass, setPlainClass] = useState(false);
  const [plainStyle, setPlainStyle] = useState(false);
  return (
    <section aria-labelledby="sibling-switch-heading">
      <h2 id="sibling-switch-heading">Sibling binding switch</h2>
      <div
        id="switch-class-box"
        style={state.switchClassSibling}
        className={plainClass ? "plain" : state.switchClass}
      />
      <div
        id="switch-style-box"
        className={state.switchStyleSibling}
        style={plainStyle ? { width: "40px", height: "20px" } : state.switchStyle}
      />
      <button id="plain-switch-class" onClick={() => setPlainClass(true)}>
        Make class plain
      </button>
      <button id="plain-switch-style" onClick={() => setPlainStyle(true)}>
        Make style plain
      </button>
      <button
        id="write-switch-sources"
        onClick={() => {
          state.switchClass.value = "late";
          state.switchStyle.value = { width: "120px", height: "30px", outline: "1px dashed teal" };
          state.switchClassSibling.value = { width: "120px", height: "30px" };
          state.switchStyleSibling.value = "keep-next";
        }}
      >
        Write switched sources
      </button>
    </section>
  );
}

/** @noSignalTracking */
function BareHiddenReader({ source }: { source: ReadonlySignal<number> }) {
  useSignalTracking();
  return <output id="hidden-bare-value">{source.value}</output>;
}

function ManagedHiddenReader({ source }: { source: ReadonlySignal<number> }) {
  return <output id="hidden-managed-value">{source.value}</output>;
}

/**
 * Mirrors whether the passive effects inside its Activity are connected onto
 * `target` as `data-passive-effects`. The tracked readers subscribe and release
 * their signals from passive effects too, and React connects or disconnects
 * every passive effect of a hidden or revealed Activity in one flush. Hiding
 * commits the DOM change first and, after a transition, runs that flush in a
 * later task, so a hidden reader is not yet a released one.
 */
function PassiveEffectsMarker({ target }: { target: { readonly current: HTMLElement | null } }) {
  useEffect(() => {
    const node = target.current;
    if (node === null) return;
    node.dataset.passiveEffects = "connected";
    return () => {
      node.dataset.passiveEffects = "disconnected";
    };
  }, [target]);
  return null;
}

/** Tracked readers deleted inside a hidden Activity release their subscriptions. */
function HiddenTrackedReaders({ state }: { state: DemoState }) {
  const [mode, setMode] = useState<"visible" | "hidden">("visible");
  const [shown, setShown] = useState(true);
  const section = useRef<HTMLElement>(null);
  return (
    <section id="hidden-tracked-readers" ref={section} aria-labelledby="hidden-tracked-heading">
      <h2 id="hidden-tracked-heading">Hidden tracked readers</h2>
      <Activity mode={mode}>
        {shown ? (
          <>
            <BareHiddenReader source={state.hiddenBare} />
            <ManagedHiddenReader source={state.hiddenManaged} />
          </>
        ) : null}
        <PassiveEffectsMarker target={section} />
      </Activity>
      <button id="hide-tracked-readers" onClick={() => startTransition(() => setMode("hidden"))}>
        Hide readers
      </button>
      <button id="delete-tracked-readers" onClick={() => setShown(false)}>
        Delete readers
      </button>
      <button id="reveal-tracked-readers" onClick={() => setMode("visible")}>
        Reveal readers
      </button>
      <button
        id="write-tracked-source"
        onClick={() => {
          state.hiddenTrackedSource.value += 1;
        }}
      >
        Write tracked source
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

      <WritableComputedFormBinding />
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

      <StrictMode>
        <BindingLifecycle source={state.lifecycleTitle} />
      </StrictMode>

      <ThrowingRefs source={state.refErrorTitle} />
      <StyleOwnership state={state} />
      <StyleReattach source={state.reattachStyle} />
      <StrictMode>
        <SiblingBindingSwitch state={state} />
      </StrictMode>
      <HiddenTrackedReaders state={state} />
    </main>
  );
}
