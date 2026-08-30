/** @jsxImportSource react-fine-grained-signals */
// @vitest-environment jsdom

import { StrictMode, act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsx } from "../src/jsx-runtime.js";
import { computed, signal, useSignal, useSignals } from "../src/index.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Spy shape shared by the call-counting helpers below. */
type CallSpy = { mock: { calls: unknown[][] } };

/** How many times `name` was written through `Element#setAttribute`. */
function attributeWrites(spy: CallSpy, name: string): number {
  return spy.mock.calls.filter(([written]) => written === name).length;
}

/** How many listeners of `type` were added or removed, across every EventTarget. */
function listenerCalls(spy: CallSpy, type: string): number {
  return spy.mock.calls.filter(([listened]) => listened === type).length;
}

describe("Direct DOM binding", () => {
  it("binds a signal directly to host DOM props", () => {
    function Field() {
      const disabled = useSignal(true);
      const title = useSignal("initial title");
      const hidden = useSignal(false);
      const dataState = useSignal("initial-state");
      return (
        <>
          <button
            aria-label="toggle"
            onClick={() => {
              disabled.value = !disabled.value;
              title.value = "updated title";
              hidden.value = true;
              dataState.value = "updated-state";
            }}
          >
            toggle
          </button>
          <input
            aria-label="bound field"
            disabled={disabled}
            hidden={hidden}
            title={title}
            data-state={dataState}
          />
        </>
      );
    }

    render(<Field />);
    const input = screen.getByLabelText("bound field") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.hidden).toBe(false);
    expect(input.title).toBe("initial title");
    expect(input.dataset.state).toBe("initial-state");
    fireEvent.click(screen.getByRole("button", { name: "toggle" }));
    expect(input.disabled).toBe(false);
    expect(input.hidden).toBe(true);
    expect(input.title).toBe("updated title");
    expect(input.dataset.state).toBe("updated-state");
  });

  it("binds an aria-* prop directly to a signal without rerendering its owner", () => {
    const expanded = signal(false);
    const parentRenders = vi.fn();

    function Disclosure() {
      parentRenders();
      return (
        <button aria-label="disclosure" aria-expanded={expanded}>
          toggle
        </button>
      );
    }

    render(<Disclosure />);
    const button = screen.getByLabelText("disclosure");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(parentRenders).toHaveBeenCalledTimes(1);

    act(() => {
      expanded.value = true;
    });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(parentRenders).toHaveBeenCalledTimes(1);
  });

  it("removes a false disabled attribute from an unsupported host binding", () => {
    const disabled = signal(true);

    render(jsx("div", { "aria-label": "unsupported disabled host", disabled }, undefined));
    const host = screen.getByLabelText("unsupported disabled host");
    expect(host.getAttribute("disabled")).toBe("true");

    act(() => {
      disabled.value = false;
    });
    expect(host.getAttribute("disabled")).toBeNull();
  });

  it("binds a signal directly to the style prop, clearing keys dropped from a later value", () => {
    const style = signal<Record<string, string | number>>({ color: "red", width: 10 });
    const parentRenders = vi.fn();

    function Box() {
      parentRenders();
      return <div aria-label="styled box" style={style} />;
    }

    render(<Box />);
    const box = screen.getByLabelText("styled box");
    expect(box.style.color).toBe("red");
    expect(box.style.width).toBe("10px");
    expect(parentRenders).toHaveBeenCalledTimes(1);

    act(() => {
      style.value = { background: "blue" };
    });
    expect(box.style.color).toBe("");
    expect(box.style.width).toBe("");
    expect(box.style.background).toBe("blue");
    expect(parentRenders).toHaveBeenCalledTimes(1);
  });

  it("treats known-unitless CSS properties and CSS custom properties correctly", () => {
    const style = signal<Record<string, string | number>>({ opacity: 0.5, scale: 2, "--gap": 4 });

    render(<div aria-label="unitless box" style={style} />);
    const box = screen.getByLabelText("unitless box");
    expect(box.style.opacity).toBe("0.5");
    expect(box.style.scale).toBe("2");
    expect(box.style.getPropertyValue("--gap")).toBe("4");

    act(() => {
      style.value = { opacity: 1 };
    });
    expect(box.style.opacity).toBe("1");
    expect(box.style.scale).toBe("");
    expect(box.style.getPropertyValue("--gap")).toBe("");
  });

  it("correctly applies unitless CSS properties for numeric values", () => {
    const style = signal<Record<string, string | number>>({
      lineHeight: 1.2,
      opacity: 0.5,
      width: 10,
      WebkitLineClamp: 2,
      "--size": 2,
    });

    render(<div aria-label="unitless properties box" style={style} />);
    const box = screen.getByLabelText("unitless properties box");
    expect(box.style.lineHeight).toBe("1.2");
    expect(box.style.opacity).toBe("0.5");
    expect(box.style.width).toBe("10px");
    expect((box.style as unknown as Record<string, string>)["WebkitLineClamp"]).toBe("2");
    expect(box.style.getPropertyValue("--size")).toBe("2");
  });

  it("respects unitless rule for WebkitLineClamp and other unitless properties in signal-driven style updates", () => {
    const style = signal<Record<string, string | number>>({ WebkitLineClamp: 2, lineHeight: 1.5 });

    render(<div aria-label="webkit line clamp box" style={style} />);
    const box = screen.getByLabelText("webkit line clamp box");
    // Verify WebkitLineClamp is initially set correctly (no "px" appended)
    expect((box.style as unknown as Record<string, string>)["WebkitLineClamp"]).toBe("2");
    // Verify lineHeight is initially set correctly (no "px" appended)
    expect(box.style.lineHeight).toBe("1.5");

    // Update unitless properties and verify they maintain unitless format
    act(() => {
      style.value = { lineHeight: 1.8, scale: 2 };
    });
    expect(box.style.lineHeight).toBe("1.8");
    expect(box.style.scale).toBe("2");
    // WebkitLineClamp should be cleared from previous value
    expect((box.style as unknown as Record<string, string>)["WebkitLineClamp"]).toBe("");
  });

  it("clears a rebuilt style binding's inherited keys, not just the new value's own keys", () => {
    // Regression test for a bug where rebuilding a style binding (the
    // `style={...}` prop switches from one signal to another between
    // renders) reset the fresh binding's memory of "keys currently on the
    // node" to `[]`, instead of inheriting what the disposed binding had
    // actually applied. `a` is written to *between* renders — through this
    // library's own reactive effect, which React's render never sees — so by
    // the time the binding rebuilds onto `b`, the node carries CSS
    // properties neither the disposed binding's own starting value nor the
    // new binding's value ever mentioned, and only the disposed binding's
    // live bookkeeping knew about them.
    const a = signal<Record<string, string | number>>({ color: "red", fontWeight: 700 });
    const b = signal<Record<string, string | number>>({ opacity: 0.5 });
    const useB = signal(false);

    function Box() {
      useSignals();
      return <div aria-label="rebind style box" style={useB.value ? b : a} />;
    }

    render(<Box />);
    const box = screen.getByLabelText("rebind style box");
    expect(box.style.color).toBe("red");
    expect(box.style.fontWeight).toBe("700");

    // Off-render write: `Box` never reads `a.value` while rendering (only
    // `a` itself, as the style source), so this does not trigger a re-render
    // and React's own reconciliation never observes this value.
    act(() => {
      a.value = { color: "blue", background: "green" };
    });
    expect(box.style.color).toBe("blue");
    expect(box.style.background).toBe("green");

    // Switching to `b` disposes the `a` binding and mounts a fresh one. The
    // fresh binding must inherit what the disposed one actually left on the
    // node — color and background — not start believing the node is bare.
    act(() => {
      useB.value = true;
    });
    expect(box.style.opacity).toBe("0.5");
    expect(box.style.color).toBe("");
    expect(box.style.fontWeight).toBe("");
    expect(box.style.background).toBe("");
  });

  it("preserves the DOM-native \"until-found\" hidden value instead of coercing it to a boolean", () => {
    // Regression test: the `hidden` content attribute also accepts the
    // keyword "until-found" (a collapsible, find-in-page-revealable hidden
    // state). `setDomProp`'s "hidden" case used to run every value through
    // `Boolean(...)` and the `.hidden` IDL property, which turns this truthy
    // string into a plain `true`, silently downgrading it to a hard hide.
    // Asserted via `getAttribute` rather than the `.hidden` property because
    // jsdom's own `.hidden` accessor still reflects it as a plain boolean
    // (https://github.com/jsdom/jsdom doesn't yet implement this recent HTML
    // living-standard addition) even though real browsers and the attribute
    // itself preserve the string; `getAttribute` reads the raw attribute
    // this library writes, independent of that jsdom gap. `jsx` is called
    // directly (as in the "unsupported disabled host" case above) because
    // this signal's value isn't one `React.HTMLAttributes["hidden"]`'s own
    // type admits.
    const hidden = signal<boolean | "until-found">("until-found");

    render(jsx("div", { "aria-label": "until-found box", hidden }, undefined));
    const box = screen.getByLabelText("until-found box");
    expect(box.getAttribute("hidden")).toBe("until-found");

    act(() => {
      hidden.value = false;
    });
    expect(box.getAttribute("hidden")).toBeNull();

    act(() => {
      hidden.value = true;
    });
    expect(box.getAttribute("hidden")).toBe("");

    act(() => {
      hidden.value = "until-found";
    });
    expect(box.getAttribute("hidden")).toBe("until-found");
  });

  it("binds a signal directly to a text input's value without React controlling it", () => {
    const text = signal("initial");

    function Field() {
      return <input aria-label="field" value={text} onChange={(event) => { text.value = event.target.value; }} />;
    }

    render(<Field />);
    const input = screen.getByLabelText("field") as HTMLInputElement;
    expect(input.value).toBe("initial");

    fireEvent.change(input, { target: { value: "typed" } });
    expect(text.value).toBe("typed");
    expect(input.value).toBe("typed");

    act(() => {
      text.value = "external update";
    });
    expect(input.value).toBe("external update");
  });

  it("does not let an unrelated re-render move the caret on a direct-bound value", () => {
    const text = signal("abc");
    const bump = signal(0);

    function Field() {
      useSignals();
      void bump.value;
      return <input aria-label="field" value={text} onChange={(event) => { text.value = event.target.value; }} />;
    }

    render(<Field />);
    const input = screen.getByLabelText("field") as HTMLInputElement;

    // Write from outside a React commit, the way another part of the app
    // (or this same effect on a prior keystroke) would.
    act(() => {
      text.value = "xyz";
    });
    input.focus();
    input.setSelectionRange(1, 1);

    // A re-render for an unrelated reason must not touch `value` at all: it
    // was substituted with `defaultValue`, which React only applies at mount.
    // (React 19's own controlled-`value` commit path already guards against
    // a same-value native write, so this specific assertion does not by
    // itself distinguish the two prop-handling strategies — see the caveat
    // recorded in docs/direct-binding-value-checked-style.md. The substitution
    // is still correct to keep: it avoids relying on that internal guard and
    // the per-render reconciliation work React would otherwise do here.)
    act(() => {
      bump.value++;
    });
    expect(input.value).toBe("xyz");
    expect(input.selectionStart).toBe(1);
  });

  it("defers a forced value write until an in-progress IME composition ends", () => {
    const text = signal("abc");

    function Field() {
      return <input aria-label="ime field" value={text} onChange={(event) => { text.value = event.target.value; }} />;
    }

    render(<Field />);
    const input = screen.getByLabelText("ime field") as HTMLInputElement;
    input.focus();

    fireEvent.compositionStart(input);
    // The browser renders composing IME candidates directly into `.value`
    // without necessarily running them through `onChange` on every keystroke.
    input.value = "こんに";

    // Another subscriber of the same signal writing back mid-composition —
    // not the input's own onChange — must not stomp the composing text.
    act(() => {
      text.value = "external update";
    });
    expect(input.value).toBe("こんに");

    fireEvent.compositionEnd(input);
    expect(input.value).toBe("external update");
  });

  it("binds a signal directly to a checkbox's checked state without React controlling it", () => {
    const checked = signal(false);
    const bump = signal(0);

    function Field() {
      useSignals();
      void bump.value;
      return (
        <input
          type="checkbox"
          aria-label="agree"
          checked={checked}
          onChange={(event) => { checked.value = event.target.checked; }}
        />
      );
    }

    render(<Field />);
    const input = screen.getByLabelText("agree") as HTMLInputElement;
    expect(input.checked).toBe(false);

    fireEvent.click(input);
    expect(checked.value).toBe(true);
    expect(input.checked).toBe(true);

    // An unrelated re-render must not revert the DOM to the value React
    // controlled at mount time.
    act(() => {
      bump.value++;
    });
    expect(input.checked).toBe(true);
  });

  it("binds a signal directly to a select element's value", () => {
    const choice = signal("b");

    function Field() {
      return (
        <select aria-label="choice" value={choice} onChange={(event) => { choice.value = event.target.value; }}>
          <option value="a">A</option>
          <option value="b">B</option>
          <option value="c">C</option>
        </select>
      );
    }

    render(<Field />);
    const select = screen.getByLabelText("choice") as HTMLSelectElement;
    expect(select.value).toBe("b");

    fireEvent.change(select, { target: { value: "c" } });
    expect(choice.value).toBe("c");
    expect(select.value).toBe("c");
  });

  it("binds a signal directly to a multi-select's value via per-option selection", () => {
    const choices = signal<string[]>(["a", "c"]);

    function Field() {
      return (
        <select
          multiple
          aria-label="choices"
          value={choices}
          onChange={(event) => {
            choices.value = Array.from(event.target.selectedOptions).map((option) => option.value);
          }}
        >
          <option value="a">A</option>
          <option value="b">B</option>
          <option value="c">C</option>
        </select>
      );
    }

    render(<Field />);
    const select = screen.getByLabelText("choices") as HTMLSelectElement;
    const optionStates = () => Array.from(select.options).map((option) => option.selected);
    expect(optionStates()).toEqual([true, false, true]);

    act(() => {
      choices.value = ["b"];
    });
    expect(optionStates()).toEqual([false, true, false]);
  });

  it("resyncs a bound select's value once a matching <option> is added later", async () => {
    const choice = signal("c");
    const showOptionC = signal(false);

    function Field() {
      useSignals();
      return (
        <select aria-label="late choice" value={choice} onChange={(event) => { choice.value = event.target.value; }}>
          <option value="a">A</option>
          <option value="b">B</option>
          {showOptionC.value ? <option value="c">C</option> : null}
        </select>
      );
    }

    render(<Field />);
    const select = screen.getByLabelText("late choice") as HTMLSelectElement;
    // No matching <option> exists yet, so nothing is selected — the bound
    // signal did not change, only the DOM's option list will.
    expect(select.value).toBe("");

    act(() => {
      showOptionC.value = true;
    });
    // The MutationObserver delivers its callback as a microtask, so the
    // resync lands a tick after the option is actually in the DOM.
    await waitFor(() => expect(select.value).toBe("c"));
  });

  it("unchecks radio siblings backed by independent computed signals when another is selected", () => {
    const selected = signal("a");
    const isA = computed(() => selected.value === "a");
    const isB = computed(() => selected.value === "b");

    function Field() {
      return (
        <fieldset>
          <input
            type="radio"
            name="choice"
            aria-label="option a"
            checked={isA}
            onChange={() => { selected.value = "a"; }}
          />
          <input
            type="radio"
            name="choice"
            aria-label="option b"
            checked={isB}
            onChange={() => { selected.value = "b"; }}
          />
        </fieldset>
      );
    }

    render(<Field />);
    const optionA = screen.getByLabelText("option a") as HTMLInputElement;
    const optionB = screen.getByLabelText("option b") as HTMLInputElement;
    expect(optionA.checked).toBe(true);
    expect(optionB.checked).toBe(false);

    fireEvent.click(optionB);
    expect(selected.value).toBe("b");
    expect(optionA.checked).toBe(false);
    expect(optionB.checked).toBe(true);
  });

  it("preserves focus and caret across StrictMode's double-invoked ref setup for a bound value", () => {
    const text = signal("abc");
    const bump = signal(0);

    function Field() {
      useSignals();
      void bump.value;
      return (
        <StrictMode>
          <input aria-label="strict field" value={text} onChange={(event) => { text.value = event.target.value; }} />
        </StrictMode>
      );
    }

    render(<Field />);
    const input = screen.getByLabelText("strict field") as HTMLInputElement;
    input.focus();
    input.setSelectionRange(1, 1);

    // StrictMode double-invokes the ref (setup, cleanup, setup) once at mount.
    // If that double-invoke left two live subscriptions instead of one, an
    // unrelated re-render would write `value` twice and could still move the
    // caret even though the first write leaves it untouched.
    act(() => {
      bump.value++;
    });
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("abc");
    expect(input.selectionStart).toBe(1);
  });
});

// `ReactiveHost` hands React one callback-ref identity for the lifetime of its
// element and reconciles bindings from its own layout effect instead (see
// `createReactiveHostBinder` in src/runtime/jsx.ts). Before that, the ref
// closure was rebuilt on every render — `transformProps` allocates a fresh
// `bindings` array each time — and React reads a changed callback-ref identity
// as "detach the old ref, attach the new one" on the very same DOM node. So
// *any* re-render of the owning component, for any reason at all, tore every
// binding on that element down and built it back up: a `MutationObserver`
// disconnected and recreated, composition listeners removed and re-added
// together with the `composing`/`pending` state they guard, every `effect()`
// resubscribed, and the user's own ref called with `null` and then the
// identical node again. The tests below pin each of those, plus the cases the
// identity churn was legitimately covering (a changed source, a changed key)
// so the fix cannot buy stability by dropping a real teardown.
describe("Direct DOM binding: ref identity stability", () => {
  it("does not resubscribe a direct prop binding when its owner re-renders for an unrelated reason", () => {
    const state = signal("initial-state");
    const bump = signal(0);
    // Every resubscribe re-runs the binding's effect body immediately, which
    // for a `data-*` binding is exactly one `setAttribute` — so counting those
    // counts subscriptions, without reaching into the reactive graph.
    const setAttribute = vi.spyOn(Element.prototype, "setAttribute");

    function Box() {
      useSignals();
      void bump.value;
      return <div aria-label="counted box" data-state={state} />;
    }

    render(<Box />);
    const box = screen.getByLabelText("counted box");
    expect(box.dataset.state).toBe("initial-state");
    const afterMount = attributeWrites(setAttribute, "data-state");

    act(() => {
      bump.value++;
    });
    act(() => {
      bump.value++;
    });
    expect(attributeWrites(setAttribute, "data-state")).toBe(afterMount);

    // The binding is still live, not merely quiet.
    act(() => {
      state.value = "updated-state";
    });
    expect(box.dataset.state).toBe("updated-state");
    expect(attributeWrites(setAttribute, "data-state")).toBe(afterMount + 1);
  });

  it("does not disconnect and recreate a bound select's MutationObserver on an unrelated re-render", () => {
    const choice = signal("b");
    const bump = signal(0);
    const observe = vi.spyOn(MutationObserver.prototype, "observe");
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");

    function Field() {
      useSignals();
      void bump.value;
      return (
        <select aria-label="observed choice" value={choice} onChange={(event) => { choice.value = event.target.value; }}>
          <option value="a">A</option>
          <option value="b">B</option>
          <option value="c">C</option>
        </select>
      );
    }

    render(<Field />);
    const select = screen.getByLabelText("observed choice") as HTMLSelectElement;
    expect(select.value).toBe("b");
    const observed = observe.mock.calls.length;
    const disconnected = disconnect.mock.calls.length;
    expect(observed).toBeGreaterThan(0);

    act(() => {
      bump.value++;
    });
    expect(observe).toHaveBeenCalledTimes(observed);
    expect(disconnect).toHaveBeenCalledTimes(disconnected);

    act(() => {
      choice.value = "c";
    });
    expect(select.value).toBe("c");
  });

  it("does not remove and re-add a bound input's composition listeners on an unrelated re-render", () => {
    const text = signal("abc");
    const bump = signal(0);
    const addEventListener = vi.spyOn(EventTarget.prototype, "addEventListener");
    const removeEventListener = vi.spyOn(EventTarget.prototype, "removeEventListener");

    function Field() {
      useSignals();
      void bump.value;
      return <input aria-label="listener field" value={text} onChange={(event) => { text.value = event.target.value; }} />;
    }

    render(<Field />);
    const added = listenerCalls(addEventListener, "compositionstart");
    const removed = listenerCalls(removeEventListener, "compositionend");
    expect(added).toBeGreaterThan(0);

    act(() => {
      bump.value++;
    });
    expect(listenerCalls(addEventListener, "compositionstart")).toBe(added);
    expect(listenerCalls(removeEventListener, "compositionend")).toBe(removed);
  });

  it("keeps an in-progress IME composition intact when its owner re-renders for an unrelated reason", () => {
    const text = signal("abc");
    const bump = signal(0);

    function Field() {
      useSignals();
      void bump.value;
      return <input aria-label="ime churn field" value={text} onChange={(event) => { text.value = event.target.value; }} />;
    }

    render(<Field />);
    const input = screen.getByLabelText("ime churn field") as HTMLInputElement;
    input.focus();

    fireEvent.compositionStart(input);
    // The browser renders composing IME candidates straight into `.value`.
    input.value = "こんに";

    // Rebuilding the binding here would resubscribe its effect and immediately
    // write the signal's current value over the composing text, on top of
    // losing the `composing` flag that defers later writes.
    act(() => {
      bump.value++;
    });
    expect(input.value).toBe("こんに");

    // The deferral still works after that re-render, which is the part a reset
    // `composing` flag would silently break.
    act(() => {
      text.value = "external update";
    });
    expect(input.value).toBe("こんに");

    fireEvent.compositionEnd(input);
    expect(input.value).toBe("external update");
  });

  it("does not re-invoke a stable user ref callback on an unrelated re-render", () => {
    const text = signal("abc");
    const bump = signal(0);
    const attachments: (Element | null)[] = [];
    // Declared outside the component, so its identity is stable across renders
    // the way a `useCallback`ed or module-scope ref would be.
    const trackRef = (node: Element | null) => {
      attachments.push(node);
    };

    function Field() {
      useSignals();
      void bump.value;
      return <input aria-label="tracked ref field" ref={trackRef} value={text} />;
    }

    const view = render(<Field />);
    const input = screen.getByLabelText("tracked ref field") as HTMLInputElement;
    expect(attachments).toEqual([input]);

    act(() => {
      bump.value++;
    });
    act(() => {
      bump.value++;
    });
    expect(attachments).toEqual([input]);

    view.unmount();
    expect(attachments).toEqual([input, null]);
  });

  it("tears down a binding's old subscription and subscribes the new one when its source changes", () => {
    const first = signal("first");
    const second = signal("second");
    const useSecond = signal(false);

    function Box() {
      useSignals();
      return <div aria-label="swapped box" data-state={useSecond.value ? second : first} />;
    }

    render(<Box />);
    const box = screen.getByLabelText("swapped box");
    expect(box.dataset.state).toBe("first");

    act(() => {
      first.value = "first updated";
    });
    expect(box.dataset.state).toBe("first updated");

    act(() => {
      useSecond.value = true;
    });
    expect(box.dataset.state).toBe("second");

    // The replaced source must be genuinely unsubscribed, not just unread.
    act(() => {
      first.value = "orphaned";
    });
    expect(box.dataset.state).toBe("second");

    act(() => {
      second.value = "second updated";
    });
    expect(box.dataset.state).toBe("second updated");
  });

  it("rebuilds only the binding whose source changed, leaving its siblings subscribed", () => {
    const text = signal("abc");
    const first = signal("first");
    const second = signal("second");
    const useSecond = signal(false);
    const addEventListener = vi.spyOn(EventTarget.prototype, "addEventListener");
    const setAttribute = vi.spyOn(Element.prototype, "setAttribute");

    function Field() {
      useSignals();
      return (
        <input
          aria-label="mixed field"
          value={text}
          data-state={useSecond.value ? second : first}
        />
      );
    }

    render(<Field />);
    const input = screen.getByLabelText("mixed field") as HTMLInputElement;
    expect(input.value).toBe("abc");
    expect(input.dataset.state).toBe("first");
    const added = listenerCalls(addEventListener, "compositionstart");
    const written = attributeWrites(setAttribute, "data-state");

    act(() => {
      useSecond.value = true;
    });
    // The `data-state` binding was rebuilt against its new source ...
    expect(input.dataset.state).toBe("second");
    expect(attributeWrites(setAttribute, "data-state")).toBeGreaterThan(written);
    // ... while the untouched `value` binding kept the one subscription — and
    // the composition state — it already had.
    expect(listenerCalls(addEventListener, "compositionstart")).toBe(added);

    act(() => {
      text.value = "still bound";
    });
    expect(input.value).toBe("still bound");
  });

  it("gives a new key's node a fresh binding and fully cleans up the node it replaced", () => {
    const text = signal("first");
    const slot = signal("a");
    const attachments: (Element | null)[] = [];
    const trackRef = (node: Element | null) => {
      attachments.push(node);
    };

    function Field() {
      useSignals();
      return <input key={slot.value} aria-label="keyed field" ref={trackRef} value={text} />;
    }

    render(<Field />);
    const firstNode = screen.getByLabelText("keyed field") as HTMLInputElement;
    expect(attachments).toEqual([firstNode]);
    expect(firstNode.value).toBe("first");

    act(() => {
      slot.value = "b";
    });
    const secondNode = screen.getByLabelText("keyed field") as HTMLInputElement;
    expect(secondNode).not.toBe(firstNode);
    expect(attachments).toEqual([firstNode, null, secondNode]);
    expect(secondNode.value).toBe("first");

    act(() => {
      text.value = "second";
    });
    expect(secondNode.value).toBe("second");
    // The replaced node's subscription is disposed, not just detached from the
    // document — a live effect would still be writing into it.
    expect(firstNode.value).toBe("first");
  });
});
