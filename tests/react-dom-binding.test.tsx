/** @jsxImportSource react-alien-signals */
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
