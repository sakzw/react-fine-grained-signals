/** @jsxImportSource react-fine-grained-signals */
// @vitest-environment jsdom

import { Activity, StrictMode, Suspense, act } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsx } from "../src/jsx-runtime.js";
import { computed, createElement as createSignalAwareElement, signal, useSignal, useSignalTracking } from "../src/index.js";

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
  it("keeps classic createElement bindings reactive while forwarding custom components untouched", () => {
    const color = signal("darkorange");
    const parentRenders = vi.fn();

    function Label({ children }: { children?: ReactNode }) {
      return <output aria-label="classic custom child">{children}</output>;
    }
    function Box() {
      parentRenders();
      return <>
        {createSignalAwareElement(Label, undefined, "preserved child")}
        {createSignalAwareElement("div", { "aria-label": "classic style", style: { color, width: 12 } })}
      </>;
    }

    render(<Box />);
    const box = screen.getByLabelText("classic style") as HTMLDivElement;
    expect(box.style.color).toBe("darkorange");
    expect(box.style.width).toBe("12px");
    expect(screen.getByLabelText("classic custom child").textContent).toBe("preserved child");
    expect(parentRenders).toHaveBeenCalledTimes(1);

    act(() => { color.value = "mediumseagreen"; });
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
            <title title={title} id={id}>SVG title element</title>
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
      return <Activity mode={mode}><div title={title} id={id} /></Activity>;
    }

    const view = render(<App mode="visible" />);
    const node = view.container.querySelector("div")!;
    act(() => { title.value = "before hide"; id.value = "before-hide"; });
    expect(node.getAttribute("title")).toBe("before hide");
    expect(node.getAttribute("id")).toBe("before-hide");

    view.rerender(<App mode="hidden" />);
    await act(async () => { await Promise.resolve(); });
    act(() => { title.value = null; id.value = undefined; });
    view.rerender(<App mode="visible" />);
    expect(view.container.querySelector("div")).toBe(node);
    expect(node.hasAttribute("title")).toBe(false);
    expect(node.hasAttribute("id")).toBe(false);

    act(() => { title.value = "after reveal"; id.value = "after-reveal"; });
    expect(node.getAttribute("title")).toBe("after reveal");
    expect(node.getAttribute("id")).toBe("after-reveal");
  });

  it("attaches nullish title and id bindings after a Suspense reveal", async () => {
    const title = signal<string | null | undefined>(null);
    const id = signal<string | null | undefined>(undefined);
    let ready = false;
    let resolve!: () => void;
    const gate = new Promise<void>((done) => { resolve = done; });

    function App() {
      if (!ready) throw gate;
      return <div title={title} id={id} />;
    }

    const view = render(<Suspense fallback={<span>loading</span>}><App /></Suspense>);
    expect(view.container.querySelector("div")).toBeNull();
    await act(async () => {
      ready = true;
      resolve();
      await gate;
    });

    const node = view.container.querySelector("div")!;
    expect(node.hasAttribute("title")).toBe(false);
    expect(node.hasAttribute("id")).toBe(false);
    act(() => { title.value = "revealed"; id.value = "revealed-id"; });
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
      return <div aria-label="changing property style" style={propertyBinding
        ? { color, width: 12 }
        : { backgroundColor: "steelblue" }} />;
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

    act(() => { color.value = "royalblue"; });
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

  it("bindValue synchronizes input, signal, and React change handlers", () => {
    const text = signal("initial");

    function Field() {
      return <input aria-label="field" bindValue={text} onChange={(event) => { text.value = event.target.value; }} />;
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
    expect(() => createSignalAwareElement("input", { value: writable })).toThrow(/Use bindValue.*value\.value for signal props/);
    expect(() => createSignalAwareElement("input", { checked: signal(true) })).toThrow(/Use bindChecked.*checked\.value for signal props/);
    expect(() => createSignalAwareElement("input", { bindValue: readonly })).toThrow(/bindValue requires writable signal/);
    expect(() => createSignalAwareElement("input", { type: "radio", bindChecked: signal(false) })).toThrow(/checkbox/);
  });

  it("rejects binding and React prop ownership conflicts and select payload mismatches", () => {
    const text = signal("a");
    const checked = signal(true);
    const list = signal<string[]>(["a"]);
    expect(() => createSignalAwareElement("input", { bindValue: text, value: "a" })).toThrow(/bindValue cannot be combined/);
    expect(() => createSignalAwareElement("textarea", { bindValue: text, defaultValue: "a" })).toThrow(/bindValue cannot be combined/);
    expect(() => createSignalAwareElement("select", { bindValue: text, defaultValue: "a" })).toThrow(/bindValue cannot be combined/);
    expect(() => createSignalAwareElement("input", { type: "checkbox", bindChecked: checked, checked: true })).toThrow(/bindChecked cannot be combined/);
    expect(() => createSignalAwareElement("input", { type: "checkbox", bindChecked: checked, defaultChecked: true })).toThrow(/bindChecked cannot be combined/);
    expect(() => createSignalAwareElement("select", { multiple: true, bindValue: text })).toThrow(/Invalid select bindValue/);
    expect(() => createSignalAwareElement("select", { bindValue: list })).toThrow(/Invalid select bindValue/);
  });

  it("does not let an unrelated re-render move the caret on a direct-bound value", () => {
    const text = signal("abc");
    const bump = signal(0);

    function Field() {
      useSignalTracking();
      void bump.value;
      return <input aria-label="field" bindValue={text} onChange={(event) => { text.value = event.target.value; }} />;
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

    act(() => { text.value = "uvwxyz"; });
    expect(input.value).toBe("uvwxyz");
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(4);
    expect(input.selectionDirection).toBe("backward");
  });

  it("defers a forced value write until an in-progress IME composition ends", () => {
    const text = signal("abc");

    function Field() {
      return <input aria-label="ime field" bindValue={text} onChange={(event) => { text.value = event.target.value; }} />;
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

  it("resets bound inputs and checkboxes to the latest value written to their signals", () => {
    const text = signal("initial text");
    const checked = signal(false);

    function Form() {
      return (
        <form aria-label="bound reset form">
          <input aria-label="reset text" bindValue={text} onChange={(event) => { text.value = event.target.value; }} />
          <input type="checkbox" aria-label="reset checkbox" bindChecked={checked} onChange={(event) => { checked.value = event.target.checked; }} />
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

    act(() => { form.reset(); });
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
          <input aria-label="accepted edit reset text" bindValue={text} onChange={(event) => { text.value = event.target.value; }} />
          <input type="checkbox" aria-label="accepted edit reset checkbox" bindChecked={checked} onChange={(event) => { checked.value = event.target.checked; }} />
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
        <select aria-label="choice" value={choice.value} onChange={(event) => { choice.value = event.target.value; }}>
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
      return <select aria-label="bound choice" bindValue={choice} onChange={changes}>
        <option value="a">A</option>
        <option value="b">B</option>
        <option value="c">C</option>
      </select>;
    }

    render(<Field />);
    const select = screen.getByLabelText("bound choice") as HTMLSelectElement;
    expect(select.value).toBe("b");
    const firstRenderCount = renders.mock.calls.length;

    act(() => { choice.value = "a"; });
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
    render(<select aria-label="bound choices" multiple bindValue={choices} onChange={changes}>
      <option value="a">A</option>
      <option value="b">B</option>
      <option value="c">C</option>
    </select>);
    const select = screen.getByLabelText("bound choices") as HTMLSelectElement;
    const selected = () => Array.from(select.selectedOptions, (option) => option.value);
    expect(selected()).toEqual(["a", "c"]);

    act(() => { choices.value = ["b"]; });
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
      return <select aria-label="replaceable select" bindValue={useSecond.value ? second : first}>
        <option value="a">A</option><option value="b">B</option>
      </select>;
    }
    const view = render(<Field />);
    const select = screen.getByLabelText("replaceable select") as HTMLSelectElement;
    expect(select.value).toBe("a");
    expect(observe).toHaveBeenCalledTimes(1);

    act(() => { useSecond.value = true; });
    expect(select.value).toBe("b");
    expect(observe).toHaveBeenCalledTimes(2);
    act(() => { first.value = "a"; });
    expect(select.value).toBe("b");
    act(() => { second.value = "a"; });
    expect(select.value).toBe("a");

    view.unmount();
    await act(async () => { await Promise.resolve(); });
    expect(disconnect).toHaveBeenCalledTimes(2);
    act(() => { second.value = "b"; });
    expect(select.value).toBe("a");
  });

  it("resynchronizes single and multiple bound selects when options are inserted or removed", async () => {
    const choice = signal("late");
    const choices = signal<string[]>(["a", "late"]);
    const showLate = signal(false);
    function Field() {
      useSignalTracking();
      return <>
        <select aria-label="dynamic single" bindValue={choice}>
          <option value="a">A</option>
          {showLate.value ? <option value="late">Late</option> : null}
        </select>
        <select aria-label="dynamic multiple" multiple bindValue={choices}>
          <option value="a">A</option>
          {showLate.value ? <option value="late">Late</option> : null}
        </select>
      </>;
    }
    render(<Field />);
    const single = screen.getByLabelText("dynamic single") as HTMLSelectElement;
    const multiple = screen.getByLabelText("dynamic multiple") as HTMLSelectElement;
    expect(single.value).toBe("");
    expect(Array.from(multiple.selectedOptions, (option) => option.value)).toEqual(["a"]);

    act(() => { showLate.value = true; });
    await waitFor(() => {
      expect(single.value).toBe("late");
      expect(Array.from(multiple.selectedOptions, (option) => option.value)).toEqual(["a", "late"]);
    });
    act(() => { showLate.value = false; });
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
      return <form aria-label="bound select reset" onReset={(event) => {
        if (event.currentTarget.dataset.cancel === "true") event.preventDefault();
      }}>
        <select aria-label="reset bound single" bindValue={choice}>
          <option value="a">A</option><option value="b">B</option>
          {includeLateOption.value ? <option value="late">Late</option> : null}
        </select>
        <select aria-label="reset bound multiple" multiple bindValue={choices}>
          <option value="a">A</option><option value="b">B</option>
          {includeLateOption.value ? <option value="late">Late</option> : null}
        </select>
      </form>;
    }
    render(<Form />);
    const form = screen.getByLabelText("bound select reset") as HTMLFormElement;
    const single = screen.getByLabelText("reset bound single") as HTMLSelectElement;
    const multiple = screen.getByLabelText("reset bound multiple") as HTMLSelectElement;
    act(() => { choice.value = "b"; choices.value = ["b"]; });
    await act(async () => { form.reset(); await Promise.resolve(); });
    expect(choice.value).toBe("b");
    expect(single.value).toBe("b");
    expect(choices.value).toEqual(["b"]);
    expect(Array.from(multiple.selectedOptions, (option) => option.value)).toEqual(["b"]);

    form.dataset.cancel = "true";
    act(() => { single.value = "a"; multiple.options[0]!.selected = true; });
    await act(async () => { fireEvent.reset(form); await Promise.resolve(); });
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
    await act(async () => { form.reset(); await Promise.resolve(); });
    expect(single.value).toBe("late");
    expect(Array.from(multiple.selectedOptions, (option) => option.value)).toEqual(["late"]);
  });

  it("keeps a React-controlled select in sync when a matching <option> is added later", async () => {
    const choice = signal("c");
    const showOptionC = signal(false);

    function Field() {
      useSignalTracking();
      return (
        <select aria-label="late choice" value={choice.value} onChange={(event) => { choice.value = event.target.value; }}>
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
          <select aria-label="reset choice" value={choice.value} onChange={(event) => { choice.value = event.target.value; }}>
            <option value="a">A</option>
            <option value="b">B</option>
            <option value="c">C</option>
          </select>
          <select aria-label="reset choices" multiple value={choices.value} onChange={(event) => {
            choices.value = Array.from(event.target.selectedOptions, (option) => option.value);
          }}>
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

    act(() => { form.reset(); });
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
            onChange={() => { selected.value = "a"; }}
          />
          <input
            type="radio"
            name="choice"
            aria-label="option b"
            checked={isB.value}
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
      useSignalTracking();
      void bump.value;
      return (
        <StrictMode>
          <input aria-label="strict field" bindValue={text} onChange={(event) => { text.value = event.target.value; }} />
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
      return <input aria-label="listener field" bindValue={text} onChange={(event) => { text.value = event.target.value; }} />;
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
      return <input aria-label="ime churn field" bindValue={text} onChange={(event) => { text.value = event.target.value; }} />;
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
      return (
        <input
          aria-label="mixed field"
          bindValue={text}
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
});
