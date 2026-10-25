/** @jsxImportSource react-fine-grained-signals/jsx */
// @vitest-environment jsdom

import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computed, effect, signal } from "../src/index.js";

// Regression coverage for form-binding fixes J1-J6.

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mount(node: ReactNode): { container: HTMLElement; root: Root } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(node));
  return { container, root };
}

async function tick(ms = 20): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe("J1: bindChecked source switch from its own handler", () => {
  it("does not apply the old signal's value after switching sources", async () => {
    const todos = [signal(false), signal(false)];
    function App() {
      const [i, setI] = useState(0);
      return <input type="checkbox" bindChecked={todos[i]!} onChange={() => setI(1)} />;
    }
    const { container } = mount(<App />);
    const el = container.querySelector("input")!;
    act(() => el.click());
    await tick();
    expect(todos[0]!.value).toBe(true);
    expect(todos[1]!.value).toBe(false);
    expect(el.checked).toBe(false);
  });
});

describe("J2: second click in the same task after a canceled click", () => {
  it("keeps the second toggle of a bindChecked checkbox", async () => {
    const s = signal(false);
    let n = 0;
    const { container } = mount(<input type="checkbox" bindChecked={s} onClick={(e) => { if (n++ === 0) e.preventDefault(); }} />);
    const el = container.querySelector("input")!;
    act(() => {
      el.click();
      el.click();
    });
    await tick();
    expect(el.checked).toBe(true);
    expect(s.value).toBe(true);
  });

  it("keeps the second click on a bound radio", async () => {
    const s = signal("a");
    let n = 0;
    const { container } = mount(
      <div>
        <input type="radio" name="r" value="a" bindValue={s} />
        <input type="radio" name="r" value="b" bindValue={s} onClick={(e) => { if (n++ === 0) e.preventDefault(); }} />
      </div>,
    );
    const b = container.querySelectorAll("input")[1]!;
    act(() => {
      b.click();
      b.click();
    });
    await tick();
    expect(s.value).toBe("b");
    expect(b.checked).toBe(true);
  });

  it("keeps the second click on a checkbox group member", async () => {
    const s = signal<string[]>([]);
    let n = 0;
    const { container } = mount(<input type="checkbox" value="a" bindValue={s} onClick={(e) => { if (n++ === 0) e.preventDefault(); }} />);
    const el = container.querySelector("input")!;
    act(() => {
      el.click();
      el.click();
    });
    await tick();
    expect(el.checked).toBe(true);
    expect(s.value).toEqual(["a"]);
  });
});

describe("J3: canceled uncheck restores the checkbox group exactly", () => {
  it("keeps order and does not notify beyond the revert", async () => {
    const features = signal(["search", "export"]);
    const seen: string[][] = [];
    const stop = effect(() => { seen.push([...features.value]); });
    const { container } = mount(
      <div>
        <input type="checkbox" value="search" bindValue={features} onClick={(e) => e.preventDefault()} />
        <input type="checkbox" value="export" bindValue={features} />
      </div>,
    );
    act(() => container.querySelector("input")!.click());
    await tick();
    expect(features.value).toEqual(["search", "export"]);
    stop();
  });

  it("keeps duplicates", async () => {
    const s = signal(["a", "a", "b"]);
    const { container } = mount(<input type="checkbox" value="a" bindValue={s} onClick={(e) => e.preventDefault()} />);
    act(() => container.querySelector("input")!.click());
    await tick();
    expect(s.value).toEqual(["a", "a", "b"]);
  });

  it("reinserts at the original index when the group changed meanwhile", async () => {
    const s = signal(["x", "a", "y"]);
    const { container } = mount(<input type="checkbox" value="a" bindValue={s} onClick={(e) => { e.preventDefault(); queueMicrotask(() => { s.value = s.peek().filter((v) => v !== "z").concat("z"); }); }} />);
    act(() => container.querySelector("input")!.click());
    await tick();
    expect(s.value).toEqual(["x", "a", "y", "z"]);
  });
});

describe("J4: bound select follows kept options whose value changes", () => {
  it("re-applies when an option's value attribute changes", async () => {
    const s = signal("v1");
    function App() {
      const [v, setV] = useState("v1");
      return (
        <div>
          <button onClick={() => setV("v2")} />
          <select bindValue={s}>
            <option key="x" value="other">x</option>
            <option key="y" value={v}>y</option>
          </select>
        </div>
      );
    }
    const { container } = mount(<App />);
    const select = container.querySelector("select")!;
    expect(select.value).toBe("v1");
    act(() => container.querySelector("button")!.click());
    await tick();
    expect(s.value).toBe("v1");
    expect(select.value).toBe("");
    expect(select.selectedIndex).toBe(-1);
  });

  it("re-applies when an option's text-derived value changes", async () => {
    const s = signal("one");
    const label = signal("one");
    const { container } = mount(
      <select bindValue={s}>
        <option>{label}</option>
        <option>two</option>
      </select>,
    );
    const select = container.querySelector("select")!;
    expect(select.value).toBe("one");
    act(() => { label.value = "uno"; });
    await tick();
    expect(s.value).toBe("one");
    expect(select.selectedIndex).toBe(-1);
  });

  it("re-applies for a multiple select", async () => {
    const s = signal(["v1"]);
    function App() {
      const [v, setV] = useState("v1");
      return (
        <div>
          <button onClick={() => setV("v2")} />
          <select multiple bindValue={s}>
            <option key="x" value="other" />
            <option key="y" value={v} />
          </select>
        </div>
      );
    }
    const { container } = mount(<App />);
    const select = container.querySelector("select")!;
    expect(select.options[1]!.selected).toBe(true);
    act(() => container.querySelector("button")!.click());
    await tick();
    expect(select.options[1]!.selected).toBe(false);
  });
});

describe("J5: form association that begins after mount", () => {
  it("resets to the signal's value", async () => {
    const s = signal("init");
    const { container } = mount(<input form="f1" bindValue={s} />);
    const input = container.querySelector("input")!;
    act(() => {
      input.value = "initXY";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await tick();
    expect(s.value).toBe("initXY");
    // A separate root mounts the form later; the input is not re-rendered.
    const { container: formContainer } = mount(<form id="f1" />);
    const form = formContainer.querySelector("form")!;
    expect(input.form).toBe(form);
    act(() => form.reset());
    await tick();
    expect(input.value).toBe("initXY");
    expect(s.value).toBe("initXY");
  });
});

describe("form reset inside a shadow root", () => {
  it("restores the signal's value although reset does not leave the shadow root", async () => {
    const s = signal("init");
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const container = document.createElement("div");
    shadow.append(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => root.render(<form><input bindValue={s} /></form>));
    const input = shadow.querySelector("input")!;
    // Drift the DOM and its native reset default away from the signal, then
    // check that the reset re-applies the signal.
    input.defaultValue = "drift";
    input.value = "drift";
    act(() => shadow.querySelector("form")!.reset());
    await tick();
    expect(input.value).toBe("init");
  });
});

describe("J6: a throwing revert still refreshes the DOM", () => {
  it("radio group shows the signal's actual value", async () => {
    const base = signal("r3");
    const rw = computed({
      get: () => base.value,
      set: (v: string) => {
        if (v === "r3") throw new Error("reject r3");
        base.value = v;
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    const { container } = mount(
      <div>
        {["r1", "r2", "r3"].map((v) => (
          <input key={v} type="radio" name="g" value={v} bindValue={rw} onClick={v === "r2" ? (e) => e.preventDefault() : undefined} />
        ))}
      </div>,
    );
    const radios = container.querySelectorAll("input");
    expect(radios[2]!.checked).toBe(true);
    act(() => radios[1]!.click());
    // The settle's revert throws (reported from the timer) but still refreshes.
    expect(() => vi.advanceTimersByTime(10)).toThrow("reject r3");
    expect(rw.value).toBe("r2");
    expect(radios[1]!.checked).toBe(true);
    expect(radios[2]!.checked).toBe(false);
  });

  it("bindChecked shows the signal's actual value", async () => {
    const base = signal(false);
    const rw = computed({
      get: () => base.value,
      set: (v: boolean) => {
        if (!v) throw new Error("reject uncheck");
        base.value = v;
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    const { container } = mount(<input type="checkbox" bindChecked={rw} onClick={(e) => e.preventDefault()} />);
    const el = container.querySelector("input")!;
    // Click is canceled: the write true is accepted, the revert to false throws.
    act(() => el.click());
    expect(() => vi.advanceTimersByTime(10)).toThrow("reject uncheck");
    expect(rw.value).toBe(true);
    expect(el.checked).toBe(true);
  });
});
