/** @jsxImportSource react-fine-grained-signals */
// @vitest-environment jsdom

import { act, Suspense } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToPipeableStream, renderToString } from "react-dom/server";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  signal,
  computed,
  deepSignal,
  useDeepSignal,
  useDeepSignalValue,
  useSignalTracking,
  type DeepSignal,
} from "../src/index.js";
import { For, Index, Show } from "react-fine-grained-signals/utils";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SSR and hydration", () => {
  it("hydrates single and multiple explicit select bindings with their initial values", async () => {
    const singleValue = signal("b");
    const multipleValues = signal<string[]>(["a", "c"]);
    function App() {
      return <>
        <select aria-label="hydrated single" bindValue={singleValue}>
          <option value="a">A</option><option value="b">B</option>
        </select>
        <select aria-label="hydrated multiple" multiple bindValue={multipleValues}>
          <option value="a">A</option><option value="b">B</option><option value="c">C</option>
        </select>
      </>;
    }

    const html = renderToString(<App />);
    expect(html).toContain('selected=""');
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = hydrateRoot(container, <App />);
    await act(async () => { await Promise.resolve(); });

    const single = container.querySelector('[aria-label="hydrated single"]') as HTMLSelectElement;
    const multiple = container.querySelector('[aria-label="hydrated multiple"]') as HTMLSelectElement;
    expect(single.value).toBe("b");
    expect(Array.from(multiple.selectedOptions, (option) => option.value)).toEqual(["a", "c"]);
    await act(async () => { multiple.options[1]!.selected = true; multiple.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(multipleValues.value).toEqual(["a", "b", "c"]);
    expect(consoleError).not.toHaveBeenCalled();

    root.unmount();
    container.remove();
    consoleError.mockRestore();
  });

  it("hydrates control-flow utilities and follows signal updates without warnings", async () => {
    const visible = signal(true);
    const items = deepSignal([{ id: "ada", name: "Ada" }]);
    const slots = signal(["first"]);
    const labels = signal(new Map([["ada", "Ada"]]));

    function App() {
      return (
        <section>
          <Show when={visible} fallback={<p data-testid="visibility">hidden</p>}>
            <p data-testid="visibility">visible</p>
          </Show>
          <ul>
            <For each={items} by={(item) => item.id} fallback={<li>empty</li>}>
              {(item) => <li>{item.name}</li>}
            </For>
          </ul>
          <ul data-testid="slots">
            <Index each={slots}>{(item) => <li>{item()}</li>}</Index>
          </ul>
          <ul data-testid="labels">
            <For each={labels} by={([id]) => id}>
              {([id, label]) => <li>{`${id}:${label}`}</li>}
            </For>
          </ul>
        </section>
      );
    }

    const html = renderToString(<App />);
    expect(html).toContain("visible");
    expect(html).toContain("Ada");

    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = hydrateRoot(container, <App />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector("[data-testid=visibility]")?.textContent).toBe("visible");
    expect(container.querySelector("li")?.textContent).toBe("Ada");
    expect(container.querySelector("[data-testid=slots]")?.textContent).toBe("first");
    expect(container.querySelector("[data-testid=labels]")?.textContent).toBe("ada:Ada");
    expect(consoleError).not.toHaveBeenCalled();

    await act(async () => {
      visible.value = false;
      items.value.push({ id: "bea", name: "Bea" });
      slots.value = ["second"];
      labels.value = new Map([["bea", "Bea"]]);
    });
    expect(container.querySelector("[data-testid=visibility]")?.textContent).toBe("hidden");
    expect([...container.querySelectorAll("li")].map((item) => item.textContent))
      .toEqual(["Ada", "Bea", "second", "bea:Bea"]);
    expect(consoleError).not.toHaveBeenCalled();

    root.unmount();
    container.remove();
    consoleError.mockRestore();
  });

  it("keeps useSignalTracking render tracking server-inert, deterministic, and live after hydration", async () => {
    const source = signal("server");
    const state = deepSignal({ profile: { name: "Ada", unread: 0 } });
    const derivedRuns = vi.fn(() => source.value.toUpperCase());
    const derived = computed(derivedRuns);

    function App() {
      useSignalTracking();
      return <span data-testid="tracked-ssr-value">{
        `${derived.value}:${state.value.profile.name}`
      }</span>;
    }

    const firstHtml = renderToString(<App />);
    const secondHtml = renderToString(<App />);
    expect(firstHtml).toBe(secondHtml);
    expect(firstHtml).toContain("SERVER:Ada");

    // Each server render uses an isolated speculative attempt that is never
    // promoted into the shared graph cache. Re-evaluation keeps requests
    // detached from one another; neither attempt leaves a subscription behind.
    expect(derivedRuns).toHaveBeenCalledTimes(2);
    source.value = "changed without a client";
    expect(derivedRuns).toHaveBeenCalledTimes(2);
    source.value = "server";
    expect(derivedRuns).toHaveBeenCalledTimes(2);

    const container = document.createElement("div");
    container.innerHTML = firstHtml;
    document.body.appendChild(container);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = hydrateRoot(container, <App />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector("[data-testid=tracked-ssr-value]")?.textContent).toBe("SERVER:Ada");
    expect(consoleError).not.toHaveBeenCalled();

    await act(async () => {
      source.value = "client";
      state.value.profile.name = "Grace";
    });
    expect(container.querySelector("[data-testid=tracked-ssr-value]")?.textContent).toBe("CLIENT:Grace");
    expect(consoleError).not.toHaveBeenCalled();

    root.unmount();
    container.remove();
    consoleError.mockRestore();
  });

  it("hydrates renderToString output and follows updates without warnings", async () => {
    const source = signal("server value");
    const title = signal("server title");

    function App() {
      return <span data-testid="value" title={title}>{source}</span>;
    }

    const html = renderToString(<App />);
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = hydrateRoot(container, <App />);

    await act(async () => {
      await Promise.resolve();
    });
    const valueNode = container.querySelector("[data-testid=value]") as HTMLSpanElement;
    expect(valueNode.textContent).toBe("server value");
    expect(valueNode.title).toBe("server title");
    expect(consoleError).not.toHaveBeenCalled();

    await act(async () => {
      source.value = "client update";
      title.value = "client title";
    });
    expect(valueNode.textContent).toBe("client update");
    expect(valueNode.title).toBe("client title");
    expect(consoleError).not.toHaveBeenCalled();

    root.unmount();
    container.remove();
    consoleError.mockRestore();
  });

  it("hydrates a direct-bound multiple select and follows selected-option updates", async () => {
    const selected = signal(["b", "c"]);

    function App() {
      useSignalTracking();
      return (
        <select data-testid="multi-select" multiple value={selected.value} onChange={(event) => {
          selected.value = Array.from(event.target.selectedOptions, (option) => option.value);
        }}>
          <option value="a">A</option>
          <option value="b">B</option>
          <option value="c">C</option>
        </select>
      );
    }

    const html = renderToString(<App />);
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = hydrateRoot(container, <App />);

    await act(async () => { await Promise.resolve(); });
    const select = container.querySelector("[data-testid=multi-select]") as HTMLSelectElement;
    const selectedValues = () => Array.from(select.selectedOptions, (option) => option.value);
    expect(selectedValues()).toEqual(["b", "c"]);
    expect(consoleError).not.toHaveBeenCalled();

    await act(async () => { selected.value = ["a"]; });
    expect(selectedValues()).toEqual(["a"]);
    expect(consoleError).not.toHaveBeenCalled();

    root.unmount();
    container.remove();
    consoleError.mockRestore();
  });

  it("hydrates a direct-bound single select and follows value updates", async () => {
    const selected = signal("b");

    function App() {
      useSignalTracking();
      return (
        <select data-testid="single-select" value={selected.value} onChange={(event) => {
          selected.value = event.target.value;
        }}>
          <option value="a">A</option>
          <option value="b">B</option>
          <option value="c">C</option>
        </select>
      );
    }

    const html = renderToString(<App />);
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = hydrateRoot(container, <App />);

    await act(async () => { await Promise.resolve(); });
    const select = container.querySelector("[data-testid=single-select]") as HTMLSelectElement;
    expect(select.value).toBe("b");
    expect(consoleError).not.toHaveBeenCalled();

    await act(async () => { selected.value = "c"; });
    expect(select.value).toBe("c");
    expect(consoleError).not.toHaveBeenCalled();

    root.unmount();
    container.remove();
    consoleError.mockRestore();
  });

  it("resyncs a hydrated single select when its matching option is added later", async () => {
    const selected = signal("c");
    const showOptionC = signal(false);

    function App() {
      useSignalTracking();
      return (
        <select data-testid="late-single-select" value={selected.value} onChange={(event) => {
          selected.value = event.target.value;
        }}>
          <option value="a">A</option>
          <option value="b">B</option>
          {showOptionC.value ? <option value="c">C</option> : null}
        </select>
      );
    }

    const html = renderToString(<App />);
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = hydrateRoot(container, <App />);

    await act(async () => { await Promise.resolve(); });
    const select = container.querySelector("[data-testid=late-single-select]") as HTMLSelectElement;
    expect(select.value).toBe("a");
    expect(consoleError).not.toHaveBeenCalled();

    await act(async () => { showOptionC.value = true; });
    expect(select.value).toBe("c");
    expect(selected.value).toBe("c");
    expect(consoleError).not.toHaveBeenCalled();

    root.unmount();
    container.remove();
    consoleError.mockRestore();
  });

  it("hydrates a direct-bound input value without warnings and survives an unrelated update", async () => {
    const text = signal("server value");
    const bump = signal(0);

    function App() {
      useSignalTracking();
      void bump.value;
      return (
        <input
          data-testid="field"
          bindValue={text}
          onChange={(event) => { text.value = event.target.value; }}
        />
      );
    }

    const html = renderToString(<App />);
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = hydrateRoot(container, <App />);

    await act(async () => {
      await Promise.resolve();
    });
    const fieldNode = container.querySelector("[data-testid=field]") as HTMLInputElement;
    expect(fieldNode.value).toBe("server value");
    expect(consoleError).not.toHaveBeenCalled();

    await act(async () => {
      text.value = "client value";
    });
    expect(fieldNode.value).toBe("client value");
    expect(consoleError).not.toHaveBeenCalled();

    // An unrelated re-render must not touch the DOM-owned value at all.
    await act(async () => {
      bump.value++;
    });
    expect(fieldNode.value).toBe("client value");
    expect(consoleError).not.toHaveBeenCalled();

    root.unmount();
    container.remove();
    consoleError.mockRestore();
  });

  it("hydrates a direct-bound checkbox checked state without warnings", async () => {
    const checked = signal(true);

    function App() {
      return (
        <input
          type="checkbox"
          data-testid="agree"
          bindChecked={checked}
          onChange={(event) => { checked.value = event.target.checked; }}
        />
      );
    }

    const html = renderToString(<App />);
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = hydrateRoot(container, <App />);

    await act(async () => {
      await Promise.resolve();
    });
    const checkboxNode = container.querySelector("[data-testid=agree]") as HTMLInputElement;
    expect(checkboxNode.checked).toBe(true);
    expect(consoleError).not.toHaveBeenCalled();

    await act(async () => {
      checked.value = false;
    });
    expect(checkboxNode.checked).toBe(false);
    expect(consoleError).not.toHaveBeenCalled();

    root.unmount();
    container.remove();
    consoleError.mockRestore();
  });

  it("hydrates a direct-bound style prop and follows updates without warnings", async () => {
    const style = signal<Record<string, string | number>>({ color: "red" });

    function App() {
      return <span data-testid="styled" style={style}>content</span>;
    }

    const html = renderToString(<App />);
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = hydrateRoot(container, <App />);

    await act(async () => {
      await Promise.resolve();
    });
    const styledNode = container.querySelector("[data-testid=styled]") as HTMLSpanElement;
    expect(styledNode.style.color).toBe("red");
    expect(consoleError).not.toHaveBeenCalled();

    await act(async () => {
      style.value = { background: "blue" };
    });
    expect(styledNode.style.color).toBe("");
    expect(styledNode.style.background).toBe("blue");
    expect(consoleError).not.toHaveBeenCalled();

    root.unmount();
    container.remove();
    consoleError.mockRestore();
  });

  it("hydrates style objects with per-property signal entries", async () => {
    const color = signal("purple");
    const opacity = signal(0.5);

    function App() {
      return <span data-testid="property-styled" style={{ color, opacity, width: 12 }}>content</span>;
    }

    const html = renderToString(<App />);
    expect(html).toContain("color:purple");
    expect(html).toContain("opacity:0.5");
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = hydrateRoot(container, <App />);

    await act(async () => { await Promise.resolve(); });
    const styledNode = container.querySelector("[data-testid=property-styled]") as HTMLSpanElement;
    expect(styledNode.style.color).toBe("purple");
    expect(styledNode.style.opacity).toBe("0.5");

    await act(async () => {
      color.value = "teal";
      opacity.value = 0.75;
    });
    expect(styledNode.style.color).toBe("teal");
    expect(styledNode.style.opacity).toBe("0.75");
    expect(consoleError).not.toHaveBeenCalled();

    root.unmount();
    container.remove();
    consoleError.mockRestore();
  });

  it("creates request-local deep state and hydrates a selected value", async () => {
    let clientState: DeepSignal<{ user: { name: string } }> | undefined;

    function App() {
      const state = useDeepSignal(() => ({ user: { name: "Ada" } }));
      const name = useDeepSignalValue(state, (value) => value.user.name, []);
      clientState = state;
      return <span data-testid="deep-value">{name}</span>;
    }

    const html = renderToString(<App />);
    const serverState = clientState;
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = hydrateRoot(container, <App />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(clientState).not.toBe(serverState);
    expect(container.querySelector("[data-testid=deep-value]")?.textContent).toBe("Ada");
    expect(consoleError).not.toHaveBeenCalled();

    await act(async () => {
      clientState!.value.user.name = "Grace";
    });
    expect(container.querySelector("[data-testid=deep-value]")?.textContent).toBe("Grace");
    expect(consoleError).not.toHaveBeenCalled();

    root.unmount();
    container.remove();
    consoleError.mockRestore();
  });

  it("streams a suspended signal read via renderToPipeableStream without tearing or a stale value", async () => {
    const value = signal("initial");
    const reads: string[] = [];
    let releaseSuspense: () => void;
    const suspensePromise = new Promise<void>((resolve) => { releaseSuspense = resolve; });
    let attempts = 0;

    function Slow() {
      useSignalTracking();
      attempts += 1;
      // The first render pass suspends before reading the signal at all, so
      // the fallback below is the only thing the shell can legitimately emit.
      if (attempts === 1) throw suspensePromise;
      const current = value.value;
      reads.push(current);
      return <span data-testid="slow">{current}</span>;
    }

    function App() {
      return (
        <section>
          <Suspense fallback={<span data-testid="slow">loading</span>}>
            <Slow />
          </Suspense>
        </section>
      );
    }

    const chunks: string[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const html = await new Promise<string>((resolvePromise, reject) => {
      const writable = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(chunk.toString());
          callback();
        },
      });
      writable.on("finish", () => resolvePromise(chunks.join("")));
      writable.on("error", reject);

      const { pipe } = renderToPipeableStream(<App />, {
        onShellReady() {
          // Streams the shell (with the Suspense fallback) immediately, then
          // -- only after that's committed to the pipe -- resolves the
          // suspended boundary with a value that did not exist yet when the
          // component first rendered. The deferred segment must reflect this
          // value, not whatever `value` held at the moment `Slow` suspended.
          pipe(writable);
          value.value = "streamed";
          releaseSuspense();
        },
        onError: reject,
      });
    });

    expect(attempts).toBe(2);
    expect(reads).toEqual(["streamed"]);
    expect(html).toContain("loading");
    expect(html).toContain("streamed");
    expect(html).not.toContain("initial");
    expect(consoleError).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });
});
