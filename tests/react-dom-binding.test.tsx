/** @jsxImportSource react-fine-grained-signals/jsx */
// @vitest-environment jsdom

import { Activity, StrictMode, Suspense, act, useState } from "react";
import type { ChangeEvent, InputEvent as ReactInputEvent, ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsx } from "../src/jsx/jsx-runtime.js";
import { createElement as createSignalAwareElement } from "../src/jsx.js";
import { computed, effect, signal, useSignal, useSignalTracking } from "../src/index.js";
import { coreRuntime } from "../src/core/core-runtime.js";

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

function waitForNextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Dispatch one native text input after bypassing React's programmatic value tracker. */
function dispatchUserTextInput(
  node: HTMLInputElement | HTMLTextAreaElement,
  value: string,
  beforeDispatch?: () => void,
): void {
  const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (!setter) throw new Error("The DOM text control has no native value setter.");
  setter.call(node, value);
  beforeDispatch?.();
  node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
}

describe("Direct DOM binding", () => {
  it("binds range inputs through the native string value path without parent renders", async () => {
    const level = signal("50");
    const events: string[] = [];
    let ownerRenders = 0;

    function Field({ source }: { source: typeof level }) {
      ownerRenders += 1;
      return (
        <form aria-label="range binding form">
          <input
            aria-label="level"
            type="range"
            min="0"
            max="100"
            step="10"
            bindValue={source}
            onInput={(event) => events.push(`input:${event.currentTarget.value}:${level.value}`)}
            onChange={(event) => events.push(`change:${event.currentTarget.value}:${level.value}`)}
          />
          <output aria-label="level output">{level}</output>
          <output aria-label="range owner renders">{ownerRenders}</output>
        </form>
      );
    }

    const view = render(<Field source={level} />);
    const input = screen.getByLabelText("level") as HTMLInputElement;
    const form = screen.getByLabelText("range binding form") as HTMLFormElement;
    expect(input.value).toBe("50");
    expect(input.type).toBe("range");

    await act(async () => {
      dispatchUserTextInput(input, "80");
      await waitForNextTask();
    });
    expect(level.value).toBe("80");
    expect(input.value).toBe("80");
    expect(screen.getByLabelText("level output").textContent).toBe("80");
    expect(events).toEqual(["input:80:80", "change:80:80"]);
    expect(ownerRenders).toBe(1);

    act(() => {
      level.value = "30";
    });
    expect(input.value).toBe("30");
    expect(screen.getByLabelText("level output").textContent).toBe("30");
    expect(ownerRenders).toBe(1);

    await act(async () => {
      form.reset();
      await Promise.resolve();
    });
    expect(level.value).toBe("30");
    expect(input.value).toBe("30");
    expect(ownerRenders).toBe(1);

    const replacement = signal("60");
    view.rerender(<Field source={replacement} />);
    expect(input.value).toBe("60");
    act(() => {
      level.value = "40";
    });
    expect(input.value).toBe("60");
    act(() => {
      replacement.value = "90";
    });
    expect(input.value).toBe("90");
    expect(ownerRenders).toBe(2);
  });

  it("binds number inputs through the string value path without parsing or constraint normalization", async () => {
    const amount = signal("1.5");
    const parsed = computed(() => (amount.value === "" ? "empty" : String(Number(amount.value))));
    const events: string[] = [];
    let ownerRenders = 0;

    function Field() {
      ownerRenders += 1;
      return (
        <form aria-label="number binding form">
          <input
            aria-label="number amount"
            type="number"
            min="0"
            max="10"
            step="0.5"
            required
            bindValue={amount}
            onInput={(event) => events.push(`input:${event.currentTarget.value}:${amount.value}`)}
            onChange={(event) => events.push(`change:${event.currentTarget.value}:${amount.value}`)}
          />
          <output aria-label="parsed amount">{parsed}</output>
        </form>
      );
    }

    render(<Field />);
    const input = screen.getByLabelText("number amount") as HTMLInputElement;
    const form = screen.getByLabelText("number binding form") as HTMLFormElement;
    expect(input.value).toBe("1.5");
    expect(input.validity.valid).toBe(true);

    await act(async () => {
      dispatchUserTextInput(input, "2.25");
      await waitForNextTask();
    });
    expect(amount.value).toBe("2.25");
    expect(input.value).toBe("2.25");
    expect(input.validity.stepMismatch).toBe(true);
    expect(screen.getByLabelText("parsed amount").textContent).toBe("2.25");
    expect(events).toEqual(["input:2.25:2.25", "change:2.25:2.25"]);
    expect(ownerRenders).toBe(1);

    act(() => {
      amount.value = "12";
    });
    expect(input.value).toBe("12");
    expect(input.validity.rangeOverflow).toBe(true);
    expect(amount.value).toBe("12");

    act(() => {
      amount.value = "";
    });
    expect(input.value).toBe("");
    expect(input.validity.valueMissing).toBe(true);
    expect(screen.getByLabelText("parsed amount").textContent).toBe("empty");
    expect(amount.value).toBe("");

    await act(async () => {
      form.reset();
      await Promise.resolve();
    });
    expect(input.value).toBe("");
    expect(amount.value).toBe("");
    expect(ownerRenders).toBe(1);
  });

  it("supports writable computed number bindings that reject or normalize strings", async () => {
    const source = signal("12.5");
    const amount = computed({
      get: () => source.value,
      set: (next: string) => {
        if (next !== "") source.value = String(Number(next));
      },
    });
    render(<input aria-label="computed number" type="number" step="any" bindValue={amount} />);
    const input = screen.getByLabelText("computed number") as HTMLInputElement;

    await act(async () => {
      dispatchUserTextInput(input, "");
      await waitForNextTask();
    });
    expect(source.value).toBe("12.5");
    expect(amount.value).toBe("12.5");
    expect(input.value).toBe("12.5");

    await act(async () => {
      dispatchUserTextInput(input, "12.50");
      await waitForNextTask();
    });
    expect(source.value).toBe("12.5");
    expect(input.value).toBe("12.5");
  });

  it("keeps classic createElement bindings reactive while forwarding custom components untouched", () => {
    const color = signal("darkorange");
    const parentRenders = vi.fn();

    function Label({ children }: { children?: ReactNode }) {
      return <output aria-label="classic custom child">{children}</output>;
    }
    function Box() {
      parentRenders();
      return (
        <>
          {createSignalAwareElement(Label, undefined, "preserved child")}
          {createSignalAwareElement("div", { "aria-label": "classic style", style: { color, width: 12 } })}
        </>
      );
    }

    render(<Box />);
    const box = screen.getByLabelText("classic style") as HTMLDivElement;
    expect(box.style.color).toBe("darkorange");
    expect(box.style.width).toBe("12px");
    expect(screen.getByLabelText("classic custom child").textContent).toBe("preserved child");
    expect(parentRenders).toHaveBeenCalledTimes(1);

    act(() => {
      color.value = "mediumseagreen";
    });
    expect(box.style.color).toBe("mediumseagreen");
    expect(parentRenders).toHaveBeenCalledTimes(1);
  });

  it("removes nullish title and id values from HTML and SVG hosts", () => {
    const title = signal<string | null | undefined>(null);
    const id = signal<string | null | undefined>(undefined);

    const { container } = render(
      <StrictMode>
        <>
          <div aria-label="HTML host" title={title} id={id} />
          <svg>
            <title title={title} id={id}>
              SVG title element
            </title>
          </svg>
        </>
      </StrictMode>,
    );
    const html = container.querySelector("div")!;
    const svg = container.querySelector("svg title")!;

    // Match React DOM's handling of nullish title/id props: there is no empty
    // attribute. SVG takes the generic attribute path and must keep the same
    // semantics as the HTML property path.
    expect(html.hasAttribute("title")).toBe(false);
    expect(html.hasAttribute("id")).toBe(false);
    expect(svg.hasAttribute("title")).toBe(false);
    expect(svg.hasAttribute("id")).toBe(false);

    act(() => {
      title.value = "bound title";
      id.value = "bound-id";
    });
    expect(html.getAttribute("title")).toBe("bound title");
    expect(html.getAttribute("id")).toBe("bound-id");
    expect(svg.getAttribute("title")).toBe("bound title");
    expect(svg.getAttribute("id")).toBe("bound-id");

    act(() => {
      title.value = null;
      id.value = undefined;
    });
    expect(html.hasAttribute("title")).toBe(false);
    expect(html.hasAttribute("id")).toBe(false);
    expect(svg.hasAttribute("title")).toBe(false);
    expect(svg.hasAttribute("id")).toBe(false);
  });

  it("reconciles nullish title and id bindings across Activity hide and reveal", async () => {
    const title = signal<string | null | undefined>(null);
    const id = signal<string | null | undefined>(undefined);
    function App({ mode }: { mode: "visible" | "hidden" }) {
      return (
        <Activity mode={mode}>
          <div title={title} id={id} />
        </Activity>
      );
    }

    const view = render(<App mode="visible" />);
    const node = view.container.querySelector("div")!;
    act(() => {
      title.value = "before hide";
      id.value = "before-hide";
    });
    expect(node.getAttribute("title")).toBe("before hide");
    expect(node.getAttribute("id")).toBe("before-hide");

    view.rerender(<App mode="hidden" />);
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      title.value = null;
      id.value = undefined;
    });
    view.rerender(<App mode="visible" />);
    expect(view.container.querySelector("div")).toBe(node);
    expect(node.hasAttribute("title")).toBe(false);
    expect(node.hasAttribute("id")).toBe(false);

    act(() => {
      title.value = "after reveal";
      id.value = "after-reveal";
    });
    expect(node.getAttribute("title")).toBe("after reveal");
    expect(node.getAttribute("id")).toBe("after-reveal");
  });

  it("attaches nullish title and id bindings after a Suspense reveal", async () => {
    const title = signal<string | null | undefined>(null);
    const id = signal<string | null | undefined>(undefined);
    let ready = false;
    let resolve!: () => void;
    const gate = new Promise<void>((done) => {
      resolve = done;
    });

    function App() {
      if (!ready) throw gate;
      return <div title={title} id={id} />;
    }

    const view = render(
      <Suspense fallback={<span>loading</span>}>
        <App />
      </Suspense>,
    );
    expect(view.container.querySelector("div")).toBeNull();
    await act(async () => {
      ready = true;
      resolve();
      await gate;
    });

    const node = view.container.querySelector("div")!;
    expect(node.hasAttribute("title")).toBe(false);
    expect(node.hasAttribute("id")).toBe(false);
    act(() => {
      title.value = "revealed";
      id.value = "revealed-id";
    });
    expect(node.getAttribute("title")).toBe("revealed");
    expect(node.getAttribute("id")).toBe("revealed-id");
  });

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
          <input aria-label="bound field" disabled={disabled} hidden={hidden} title={title} data-state={dataState} />
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

  it("binds signal-valued style properties without rerendering the component", () => {
    const color = signal("crimson");
    const opacity = signal(0.5);
    const parentRenders = vi.fn();

    function Box() {
      parentRenders();
      return <div aria-label="property-bound style" style={{ color, opacity, width: 12 }} />;
    }

    render(<Box />);
    const box = screen.getByLabelText("property-bound style") as HTMLDivElement;
    expect(box.style.color).toBe("crimson");
    expect(box.style.opacity).toBe("0.5");
    expect(box.style.width).toBe("12px");
    expect(parentRenders).toHaveBeenCalledTimes(1);

    act(() => {
      color.value = "royalblue";
      opacity.value = 0.75;
    });

    expect(box.style.color).toBe("royalblue");
    expect(box.style.opacity).toBe("0.75");
    expect(box.style.width).toBe("12px");
    expect(parentRenders).toHaveBeenCalledTimes(1);
  });

  it("clears property-bound style keys when the style shape changes across renders", () => {
    const color = signal("crimson");
    let propertyBinding = true;

    function Box() {
      return (
        <div
          aria-label="changing property style"
          style={propertyBinding ? { color, width: 12 } : { backgroundColor: "steelblue" }}
        />
      );
    }

    const view = render(<Box />);
    const box = screen.getByLabelText("changing property style") as HTMLDivElement;
    expect(box.style.color).toBe("crimson");
    expect(box.style.width).toBe("12px");

    propertyBinding = false;
    view.rerender(<Box />);
    expect(box.style.color).toBe("");
    expect(box.style.width).toBe("");
    expect(box.style.backgroundColor).toBe("steelblue");

    act(() => {
      color.value = "royalblue";
    });
    expect(box.style.color).toBe("");
    expect(box.style.backgroundColor).toBe("steelblue");
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
    // library's own reactive subscription, which React's render never sees — so by
    // the time the binding rebuilds onto `b`, the node carries CSS
    // properties neither the disposed binding's own starting value nor the
    // new binding's value ever mentioned, and only the disposed binding's
    // live bookkeeping knew about them.
    const a = signal<Record<string, string | number>>({ color: "red", fontWeight: 700 });
    const b = signal<Record<string, string | number>>({ opacity: 0.5 });
    const useB = signal(false);

    function Box() {
      useSignalTracking();
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

  it('preserves the DOM-native "until-found" hidden value instead of coercing it to a boolean', () => {
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

  it("bindValue synchronizes input, signal, and React change handlers", () => {
    const text = signal("initial");

    function Field() {
      return (
        <input
          aria-label="field"
          bindValue={text}
          onChange={(event) => {
            text.value = event.target.value;
          }}
        />
      );
    }

    render(<Field />);
    const input = screen.getByLabelText("field") as HTMLInputElement;
    expect(input.value).toBe("initial");

    fireEvent.input(input, { target: { value: "typed" } });
    expect(text.value).toBe("typed");
    expect(input.value).toBe("typed");

    act(() => {
      text.value = "external update";
    });
    expect(input.value).toBe("external update");
    expect(input.hasAttribute("bindvalue")).toBe(false);
  });

  it("bindValue supports textarea and leaves ordinary value props to React", () => {
    const text = signal("first");
    const controlled = signal("controlled");
    const onChange = vi.fn((event: ChangeEvent<HTMLTextAreaElement>) => {
      controlled.value = event.target.value;
    });

    function Field() {
      useSignalTracking();
      return (
        <>
          <textarea aria-label="bound textarea" bindValue={text} />
          <textarea aria-label="react textarea" value={controlled.value} onChange={onChange} />
        </>
      );
    }

    render(<Field />);
    const bound = screen.getByLabelText("bound textarea") as HTMLTextAreaElement;
    const reactControlled = screen.getByLabelText("react textarea") as HTMLTextAreaElement;
    expect(bound.value).toBe("first");
    expect(reactControlled.value).toBe("controlled");
    expect(bound.hasAttribute("bindvalue")).toBe(false);

    fireEvent.input(bound, { target: { value: "typed" } });
    expect(text.value).toBe("typed");
    fireEvent.change(reactControlled, { target: { value: "react edit" } });
    expect(controlled.value).toBe("react edit");
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("rejects implicit signal-valued form props and readonly binding sources", () => {
    const writable = signal("value");
    const readonly = computed(() => writable.value);
    expect(() => createSignalAwareElement("input", { value: writable })).toThrow(
      /Use bindValue.*value\.value for signal props/,
    );
    expect(() => createSignalAwareElement("input", { checked: signal(true) })).toThrow(
      /Use bindChecked.*checked\.value for signal props/,
    );
    expect(() => createSignalAwareElement("input", { bindValue: readonly })).toThrow(
      /bindValue requires writable signal/,
    );
    expect(() => createSignalAwareElement("input", { type: "radio", bindChecked: signal(false) })).toThrow(/checkbox/);
  });

  it("rejects binding and React prop ownership conflicts and select payload mismatches", () => {
    const text = signal("a");
    const checked = signal(true);
    const list = signal<string[]>(["a"]);
    expect(() => createSignalAwareElement("input", { bindValue: text, value: "a" })).toThrow(
      /bindValue cannot be combined/,
    );
    expect(() => createSignalAwareElement("textarea", { bindValue: text, defaultValue: "a" })).toThrow(
      /bindValue cannot be combined/,
    );
    expect(() => createSignalAwareElement("select", { bindValue: text, defaultValue: "a" })).toThrow(
      /bindValue cannot be combined/,
    );
    expect(() => createSignalAwareElement("input", { type: "checkbox", bindChecked: checked, checked: true })).toThrow(
      /bindChecked cannot be combined/,
    );
    expect(() =>
      createSignalAwareElement("input", { type: "checkbox", bindChecked: checked, defaultChecked: true }),
    ).toThrow(/bindChecked cannot be combined/);
    expect(() => createSignalAwareElement("select", { multiple: true, bindValue: text })).toThrow(
      /Invalid select bindValue/,
    );
    expect(() => createSignalAwareElement("select", { bindValue: list })).toThrow(/Invalid select bindValue/);
    expect(() => createSignalAwareElement("input", { type: "date", bindValue: text })).toThrow(
      /text-like, number, or range input\/textarea\/select only/,
    );
    expect(() => createSignalAwareElement("input", { type: "radio", value: "a", bindValue: text })).toThrow(
      /requires a non-empty name/,
    );
    expect(() =>
      createSignalAwareElement("input", { type: "radio", name: "choice", value: "a", bindValue: list }),
    ).toThrow(/Radio bindValue requires a string/);
    expect(() => createSignalAwareElement("input", { type: "checkbox", value: "a", bindValue: text })).toThrow(
      /array of strings/,
    );
    expect(() =>
      createSignalAwareElement("input", {
        type: "radio",
        name: "choice",
        value: "a",
        defaultChecked: true,
        bindValue: text,
      }),
    ).toThrow(/cannot be combined/);
    expect(() =>
      createSignalAwareElement("input", { type: "checkbox", value: "a", bindValue: list, bindChecked: checked }),
    ).toThrow(/cannot be combined/);
  });

  it("does not let an unrelated re-render move the caret on a direct-bound value", () => {
    const text = signal("abc");
    const bump = signal(0);

    function Field() {
      useSignalTracking();
      void bump.value;
      return (
        <input
          aria-label="field"
          bindValue={text}
          onChange={(event) => {
            text.value = event.target.value;
          }}
        />
      );
    }

    render(<Field />);
    const input = screen.getByLabelText("field") as HTMLInputElement;

    // Write from outside a React commit, the way another part of the app
    // (or this same binding update after a prior keystroke) would.
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

  it("keeps the text selection stable when an external signal write changes the value", () => {
    const text = signal("abcdef");

    render(<input aria-label="selection field" bindValue={text} />);
    const input = screen.getByLabelText("selection field") as HTMLInputElement;
    input.focus();
    input.setSelectionRange(2, 4, "backward");

    act(() => {
      text.value = "uvwxyz";
    });
    expect(input.value).toBe("uvwxyz");
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(4);
    expect(input.selectionDirection).toBe("backward");
  });

  it("defers a forced value write until an in-progress IME composition ends", () => {
    const text = signal("abc");

    function Field() {
      return (
        <input
          aria-label="ime field"
          bindValue={text}
          onChange={(event) => {
            text.value = event.target.value;
          }}
        />
      );
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

  it("bindChecked synchronizes checkbox, signal, and React change handlers", () => {
    const checked = signal(false);
    const bump = signal(0);

    function Field() {
      useSignalTracking();
      void bump.value;
      return (
        <input
          type="checkbox"
          aria-label="agree"
          bindChecked={checked}
          onChange={(event) => {
            checked.value = event.target.checked;
          }}
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

  it("bindChecked writes the signal before React's onChange reads it", () => {
    const checked = signal(false);
    const seen: Array<[boolean, boolean]> = [];
    render(
      <input
        type="checkbox"
        aria-label="seen"
        bindChecked={checked}
        onChange={(event) => {
          seen.push([event.target.checked, checked.value]);
        }}
      />,
    );
    fireEvent.click(screen.getByLabelText("seen"));
    expect(seen).toEqual([[true, true]]);
  });

  it("reverts checkbox, radio, and checkbox-group signals when a click is canceled", async () => {
    const agree = signal(false);
    const choice = signal("a");
    const tags = signal<string[]>(["x"]);
    const cancel = (event: { preventDefault(): void }) => {
      event.preventDefault();
    };
    render(
      <form>
        <input type="checkbox" aria-label="agree" bindChecked={agree} onClick={cancel} />
        <input type="radio" name="choice" value="a" aria-label="choice a" bindValue={choice} />
        <input type="radio" name="choice" value="b" aria-label="choice b" bindValue={choice} onClick={cancel} />
        <input type="checkbox" name="tags" value="x" aria-label="tag x" bindValue={tags} />
        <input type="checkbox" name="tags" value="y" aria-label="tag y" bindValue={tags} onClick={cancel} />
      </form>,
    );

    fireEvent.click(screen.getByLabelText("agree"));
    fireEvent.click(screen.getByLabelText("choice b"));
    fireEvent.click(screen.getByLabelText("tag y"));
    await act(async () => {
      await waitForNextTask();
    });

    expect(agree.value).toBe(false);
    expect((screen.getByLabelText("agree") as HTMLInputElement).checked).toBe(false);
    expect(choice.value).toBe("a");
    expect((screen.getByLabelText("choice a") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("choice b") as HTMLInputElement).checked).toBe(false);
    expect(tags.value).toEqual(["x"]);
    expect((screen.getByLabelText("tag y") as HTMLInputElement).checked).toBe(false);

    // Cancel now, accept after a later confirmation: the deferred write wins.
    render(
      <input
        type="checkbox"
        aria-label="manual"
        bindChecked={agree}
        onClick={(event) => {
          event.preventDefault();
          setTimeout(() => {
            agree.value = true;
          }, 0);
        }}
      />,
    );
    fireEvent.click(screen.getByLabelText("manual"));
    await act(async () => {
      await waitForNextTask();
    });
    await act(async () => {
      await waitForNextTask();
    });
    expect(agree.value).toBe(true);
    expect((screen.getByLabelText("manual") as HTMLInputElement).checked).toBe(true);
  });

  it("bindValue synchronizes a radio group through one shared string signal", () => {
    const choice = signal("b");
    const renders = vi.fn();
    const changes = vi.fn((event: ChangeEvent<HTMLInputElement>) => {
      expect(choice.value).toBe(event.currentTarget.value);
      expect(event.currentTarget.checked).toBe(true);
    });

    function Field() {
      renders();
      return (
        <form aria-label="radio group">
          <input type="radio" name="choice" value="a" aria-label="choice a" bindValue={choice} onChange={changes} />
          <input type="radio" name="choice" value="b" aria-label="choice b" bindValue={choice} onChange={changes} />
        </form>
      );
    }

    render(<Field />);
    const a = screen.getByLabelText("choice a") as HTMLInputElement;
    const b = screen.getByLabelText("choice b") as HTMLInputElement;
    expect(a.checked).toBe(false);
    expect(b.checked).toBe(true);

    act(() => {
      choice.value = "a";
    });
    expect(a.checked).toBe(true);
    expect(b.checked).toBe(false);
    const ownerRenders = renders.mock.calls.length;

    fireEvent.click(b);
    expect(choice.value).toBe("b");
    expect(a.checked).toBe(false);
    expect(b.checked).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(renders).toHaveBeenCalledTimes(ownerRenders);
    const data = new FormData(screen.getByLabelText("radio group") as HTMLFormElement);
    expect(data.get("choice")).toBe("b");
  });

  it("rejects distinct binding sources inside one native radio group", () => {
    const selectedA = signal("a");
    const selectedB = signal("b");
    expect(() =>
      render(
        <form aria-label="radio source mismatch">
          <input type="radio" name="mismatch" value="a" aria-label="mismatch a" bindValue={selectedA} />
          <input type="radio" name="mismatch" value="b" aria-label="mismatch b" bindValue={selectedB} />
        </form>,
      ),
    ).toThrow("Radio bindValue controls in the same native group must share one signal.");
  });

  it("disposes bindings mounted before a later binding on the same node throws", async () => {
    const selectedA = signal("a");
    const selectedB = signal("b");
    const title = signal("t0");
    expect(() =>
      render(
        <form>
          <input type="radio" name="partial" value="a" bindValue={selectedA} />
          <input type="radio" name="partial" value="b" title={title} bindValue={selectedB} />
        </form>,
      ),
    ).toThrow("Radio bindValue controls in the same native group must share one signal.");
    await act(async () => {
      await waitForNextTask();
    });
    expect(coreRuntime.hasSubscribers(title)).toBe(false);
  });

  it("switches every radio in one group to a new source in one StrictMode commit", () => {
    const sourceA = signal("a");
    const sourceB = signal("b");
    function Field() {
      const [useSourceB, setUseSourceB] = useState(false);
      const source = useSourceB ? sourceB : sourceA;
      return (
        <StrictMode>
          <form aria-label="radio source switch">
            <input type="radio" name="source-switch" value="a" aria-label="source switch a" bindValue={source} />
            <input type="radio" name="source-switch" value="b" aria-label="source switch b" bindValue={source} />
            <button type="button" aria-label="switch radio source" onClick={() => setUseSourceB(true)}>
              Switch
            </button>
          </form>
        </StrictMode>
      );
    }

    render(<Field />);
    const a = screen.getByLabelText("source switch a") as HTMLInputElement;
    const b = screen.getByLabelText("source switch b") as HTMLInputElement;
    fireEvent.click(screen.getByLabelText("switch radio source"));

    expect(screen.getByLabelText("source switch a")).toBe(a);
    expect(screen.getByLabelText("source switch b")).toBe(b);
    expect([a.checked, b.checked]).toEqual([false, true]);
  });

  it("allows replacing a detached radio group member with a different source in one commit", async () => {
    const selectedA = signal("a");
    const selectedB = signal("b");
    const view = render(
      <form aria-label="radio replacement">
        <input key="old" type="radio" name="replace" value="a" aria-label="old radio" bindValue={selectedA} />
      </form>,
    );

    view.rerender(
      <form aria-label="radio replacement">
        <input key="new" type="radio" name="replace" value="b" aria-label="new radio" bindValue={selectedB} />
      </form>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    const replacement = screen.getByLabelText("new radio") as HTMLInputElement;
    expect(replacement.checked).toBe(true);
    fireEvent.click(replacement);
    expect(selectedB.value).toBe("b");
    act(() => {
      selectedA.value = "a";
    });
    expect(replacement.checked).toBe(true);
  });

  it("keeps same-name radios with different form owners independent", () => {
    const first = signal("a");
    const second = signal("b");
    render(
      <>
        <form aria-label="first radio owner">
          <input type="radio" name="choice" value="a" aria-label="first radio" bindValue={first} />
        </form>
        <form aria-label="second radio owner">
          <input type="radio" name="choice" value="b" aria-label="second radio" bindValue={second} />
        </form>
      </>,
    );
    const a = screen.getByLabelText("first radio") as HTMLInputElement;
    const b = screen.getByLabelText("second radio") as HTMLInputElement;
    expect([a.checked, b.checked]).toEqual([true, true]);
    fireEvent.click(a);
    expect(first.value).toBe("a");
    expect(second.value).toBe("b");
    expect([a.checked, b.checked]).toEqual([true, true]);
  });

  it("refreshes one shared radio signal across different native form owners", () => {
    const selected = signal("a");
    render(
      <>
        <form aria-label="shared first owner">
          <input type="radio" name="choice" value="a" aria-label="shared first radio" bindValue={selected} />
        </form>
        <form aria-label="shared second owner">
          <input type="radio" name="choice" value="b" aria-label="shared second radio" bindValue={selected} />
        </form>
      </>,
    );
    const a = screen.getByLabelText("shared first radio") as HTMLInputElement;
    const b = screen.getByLabelText("shared second radio") as HTMLInputElement;
    expect([a.checked, b.checked]).toEqual([true, false]);
    fireEvent.click(b);
    expect(selected.value).toBe("b");
    expect([a.checked, b.checked]).toEqual([false, true]);
  });

  it("shares radio updates across React roots in one native group", () => {
    const selected = signal("a");
    const changes = vi.fn((event: ChangeEvent<HTMLInputElement>) => {
      expect(selected.value).toBe(event.currentTarget.value);
    });
    const form = document.createElement("form");
    const hostA = document.createElement("div");
    const hostB = document.createElement("div");
    form.append(hostA, hostB);
    document.body.appendChild(form);
    const rootA = render(
      <input type="radio" name="cross-root" value="a" aria-label="cross root a" bindValue={selected} />,
      { container: hostA },
    );
    const rootB = render(
      <input
        type="radio"
        name="cross-root"
        value="b"
        aria-label="cross root b"
        bindValue={selected}
        onChange={changes}
      />,
      { container: hostB },
    );
    const a = screen.getByLabelText("cross root a") as HTMLInputElement;
    const b = screen.getByLabelText("cross root b") as HTMLInputElement;
    expect([a.checked, b.checked]).toEqual([true, false]);
    fireEvent.click(b);
    expect(selected.value).toBe("b");
    expect([a.checked, b.checked]).toEqual([false, true]);
    expect(changes).toHaveBeenCalledTimes(1);
    rootA.unmount();
    rootB.unmount();
    form.remove();
  });

  it("rebinds radio reset handling when the form owner prop changes", async () => {
    const selected = signal("a");
    const firstForm = document.createElement("form");
    firstForm.id = "first-radio-owner";
    const secondForm = document.createElement("form");
    secondForm.id = "second-radio-owner";
    document.body.append(firstForm, secondForm);
    function Field() {
      const [owner, setOwner] = useState(firstForm.id);
      return (
        <>
          <button aria-label="move reset owner" onClick={() => setOwner(secondForm.id)}>
            Move
          </button>
          <input
            type="radio"
            form={owner}
            name="owner-switch"
            value="a"
            aria-label="owner switched radio"
            bindValue={selected}
          />
        </>
      );
    }
    const result = render(<Field />);
    const radio = screen.getByLabelText("owner switched radio") as HTMLInputElement;
    // Drift the DOM (and its native reset default) away from the signal, then
    // observe which form's reset re-applies the signal.
    const drift = () => {
      radio.defaultChecked = false;
      radio.checked = false;
    };
    drift();
    firstForm.reset();
    await Promise.resolve();
    expect(radio.checked).toBe(true);
    fireEvent.click(screen.getByLabelText("move reset owner"));
    drift();
    firstForm.reset();
    await Promise.resolve();
    expect(radio.checked).toBe(false);
    secondForm.reset();
    await Promise.resolve();
    expect(radio.checked).toBe(true);
    result.unmount();
    firstForm.remove();
    secondForm.remove();
  });

  it("bindValue synchronizes checkbox groups with stable array order and duplicate removal", () => {
    const selected = signal<string[]>(["b", "b"]);
    const changes = vi.fn((event: ChangeEvent<HTMLInputElement>) => {
      expect(selected.value.includes(event.currentTarget.value)).toBe(event.currentTarget.checked);
    });

    render(
      <form aria-label="checkbox group">
        <input
          type="checkbox"
          name="features"
          value="a"
          aria-label="feature a"
          bindValue={selected}
          onChange={changes}
        />
        <input
          type="checkbox"
          name="features"
          value="b"
          aria-label="feature b"
          bindValue={selected}
          onChange={changes}
        />
        <input type="checkbox" name="features" value="c" aria-label="feature c" bindValue={selected} disabled />
      </form>,
    );
    const a = screen.getByLabelText("feature a") as HTMLInputElement;
    const b = screen.getByLabelText("feature b") as HTMLInputElement;
    const c = screen.getByLabelText("feature c") as HTMLInputElement;
    expect([a.checked, b.checked, c.checked]).toEqual([false, true, false]);

    fireEvent.click(a);
    expect(selected.value).toEqual(["b", "b", "a"]);
    expect(a.checked).toBe(true);
    fireEvent.click(b);
    expect(selected.value).toEqual(["a"]);
    expect(b.checked).toBe(false);
    fireEvent.click(c);
    expect(selected.value).toEqual(["a"]);
    expect(changes).toHaveBeenCalledTimes(2);

    act(() => {
      selected.value = ["c", "b"];
    });
    expect([a.checked, b.checked, c.checked]).toEqual([false, true, true]);
    const data = new FormData(screen.getByLabelText("checkbox group") as HTMLFormElement);
    expect(data.getAll("features")).toEqual(["b"]);
  });

  it("uses the latest accepted group signal values as form reset defaults", async () => {
    const choice = signal("a");
    const selected = signal<string[]>(["x"]);
    render(
      <form aria-label="group reset form">
        <input type="radio" name="choice" value="a" aria-label="reset radio a" bindValue={choice} />
        <input type="radio" name="choice" value="b" aria-label="reset radio b" bindValue={choice} />
        <input type="checkbox" name="features" value="x" aria-label="reset feature x" bindValue={selected} />
        <input type="checkbox" name="features" value="y" aria-label="reset feature y" bindValue={selected} />
      </form>,
    );
    const form = screen.getByLabelText("group reset form") as HTMLFormElement;
    const radioB = screen.getByLabelText("reset radio b") as HTMLInputElement;
    const checkboxY = screen.getByLabelText("reset feature y") as HTMLInputElement;

    fireEvent.click(radioB);
    fireEvent.click(checkboxY);
    expect(choice.value).toBe("b");
    expect(selected.value).toEqual(["x", "y"]);
    await act(async () => {
      form.reset();
      await Promise.resolve();
    });
    expect(radioB.checked).toBe(true);
    expect(checkboxY.checked).toBe(true);
    expect(choice.value).toBe("b");
    expect(selected.value).toEqual(["x", "y"]);
  });

  it("keeps React onChange observable when a radio computed rejects, then restores the group", async () => {
    const accepted = signal("a");
    const choice = computed({
      get: () => accepted.value,
      set: (next: string) => {
        if (next === "a") accepted.value = next;
      },
    });
    const changes = vi.fn((event: ChangeEvent<HTMLInputElement>) => {
      expect(event.currentTarget.value).toBe("b");
      expect(event.currentTarget.checked).toBe(true);
    });
    render(
      <>
        <input type="radio" name="rejecting choice" value="a" aria-label="accepted radio" bindValue={choice} />
        <input
          type="radio"
          name="rejecting choice"
          value="b"
          aria-label="rejected radio"
          bindValue={choice}
          onChange={changes}
        />
      </>,
    );
    const a = screen.getByLabelText("accepted radio") as HTMLInputElement;
    const b = screen.getByLabelText("rejected radio") as HTMLInputElement;
    fireEvent.click(b);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(b.checked).toBe(true);
    await act(async () => {
      await waitForNextTask();
    });
    expect(choice.value).toBe("a");
    expect(a.checked).toBe(true);
    expect(b.checked).toBe(false);
  });

  it("cancels a pending radio correction when the same node switches binding sources", async () => {
    const accepted = signal("a");
    const rejecting = computed({
      get: () => accepted.value,
      set: (next: string) => {
        if (next === "a") accepted.value = next;
      },
    });
    const replacement = signal("b");
    const useReplacement = signal(false);
    function Field() {
      useSignalTracking();
      const source = useReplacement.value ? replacement : rejecting;
      return (
        <input
          type="radio"
          name="replaceable choice"
          value="b"
          aria-label="replaceable radio"
          bindValue={source}
          onChange={() => {
            useReplacement.value = true;
          }}
        />
      );
    }
    render(<Field />);
    const input = screen.getByLabelText("replaceable radio") as HTMLInputElement;
    expect(input.checked).toBe(false);
    fireEvent.click(input);
    expect(useReplacement.value).toBe(true);
    await act(async () => {
      await waitForNextTask();
    });
    expect(input.checked).toBe(true);
    expect(replacement.value).toBe("b");
  });

  it("keeps checkbox group reset aligned with the latest signal selection", async () => {
    const selected = signal<string[]>(["a"]);
    render(
      <form aria-label="checkbox group reset">
        <input type="checkbox" name="items" value="a" aria-label="reset item a" bindValue={selected} />
        <input type="checkbox" name="items" value="b" aria-label="reset item b" bindValue={selected} />
      </form>,
    );
    const form = screen.getByLabelText("checkbox group reset") as HTMLFormElement;
    const a = screen.getByLabelText("reset item a") as HTMLInputElement;
    const b = screen.getByLabelText("reset item b") as HTMLInputElement;
    act(() => {
      selected.value = ["b"];
    });
    expect([a.checked, b.checked]).toEqual([false, true]);
    await act(async () => {
      form.reset();
      await Promise.resolve();
    });
    expect(selected.value).toEqual(["b"]);
    expect([a.checked, b.checked]).toEqual([false, true]);
  });

  it("uses writable computed signals for input, checkbox, and select bindings", () => {
    const first = signal("John");
    const last = signal("Smith");
    const fullName = computed({
      get: () => `${first.value} ${last.value}`,
      set: (value) => {
        const [nextFirst = "", ...rest] = value.split(" ");
        first.value = nextFirst;
        last.value = rest.join(" ");
      },
    });
    const checkedSource = signal(false);
    const checked = computed({
      get: () => checkedSource.value,
      set: (value) => {
        checkedSource.value = value;
      },
    });
    const selectedSource = signal("a");
    const selected = computed({
      get: () => selectedSource.value,
      set: (value) => {
        selectedSource.value = value;
      },
    });
    const manySource = signal<string[]>(["a"]);
    const many = computed({
      get: () => manySource.value,
      set: (value) => {
        manySource.value = value;
      },
    });

    render(
      <form aria-label="writable computed form">
        <input aria-label="full name" bindValue={fullName} />
        <input type="checkbox" aria-label="writable checked" bindChecked={checked} />
        <select aria-label="writable single select" bindValue={selected}>
          <option value="a">A</option>
          <option value="b">B</option>
        </select>
        <select aria-label="writable multiple select" multiple bindValue={many}>
          <option value="a">A</option>
          <option value="b">B</option>
          <option value="c">C</option>
        </select>
      </form>,
    );

    const nameInput = screen.getByLabelText("full name") as HTMLInputElement;
    const checkbox = screen.getByLabelText("writable checked") as HTMLInputElement;
    const single = screen.getByLabelText("writable single select") as HTMLSelectElement;
    const multiple = screen.getByLabelText("writable multiple select") as HTMLSelectElement;
    expect(nameInput.value).toBe("John Smith");
    expect(checkbox.checked).toBe(false);
    expect(single.value).toBe("a");
    expect(Array.from(multiple.selectedOptions, (option) => option.value)).toEqual(["a"]);

    act(() => {
      first.value = "Ada";
      checkedSource.value = true;
      selectedSource.value = "b";
      manySource.value = ["b", "c"];
    });
    expect(nameInput.value).toBe("Ada Smith");
    expect(checkbox.checked).toBe(true);
    expect(single.value).toBe("b");
    expect(Array.from(multiple.selectedOptions, (option) => option.value)).toEqual(["b", "c"]);

    fireEvent.input(nameInput, { target: { value: "Grace Hopper" } });
    fireEvent.click(checkbox);
    fireEvent.change(single, { target: { value: "a" } });
    multiple.options[0]!.selected = true;
    multiple.options[1]!.selected = false;
    multiple.options[2]!.selected = true;
    fireEvent.change(multiple);
    expect([first.value, last.value, checkedSource.value, selectedSource.value, manySource.value]).toEqual([
      "Grace",
      "Hopper",
      false,
      "a",
      ["a", "c"],
    ]);
  });

  it("re-synchronizes a text binding when a writable computed rejects an input", async () => {
    const source = signal("123");
    const digits = computed({
      get: () => source.value,
      set: (next: string) => {
        if (/^\d+$/.test(next)) source.value = next;
      },
    });

    const observedEvents: string[] = [];
    const onChange = vi.fn((event: ChangeEvent<HTMLInputElement>) =>
      observedEvents.push(`change:${event.currentTarget.value}`),
    );
    const onInput = vi.fn((event: ReactInputEvent<HTMLInputElement>) =>
      observedEvents.push(`input:${event.currentTarget.value}`),
    );
    render(<input aria-label="digits" bindValue={digits} onChange={onChange} onInput={onInput} />);
    const input = screen.getByLabelText("digits") as HTMLInputElement;
    let changesDuringEvent = 0;
    let inputsDuringEvent = 0;
    await act(async () => {
      dispatchUserTextInput(input, "123x");
      changesDuringEvent = onChange.mock.calls.length;
      inputsDuringEvent = onInput.mock.calls.length;
      await waitForNextTask();
    });

    expect(source.value).toBe("123");
    expect(digits.value).toBe("123");
    expect(input.value).toBe("123");
    expect(changesDuringEvent).toBe(1);
    expect(inputsDuringEvent).toBe(1);
    expect(observedEvents).toEqual(["input:123x", "change:123x"]);
  });

  it("does not let a disposed computed binding overwrite a replacement signal after onChange", async () => {
    const source = signal("123");
    const digits = computed({
      get: () => source.value,
      set: (next: string) => {
        if (/^\d+$/.test(next)) source.value = next;
      },
    });
    const replacement = signal("123x");

    function RebindingInput() {
      const [useReplacement, setUseReplacement] = useState(false);
      return (
        <input
          aria-label="rebound computed input"
          bindValue={useReplacement ? replacement : digits}
          onChange={() => setUseReplacement(true)}
        />
      );
    }

    render(<RebindingInput />);
    const input = screen.getByLabelText("rebound computed input") as HTMLInputElement;
    await act(async () => {
      dispatchUserTextInput(input, "123x");
    });
    expect(input.value).toBe("123x");

    await act(async () => {
      await waitForNextTask();
    });
    expect(replacement.value).toBe("123x");
    expect(input.value).toBe("123x");
  });

  it("preserves React onChange for one accepted direct text input", async () => {
    const text = signal("before");
    const events: string[] = [];
    render(
      <input
        aria-label="accepted event"
        bindValue={text}
        onInput={(event) => events.push(`input:${event.currentTarget.value}`)}
        onChange={(event) => events.push(`change:${event.currentTarget.value}`)}
      />,
    );
    let eventsDuringInput: string[] = [];
    await act(async () => {
      dispatchUserTextInput(screen.getByLabelText("accepted event") as HTMLInputElement, "typed");
      eventsDuringInput = [...events];
      await waitForNextTask();
    });

    expect(text.value).toBe("typed");
    expect(eventsDuringInput).toEqual(["input:typed", "change:typed"]);
  });

  it("re-synchronizes same-value normalization without disturbing the caret or onChange", async () => {
    const source = signal("ABC");
    const normalized = computed({
      get: () => source.value,
      set: (next: string) => {
        source.value = next.trim().toUpperCase();
      },
    });
    const onChange = vi.fn();
    const onInput = vi.fn();
    render(<input aria-label="normalized text" bindValue={normalized} onChange={onChange} onInput={onInput} />);
    const input = screen.getByLabelText("normalized text") as HTMLInputElement;

    input.focus();
    let changesDuringEvent = 0;
    let inputsDuringEvent = 0;
    await act(async () => {
      dispatchUserTextInput(input, "ABC ", () => input.setSelectionRange(4, 4));
      changesDuringEvent = onChange.mock.calls.length;
      inputsDuringEvent = onInput.mock.calls.length;
      await waitForNextTask();
    });

    expect(source.value).toBe("ABC");
    expect(input.value).toBe("ABC");
    expect(input.selectionStart).toBe(3);
    expect(changesDuringEvent).toBe(1);
    expect(inputsDuringEvent).toBe(1);
  });

  it("re-synchronizes a normalized computed value after its getter changes", async () => {
    const source = signal("before");
    const normalized = computed({
      get: () => source.value,
      set: (next: string) => {
        source.value = next.trim().toUpperCase();
      },
    });
    const onChange = vi.fn();
    render(<input aria-label="normalized changed text" bindValue={normalized} onChange={onChange} />);
    const input = screen.getByLabelText("normalized changed text") as HTMLInputElement;

    let changesDuringEvent = 0;
    await act(async () => {
      dispatchUserTextInput(input, "  grace  ");
      changesDuringEvent = onChange.mock.calls.length;
      await waitForNextTask();
    });

    expect(source.value).toBe("GRACE");
    expect(input.value).toBe("GRACE");
    expect(changesDuringEvent).toBe(1);
  });

  it("preserves React onChange for writable computed textarea input", async () => {
    const source = signal("123");
    const digits = computed({
      get: () => source.value,
      set: (next: string) => {
        if (/^\d+$/.test(next)) source.value = next;
      },
    });
    const onChange = vi.fn();
    render(<textarea aria-label="computed textarea" bindValue={digits} onChange={onChange} />);
    const textarea = screen.getByLabelText("computed textarea") as HTMLTextAreaElement;
    await act(async () => {
      dispatchUserTextInput(textarea, "456");
      await waitForNextTask();
    });
    expect(source.value).toBe("456");
    expect(textarea.value).toBe("456");

    await act(async () => {
      dispatchUserTextInput(textarea, "456x");
      await waitForNextTask();
    });

    expect(source.value).toBe("456");
    expect(textarea.value).toBe("456");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("defers a rejected computed text edit until IME composition ends", () => {
    const source = signal("123");
    const digits = computed({
      get: () => source.value,
      set: (next: string) => {
        if (/^\d+$/.test(next)) source.value = next;
      },
    });
    render(<input aria-label="composing digits" bindValue={digits} />);
    const input = screen.getByLabelText("composing digits") as HTMLInputElement;

    fireEvent.compositionStart(input);
    input.value = "123あ";
    fireEvent.input(input);
    expect(input.value).toBe("123あ");
    expect(source.value).toBe("123");

    fireEvent.compositionEnd(input);
    expect(input.value).toBe("123");
  });

  it("keeps a queued rejected-input correction pending if IME composition starts first", async () => {
    const source = signal("123");
    const digits = computed({
      get: () => source.value,
      set: (next: string) => {
        if (/^\d+$/.test(next)) source.value = next;
      },
    });
    render(<input aria-label="queued composing digits" bindValue={digits} />);
    const input = screen.getByLabelText("queued composing digits") as HTMLInputElement;

    await act(async () => {
      dispatchUserTextInput(input, "123あ");
      fireEvent.compositionStart(input);
      await waitForNextTask();
    });
    expect(input.value).toBe("123あ");
    expect(source.value).toBe("123");

    fireEvent.compositionEnd(input);
    expect(input.value).toBe("123");
  });

  it("restores rejected writable computed values for checkboxes and selects", async () => {
    const checkedSource = signal(true);
    const checked = computed({
      get: () => checkedSource.value,
      set: (next: boolean) => {
        if (next) checkedSource.value = next;
      },
    });
    const singleSource = signal("b");
    const single = computed({
      get: () => singleSource.value,
      set: (next: string) => {
        if (next === "c") singleSource.value = next;
      },
    });
    const multipleSource = signal<string[]>(["a"]);
    const multiple = computed({
      get: () => multipleSource.value,
      set: (next: string[]) => {
        if (next.length > 0 && next.every((value) => value !== "b")) multipleSource.value = next;
      },
    });
    const checkboxChange = vi.fn();

    render(
      <>
        <input type="checkbox" aria-label="computed checkbox" bindChecked={checked} onChange={checkboxChange} />
        <select aria-label="computed single" bindValue={single}>
          <option value="a">A</option>
          <option value="b">B</option>
          <option value="c">C</option>
        </select>
        <select aria-label="computed multiple" multiple bindValue={multiple}>
          <option value="a">A</option>
          <option value="b">B</option>
          <option value="c">C</option>
        </select>
      </>,
    );

    const checkbox = screen.getByLabelText("computed checkbox") as HTMLInputElement;
    const singleSelect = screen.getByLabelText("computed single") as HTMLSelectElement;
    const multipleSelect = screen.getByLabelText("computed multiple") as HTMLSelectElement;
    fireEvent.click(checkbox);
    fireEvent.change(singleSelect, { target: { value: "a" } });
    multipleSelect.options[0]!.selected = false;
    multipleSelect.options[1]!.selected = true;
    fireEvent.change(multipleSelect);
    // A rejected checkbox write is restored after the click dispatch finishes.
    await act(async () => {
      await waitForNextTask();
    });

    expect(checkedSource.value).toBe(true);
    expect(checkbox.checked).toBe(true);
    expect(checkboxChange).toHaveBeenCalledOnce();
    expect(singleSource.value).toBe("b");
    expect(singleSelect.value).toBe("b");
    expect(multipleSource.value).toEqual(["a"]);
    expect(Array.from(multipleSelect.selectedOptions, (option) => option.value)).toEqual(["a"]);
  });

  it("batches a writable computed setter that updates multiple dependencies", () => {
    const first = signal("John");
    const last = signal("Smith");
    const fullName = computed({
      get: () => `${first.value} ${last.value}`,
      set: (next: string) => {
        const [nextFirst = "", ...rest] = next.split(" ");
        first.value = nextFirst;
        last.value = rest.join(" ");
      },
    });
    const observations: string[] = [];
    const dispose = effect(() => {
      observations.push(fullName.value);
    });
    render(<input aria-label="batched full name" bindValue={fullName} />);
    const input = screen.getByLabelText("batched full name") as HTMLInputElement;

    fireEvent.input(input, { target: { value: "Grace Hopper" } });

    expect([first.value, last.value]).toEqual(["Grace", "Hopper"]);
    expect(observations).toEqual(["John Smith", "Grace Hopper"]);
    expect(input.value).toBe("Grace Hopper");
    dispose();
  });

  it("resets a writable computed form binding to the latest accepted getter value", async () => {
    const source = signal("123");
    const digits = computed({
      get: () => source.value,
      set: (next: string) => {
        if (/^\d+$/.test(next)) source.value = next;
      },
    });
    function Form() {
      return (
        <form aria-label="computed reset form">
          <input aria-label="computed reset text" bindValue={digits} />
          <button type="reset">Reset</button>
        </form>
      );
    }

    render(<Form />);
    const form = screen.getByLabelText("computed reset form") as HTMLFormElement;
    const input = screen.getByLabelText("computed reset text") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "456" } });
    expect(source.value).toBe("456");
    expect(input.value).toBe("456");

    await act(async () => {
      fireEvent.input(input, { target: { value: "456x" } });
      await waitForNextTask();
    });
    expect(input.value).toBe("456");
    await act(async () => {
      form.reset();
      await Promise.resolve();
    });
    expect(source.value).toBe("456");
    expect(digits.value).toBe("456");
    expect(input.value).toBe("456");
  });

  it("keeps a bound checkbox's form value available to FormData", () => {
    const enabled = signal(false);
    render(
      <form aria-label="permission form">
        <input type="checkbox" name="permission" value="admin" bindChecked={enabled} />
      </form>,
    );

    const form = screen.getByLabelText("permission form") as HTMLFormElement;
    const checkbox = form.querySelector('input[name="permission"]') as HTMLInputElement;
    expect(checkbox.value).toBe("admin");
    expect(new FormData(form).has("permission")).toBe(false);

    fireEvent.click(checkbox);
    expect(enabled.value).toBe(true);
    expect(new FormData(form).get("permission")).toBe("admin");
  });

  it("resets bound inputs and checkboxes to the latest value written to their signals", () => {
    const text = signal("initial text");
    const checked = signal(false);

    function Form() {
      return (
        <form aria-label="bound reset form">
          <input
            aria-label="reset text"
            bindValue={text}
            onChange={(event) => {
              text.value = event.target.value;
            }}
          />
          <input
            type="checkbox"
            aria-label="reset checkbox"
            bindChecked={checked}
            onChange={(event) => {
              checked.value = event.target.checked;
            }}
          />
          <button type="reset">Reset</button>
        </form>
      );
    }

    render(<Form />);
    const form = screen.getByLabelText("bound reset form") as HTMLFormElement;
    const input = screen.getByLabelText("reset text") as HTMLInputElement;
    const checkbox = screen.getByLabelText("reset checkbox") as HTMLInputElement;

    act(() => {
      text.value = "latest text";
      checked.value = true;
    });
    expect(input.value).toBe("latest text");
    expect(checkbox.checked).toBe(true);

    act(() => {
      form.reset();
    });
    expect(input.value).toBe("latest text");
    expect(checkbox.checked).toBe(true);
    expect(text.value).toBe("latest text");
    expect(checked.value).toBe(true);
  });

  it("keeps the signal and reset default in sync after an accepted user edit", async () => {
    const text = signal("rendered text");
    const checked = signal(true);

    function Form() {
      return (
        <form aria-label="accepted edit reset form">
          <input
            aria-label="accepted edit reset text"
            bindValue={text}
            onChange={(event) => {
              text.value = event.target.value;
            }}
          />
          <input
            type="checkbox"
            aria-label="accepted edit reset checkbox"
            bindChecked={checked}
            onChange={(event) => {
              checked.value = event.target.checked;
            }}
          />
        </form>
      );
    }

    render(<Form />);
    const form = screen.getByLabelText("accepted edit reset form") as HTMLFormElement;
    const input = screen.getByLabelText("accepted edit reset text") as HTMLInputElement;
    const checkbox = screen.getByLabelText("accepted edit reset checkbox") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "accepted edit" } });
    fireEvent.click(checkbox);
    expect(text.value).toBe("accepted edit");
    expect(checked.value).toBe(false);
    await act(async () => {
      form.reset();
      await Promise.resolve();
    });

    // The explicit bindings restore their latest signal values after the
    // browser's reset action, despite React's event delegation.
    expect(input.value).toBe("accepted edit");
    expect(checkbox.checked).toBe(false);
    expect(text.value).toBe("accepted edit");
    expect(checked.value).toBe(false);
  });

  it("resets a user edit declined by onChange to the last signal value", async () => {
    const text = signal("signal text");

    function Form() {
      return (
        <form aria-label="declined edit form">
          <input aria-label="declined edit" bindValue={text} onChange={() => {}} />
        </form>
      );
    }

    render(<Form />);
    const form = screen.getByLabelText("declined edit form") as HTMLFormElement;
    const input = screen.getByLabelText("declined edit") as HTMLInputElement;
    input.value = "user edit";
    fireEvent.input(input, { target: { value: "user edit" } });
    expect(input.value).toBe("user edit");
    expect(text.value).toBe("user edit");

    await act(async () => {
      form.reset();
      await Promise.resolve();
    });
    expect(input.value).toBe("user edit");
    expect(text.value).toBe("user edit");
  });

  it("keeps React-controlled select props available", () => {
    const choice = signal("b");

    function Field() {
      useSignalTracking();
      return (
        <select
          aria-label="choice"
          value={choice.value}
          onChange={(event) => {
            choice.value = event.target.value;
          }}
        >
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

  it("keeps React-controlled multi-select props available", () => {
    const choices = signal<string[]>(["a", "c"]);

    function Field() {
      useSignalTracking();
      return (
        <select
          multiple
          aria-label="choices"
          value={choices.value}
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

  it("bindValue synchronizes a single select both ways without rerendering its owner", () => {
    const choice = signal("b");
    const renders = vi.fn();
    const changes = vi.fn((event: ChangeEvent<HTMLSelectElement>) => {
      expect(choice.value).toBe(event.currentTarget.value);
    });

    function Field() {
      renders();
      return (
        <select aria-label="bound choice" bindValue={choice} onChange={changes}>
          <option value="a">A</option>
          <option value="b">B</option>
          <option value="c">C</option>
        </select>
      );
    }

    render(<Field />);
    const select = screen.getByLabelText("bound choice") as HTMLSelectElement;
    expect(select.value).toBe("b");
    const firstRenderCount = renders.mock.calls.length;

    act(() => {
      choice.value = "a";
    });
    expect(select.value).toBe("a");
    expect(renders).toHaveBeenCalledTimes(firstRenderCount);

    fireEvent.change(select, { target: { value: "c" } });
    expect(choice.value).toBe("c");
    expect(select.value).toBe("c");
    expect(changes).toHaveBeenCalledTimes(1);
    expect(renders).toHaveBeenCalledTimes(firstRenderCount);
  });

  it("bindValue synchronizes multiple selects from selectedOptions in DOM order", () => {
    const choices = signal<string[]>(["c", "a"]);
    const changes = vi.fn();
    render(
      <select aria-label="bound choices" multiple bindValue={choices} onChange={changes}>
        <option value="a">A</option>
        <option value="b">B</option>
        <option value="c">C</option>
      </select>,
    );
    const select = screen.getByLabelText("bound choices") as HTMLSelectElement;
    const selected = () => Array.from(select.selectedOptions, (option) => option.value);
    expect(selected()).toEqual(["a", "c"]);

    act(() => {
      choices.value = ["b"];
    });
    expect(selected()).toEqual(["b"]);

    select.options[0]!.selected = true;
    select.options[1]!.selected = false;
    select.options[2]!.selected = true;
    fireEvent.change(select);
    expect(choices.value).toEqual(["a", "c"]);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("replaces select sources and cleans subscriptions and option observers on detach", async () => {
    const first = signal("a");
    const second = signal("b");
    const useSecond = signal(false);
    const observe = vi.spyOn(MutationObserver.prototype, "observe");
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    function Field() {
      useSignalTracking();
      return (
        <select aria-label="replaceable select" bindValue={useSecond.value ? second : first}>
          <option value="a">A</option>
          <option value="b">B</option>
        </select>
      );
    }
    const view = render(<Field />);
    const select = screen.getByLabelText("replaceable select") as HTMLSelectElement;
    expect(select.value).toBe("a");
    expect(observe).toHaveBeenCalledTimes(1);

    act(() => {
      useSecond.value = true;
    });
    expect(select.value).toBe("b");
    expect(observe).toHaveBeenCalledTimes(2);
    act(() => {
      first.value = "a";
    });
    expect(select.value).toBe("b");
    act(() => {
      second.value = "a";
    });
    expect(select.value).toBe("a");

    view.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(disconnect).toHaveBeenCalledTimes(2);
    act(() => {
      second.value = "b";
    });
    expect(select.value).toBe("a");
  });

  it("resynchronizes single and multiple bound selects when options are inserted or removed", async () => {
    const choice = signal("late");
    const choices = signal<string[]>(["a", "late"]);
    const showLate = signal(false);
    function Field() {
      useSignalTracking();
      return (
        <>
          <select aria-label="dynamic single" bindValue={choice}>
            <option value="a">A</option>
            {showLate.value ? <option value="late">Late</option> : null}
          </select>
          <select aria-label="dynamic multiple" multiple bindValue={choices}>
            <option value="a">A</option>
            {showLate.value ? <option value="late">Late</option> : null}
          </select>
        </>
      );
    }
    render(<Field />);
    const single = screen.getByLabelText("dynamic single") as HTMLSelectElement;
    const multiple = screen.getByLabelText("dynamic multiple") as HTMLSelectElement;
    expect(single.value).toBe("");
    expect(Array.from(multiple.selectedOptions, (option) => option.value)).toEqual(["a"]);

    act(() => {
      showLate.value = true;
    });
    await waitFor(() => {
      expect(single.value).toBe("late");
      expect(Array.from(multiple.selectedOptions, (option) => option.value)).toEqual(["a", "late"]);
    });
    act(() => {
      showLate.value = false;
    });
    await waitFor(() => {
      expect(single.value).toBe("");
      expect(Array.from(multiple.selectedOptions, (option) => option.value)).toEqual(["a"]);
    });
    expect(choice.value).toBe("late");
    expect(choices.value).toEqual(["a", "late"]);
  });

  it("resets bound selects to the latest accepted signal values and honors canceled reset", async () => {
    const choice = signal("a");
    const choices = signal<string[]>(["a"]);
    const includeLateOption = signal(false);
    function Form() {
      useSignalTracking();
      return (
        <form
          aria-label="bound select reset"
          onReset={(event) => {
            if (event.currentTarget.dataset.cancel === "true") event.preventDefault();
          }}
        >
          <select aria-label="reset bound single" bindValue={choice}>
            <option value="a">A</option>
            <option value="b">B</option>
            {includeLateOption.value ? <option value="late">Late</option> : null}
          </select>
          <select aria-label="reset bound multiple" multiple bindValue={choices}>
            <option value="a">A</option>
            <option value="b">B</option>
            {includeLateOption.value ? <option value="late">Late</option> : null}
          </select>
        </form>
      );
    }
    render(<Form />);
    const form = screen.getByLabelText("bound select reset") as HTMLFormElement;
    const single = screen.getByLabelText("reset bound single") as HTMLSelectElement;
    const multiple = screen.getByLabelText("reset bound multiple") as HTMLSelectElement;
    act(() => {
      choice.value = "b";
      choices.value = ["b"];
    });
    await act(async () => {
      form.reset();
      await Promise.resolve();
    });
    expect(choice.value).toBe("b");
    expect(single.value).toBe("b");
    expect(choices.value).toEqual(["b"]);
    expect(Array.from(multiple.selectedOptions, (option) => option.value)).toEqual(["b"]);

    form.dataset.cancel = "true";
    act(() => {
      single.value = "a";
      multiple.options[0]!.selected = true;
    });
    await act(async () => {
      fireEvent.reset(form);
      await Promise.resolve();
    });
    expect(single.value).toBe("a");
    expect(Array.from(multiple.selectedOptions, (option) => option.value)).toEqual(["a", "b"]);
    expect(choice.value).toBe("b");
    expect(choices.value).toEqual(["b"]);

    act(() => {
      choice.value = "late";
      choices.value = ["late"];
      includeLateOption.value = true;
    });
    await waitFor(() => {
      expect(single.value).toBe("late");
      expect(Array.from(multiple.selectedOptions, (option) => option.value)).toEqual(["late"]);
    });
    await act(async () => {
      form.reset();
      await Promise.resolve();
    });
    expect(single.value).toBe("late");
    expect(Array.from(multiple.selectedOptions, (option) => option.value)).toEqual(["late"]);
  });

  it("keeps a React-controlled select in sync when a matching <option> is added later", async () => {
    const choice = signal("c");
    const showOptionC = signal(false);

    function Field() {
      useSignalTracking();
      return (
        <select
          aria-label="late choice"
          value={choice.value}
          onChange={(event) => {
            choice.value = event.target.value;
          }}
        >
          <option value="a">A</option>
          <option value="b">B</option>
          {showOptionC.value ? <option value="c">C</option> : null}
        </select>
      );
    }

    render(<Field />);
    const select = screen.getByLabelText("late choice") as HTMLSelectElement;
    // Native single-select behavior chooses the first option until the
    // controlled value has a matching option.
    expect(select.value).toBe("a");

    act(() => {
      showOptionC.value = true;
    });
    // The MutationObserver delivers its callback as a microtask, so the
    // resync lands a tick after the option is actually in the DOM.
    await waitFor(() => expect(select.value).toBe("c"));
  });

  it("leaves select reset semantics to React and the browser", () => {
    const choice = signal("a");
    const choices = signal<string[]>(["a"]);

    function Form() {
      useSignalTracking();
      return (
        <form aria-label="select reset form">
          <select
            aria-label="reset choice"
            value={choice.value}
            onChange={(event) => {
              choice.value = event.target.value;
            }}
          >
            <option value="a">A</option>
            <option value="b">B</option>
            <option value="c">C</option>
          </select>
          <select
            aria-label="reset choices"
            multiple
            value={choices.value}
            onChange={(event) => {
              choices.value = Array.from(event.target.selectedOptions, (option) => option.value);
            }}
          >
            <option value="a">A</option>
            <option value="b">B</option>
            <option value="c">C</option>
          </select>
          <button type="reset">Reset</button>
        </form>
      );
    }

    render(<Form />);
    const form = screen.getByLabelText("select reset form") as HTMLFormElement;
    const single = screen.getByLabelText("reset choice") as HTMLSelectElement;
    const multiple = screen.getByLabelText("reset choices") as HTMLSelectElement;

    act(() => {
      choice.value = "c";
      choices.value = ["b", "c"];
    });
    expect(single.value).toBe("c");
    expect(Array.from(multiple.selectedOptions, (option) => option.value)).toEqual(["b", "c"]);

    act(() => {
      form.reset();
    });
    expect(single.value).toBe("a");
    // React's controlled multi-select does not define a signal reset contract;
    // jsdom resets it to the current native defaults (none selected here).
    expect(Array.from(multiple.selectedOptions, (option) => option.value)).toEqual([]);
    expect(choice.value).toBe("c");
    expect(choices.value).toEqual(["b", "c"]);
  });

  it("unchecks radio siblings backed by independent computed signals when another is selected", () => {
    const selected = signal("a");
    const isA = computed(() => selected.value === "a");
    const isB = computed(() => selected.value === "b");

    function Field() {
      useSignalTracking();
      return (
        <fieldset>
          <input
            type="radio"
            name="choice"
            aria-label="option a"
            checked={isA.value}
            onChange={() => {
              selected.value = "a";
            }}
          />
          <input
            type="radio"
            name="choice"
            aria-label="option b"
            checked={isB.value}
            onChange={() => {
              selected.value = "b";
            }}
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
      useSignalTracking();
      void bump.value;
      return (
        <StrictMode>
          <input
            aria-label="strict field"
            bindValue={text}
            onChange={(event) => {
              text.value = event.target.value;
            }}
          />
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
// together with the `composing`/`pending` state they guard, every subscription
// resubscribed, and the user's own ref called with `null` and then the
// identical node again. The tests below pin each of those, plus the cases the
// identity churn was legitimately covering (a changed source, a changed key)
// so the fix cannot buy stability by dropping a real teardown.
describe("Direct DOM binding: ref identity stability", () => {
  it.each([9, 16, 32])("keeps callback refs stable across %i bound siblings", async (count) => {
    const bases = Array.from({ length: count }, (_, index) => signal(String(index)));
    const evaluations = Array.from({ length: count }, () => 0);
    const sources = bases.map((base, index) =>
      computed(() => {
        evaluations[index] = (evaluations[index] ?? 0) + 1;
        return base.value;
      }),
    );
    const shared = signal("shared");
    const bump = signal(0);
    const calls: (Element | null)[] = [];
    const userRef = (node: Element | null) => {
      calls.push(node);
    };

    function Rows() {
      useSignalTracking();
      void bump.value;
      return (
        <>
          {sources.map((source, index) => (
            <div key={index} title={shared} data-row={source} ref={userRef} />
          ))}
        </>
      );
    }

    const view = render(<Rows />);
    const nodes = [...view.container.querySelectorAll("[data-row]")];
    expect(calls).toEqual(nodes);

    act(() => {
      bump.value += 1;
    });
    act(() => {
      bump.value += 1;
    });
    expect(calls).toEqual(nodes);

    const beforeSignalUpdate = [...evaluations];
    act(() => {
      bases.forEach((base, index) => {
        base.value = `updated-${index}`;
      });
    });
    expect(nodes.map((node) => node.getAttribute("data-row"))).toEqual(bases.map((_, index) => `updated-${index}`));
    expect(evaluations).toEqual(beforeSignalUpdate.map((count) => count + 1));

    const beforeUnmount = [...evaluations];
    view.unmount();
    expect(calls).toEqual([...nodes, ...Array.from({ length: count }, () => null)]);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    bases.forEach((base, index) => {
      base.value = `after-${index}`;
    });
    expect(evaluations).toEqual(beforeUnmount);
  });

  it("does not resubscribe a direct prop binding when its owner re-renders for an unrelated reason", () => {
    const state = signal("initial-state");
    const bump = signal(0);
    // Every resubscribe immediately applies the current value, which
    // for a `data-*` binding is exactly one `setAttribute` — so counting those
    // counts subscriptions, without reaching into the reactive graph.
    const setAttribute = vi.spyOn(Element.prototype, "setAttribute");

    function Box() {
      useSignalTracking();
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

  it("does not remove and re-add a bound input's composition listeners on an unrelated re-render", () => {
    const text = signal("abc");
    const bump = signal(0);
    const addEventListener = vi.spyOn(EventTarget.prototype, "addEventListener");
    const removeEventListener = vi.spyOn(EventTarget.prototype, "removeEventListener");

    function Field() {
      useSignalTracking();
      void bump.value;
      return (
        <input
          aria-label="listener field"
          bindValue={text}
          onChange={(event) => {
            text.value = event.target.value;
          }}
        />
      );
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
      useSignalTracking();
      void bump.value;
      return (
        <input
          aria-label="ime churn field"
          bindValue={text}
          onChange={(event) => {
            text.value = event.target.value;
          }}
        />
      );
    }

    render(<Field />);
    const input = screen.getByLabelText("ime churn field") as HTMLInputElement;
    input.focus();

    fireEvent.compositionStart(input);
    // The browser renders composing IME candidates straight into `.value`.
    input.value = "こんに";

    // Rebuilding the binding here would resubscribe and immediately update
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
      useSignalTracking();
      void bump.value;
      return <input aria-label="tracked ref field" ref={trackRef} bindValue={text} />;
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
      useSignalTracking();
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
      useSignalTracking();
      return <input aria-label="mixed field" bindValue={text} data-state={useSecond.value ? second : first} />;
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
      useSignalTracking();
      return <input key={slot.value} aria-label="keyed field" ref={trackRef} bindValue={text} />;
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
    // document — a live subscription would still be writing into it.
    expect(firstNode.value).toBe("first");
  });

  it.each([9, 16, 32])("keeps same-source radio/checkbox option refs stable for %i siblings", async (count) => {
    for (const kind of ["radio", "checkbox"] as const) {
      for (const useCommonRef of [false, true]) {
        const values = Array.from({ length: count }, (_, index) => `option-${index}`);
        const radioSelection = signal(values[0]!);
        const checkboxSelection = signal<string[]>([values[0]!]);
        const refEvents: (Element | null)[] = [];
        const commonRef = (node: Element | null) => {
          refEvents.push(node);
        };
        const addClick = vi.spyOn(HTMLInputElement.prototype, "addEventListener");
        const removeClick = vi.spyOn(HTMLInputElement.prototype, "removeEventListener");
        const createOptions = () =>
          kind === "radio"
            ? values.map((value) =>
                createSignalAwareElement("input", {
                  type: "radio",
                  name: "same-options",
                  value,
                  bindValue: radioSelection,
                  ...(useCommonRef ? { ref: commonRef } : {}),
                }),
              )
            : values.map((value) =>
                createSignalAwareElement("input", {
                  type: "checkbox",
                  name: "same-options",
                  value,
                  bindValue: checkboxSelection,
                  ...(useCommonRef ? { ref: commonRef } : {}),
                }),
              );
        function Group() {
          const [revision, setRevision] = useState(0);
          return (
            <form aria-label={`${kind} group ${count} ${useCommonRef}`}>
              <button
                type="button"
                aria-label="rerender option group"
                onClick={() => setRevision((value) => value + 1)}
              >
                {revision}
              </button>
              {values.map((value) =>
                kind === "radio" ? (
                  <input
                    key={value}
                    type="radio"
                    name="same-options"
                    value={value}
                    aria-label={value}
                    bindValue={radioSelection}
                    ref={useCommonRef ? commonRef : undefined}
                  />
                ) : (
                  <input
                    key={value}
                    type="checkbox"
                    name="same-options"
                    value={value}
                    aria-label={value}
                    bindValue={checkboxSelection}
                    ref={useCommonRef ? commonRef : undefined}
                  />
                ),
              )}
            </form>
          );
        }

        const view = render(<Group />);
        const firstRefs = createOptions().map((element) => (element.props as { ref?: unknown }).ref);
        const secondRefs = createOptions().map((element) => (element.props as { ref?: unknown }).ref);
        expect(secondRefs).toEqual(firstRefs);
        const inputs = values.map((value) => screen.getByLabelText(value) as HTMLInputElement);
        expect(
          inputs.every(
            (input) =>
              input.checked ===
              (kind === "radio" ? radioSelection.value === input.value : checkboxSelection.value.includes(input.value)),
          ),
        ).toBe(true);
        const mountedRefEvents = [...refEvents];
        const initialClickAdds = addClick.mock.calls.filter(
          (call, index) => call[0] === "click" && addClick.mock.contexts[index] instanceof HTMLInputElement,
        ).length;
        addClick.mockClear();
        removeClick.mockClear();

        fireEvent.click(screen.getByLabelText("rerender option group"));

        expect(refEvents).toEqual(mountedRefEvents);
        expect(
          addClick.mock.calls.filter(
            (call, index) => call[0] === "click" && addClick.mock.contexts[index] instanceof HTMLInputElement,
          ),
        ).toHaveLength(0);
        expect(
          removeClick.mock.calls.filter(
            (call, index) => call[0] === "click" && removeClick.mock.contexts[index] instanceof HTMLInputElement,
          ),
        ).toHaveLength(0);
        if (kind === "radio") {
          fireEvent.click(inputs[count - 1]!);
        } else {
          fireEvent.click(inputs[count - 1]!);
        }
        expect(kind === "radio" ? radioSelection.value : checkboxSelection.value).toEqual(
          kind === "radio" ? values[count - 1] : [values[0], values[count - 1]],
        );
        expect(inputs[count - 1]!.checked).toBe(true);
        fireEvent.click(screen.getByLabelText("rerender option group"));
        expect(refEvents).toEqual(mountedRefEvents);
        expect(
          addClick.mock.calls.filter(
            (call, index) => call[0] === "click" && addClick.mock.contexts[index] instanceof HTMLInputElement,
          ),
        ).toHaveLength(0);
        expect(
          removeClick.mock.calls.filter(
            (call, index) => call[0] === "click" && removeClick.mock.contexts[index] instanceof HTMLInputElement,
          ),
        ).toHaveLength(0);
        const form = screen.getByLabelText(`${kind} group ${count} ${useCommonRef}`) as HTMLFormElement;
        await act(async () => {
          form.reset();
          await waitForNextTask();
        });
        expect(kind === "radio" ? radioSelection.value : checkboxSelection.value).toEqual(
          kind === "radio" ? values[count - 1] : [values[0], values[count - 1]],
        );
        expect(inputs[count - 1]!.checked).toBe(true);

        view.unmount();
        await act(async () => {
          await waitForNextTask();
        });
        expect(coreRuntime.hasSubscribers(kind === "radio" ? radioSelection : checkboxSelection)).toBe(false);
        expect(refEvents.filter((node) => node === null)).toHaveLength(useCommonRef ? count : 0);
        expect(initialClickAdds).toBe(count);
        addClick.mockRestore();
        removeClick.mockRestore();
      }
    }
  });
});

describe("M17.4 form binding review fixes", () => {
  const nextTask = async () => {
    await act(async () => {
      await waitForNextTask();
    });
  };

  it("reverts a canceled click even when the handler unmounts the control", async () => {
    const agree = signal(false);
    const tags = signal<string[]>([]);
    const choice = signal("a");
    function Panel() {
      const [open, setOpen] = useState(true);
      const close = (event: { preventDefault(): void }) => {
        event.preventDefault();
        setOpen(false);
      };
      if (!open) return <p>closed</p>;
      return (
        <form>
          <input type="checkbox" aria-label="agree" bindChecked={agree} onClick={close} />
          <input type="checkbox" name="tags" value="x" aria-label="tag x" bindValue={tags} onClick={close} />
          <input type="radio" name="choice" value="a" bindValue={choice} />
          <input type="radio" name="choice" value="b" aria-label="choice b" bindValue={choice} onClick={close} />
        </form>
      );
    }
    for (const label of ["agree", "tag x", "choice b"]) {
      const view = render(<Panel />);
      fireEvent.click(screen.getByLabelText(label));
      await nextTask();
      view.unmount();
    }
    expect(agree.value).toBe(false);
    expect(tags.value).toEqual([]);
    expect(choice.value).toBe("a");
  });

  it("keeps React's onChange for a radio whose setter normalizes to another option", async () => {
    const base = signal("a");
    const normalized = computed({
      get: () => base.value,
      set: (next: string) => {
        base.value = next === "b" ? "c" : next;
      },
    });
    const seen: string[] = [];
    render(
      <form>
        {["a", "b", "c"].map((option) => (
          <input
            key={option}
            type="radio"
            name="n"
            value={option}
            aria-label={`n ${option}`}
            bindValue={normalized}
            onChange={(event) => seen.push(`${option}:${event.target.checked}`)}
          />
        ))}
      </form>,
    );
    fireEvent.click(screen.getByLabelText("n b"));
    expect(seen).toEqual(["b:true"]);
    await nextTask();
    expect(base.value).toBe("c");
    expect((screen.getByLabelText("n c") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("n b") as HTMLInputElement).checked).toBe(false);
  });

  it("lets React's onChange see the user's selection before a select correction", async () => {
    const base = signal("a");
    const rejecting = computed({
      get: () => base.value,
      set: (next: string) => {
        if (next !== "b") base.value = next;
      },
    });
    const seen: string[] = [];
    render(
      <select aria-label="rejecting" bindValue={rejecting} onChange={(event) => seen.push(event.target.value)}>
        <option value="a">A</option>
        <option value="b">B</option>
      </select>,
    );
    const select = screen.getByLabelText("rejecting") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "b" } });
    expect(seen).toEqual(["b"]);
    await nextTask();
    expect(select.value).toBe("a");
  });

  it("reverts only the canceled option when another group member is clicked in the same task", async () => {
    const tags = signal<string[]>([]);
    render(
      <form>
        <input
          type="checkbox"
          name="tags"
          value="x"
          aria-label="tag x"
          bindValue={tags}
          onClick={(event) => event.preventDefault()}
        />
        <input type="checkbox" name="tags" value="y" aria-label="tag y" bindValue={tags} />
      </form>,
    );
    fireEvent.click(screen.getByLabelText("tag x"));
    fireEvent.click(screen.getByLabelText("tag y"));
    await nextTask();
    expect(tags.value).toEqual(["y"]);
    expect((screen.getByLabelText("tag x") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("tag y") as HTMLInputElement).checked).toBe(true);
  });

  it("treats binding props explicitly set to undefined as absent", () => {
    const text = signal("t");
    const agree = signal(true);
    const conditional = undefined as typeof text | undefined;
    render(
      <>
        <input aria-label="optional binding" {...({ bindValue: conditional } as object)} />
        <input aria-label="undefined value" bindValue={text} {...({ value: undefined } as object)} />
        <input
          type="checkbox"
          aria-label="undefined checked"
          bindChecked={agree}
          {...({ checked: undefined } as object)}
        />
      </>,
    );
    expect(screen.getByLabelText("optional binding").hasAttribute("bindvalue")).toBe(false);
    expect((screen.getByLabelText("undefined value") as HTMLInputElement).value).toBe("t");
    expect((screen.getByLabelText("undefined checked") as HTMLInputElement).checked).toBe(true);
  });

  it("restores the DOM after a throwing setter and ignores clicks on disabled checkboxes", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const windowErrors: unknown[] = [];
    const onError = (event: ErrorEvent) => {
      windowErrors.push(event.error);
      event.preventDefault();
    };
    window.addEventListener("error", onError);
    try {
      const textBase = signal("ok");
      const text = computed({
        get: () => textBase.value,
        set: () => {
          throw new Error("no text");
        },
      });
      const flagBase = signal(false);
      const flag = computed({
        get: () => flagBase.value,
        set: () => {
          throw new Error("no flag");
        },
      });
      const disabledFlag = signal(false);
      render(
        <>
          <input aria-label="throwing text" bindValue={text} />
          <input type="checkbox" aria-label="throwing flag" bindChecked={flag} />
          <input type="checkbox" aria-label="disabled flag" disabled bindChecked={disabledFlag} />
        </>,
      );
      const input = screen.getByLabelText("throwing text") as HTMLInputElement;
      dispatchUserTextInput(input, "ok!");
      fireEvent.click(screen.getByLabelText("throwing flag"));
      fireEvent.click(screen.getByLabelText("disabled flag"));
      await nextTask();
      expect(input.value).toBe("ok");
      expect((screen.getByLabelText("throwing flag") as HTMLInputElement).checked).toBe(false);
      expect(disabledFlag.value).toBe(false);
    } finally {
      window.removeEventListener("error", onError);
      errors.mockRestore();
    }
  });

  it("never passes binding props to non-HTML hosts", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<svg>{createSignalAwareElement("circle", { bindValue: undefined, r: 1 }) as ReactNode}</svg>);
      expect(errors).not.toHaveBeenCalled();
      expect(() => createSignalAwareElement("circle", { bindValue: signal("x") })).toThrow(
        /text-like, number, or range input\/textarea\/select only/,
      );
    } finally {
      errors.mockRestore();
    }
  });
});
