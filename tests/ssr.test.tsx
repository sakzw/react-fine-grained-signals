/** @jsxImportSource react-alien-signals */
// @vitest-environment jsdom

import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  signal,
  computed,
  deepSignal,
  useComputed,
  useDeepSignal,
  useDeepSignalValue,
  useSignalValue,
  useSignals,
  type DeepSignal,
} from "../src/index.js";
import { For, Index, Show } from "react-alien-signals/utils";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SSR and hydration", () => {
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

  it("keeps useSignals render tracking server-inert, deterministic, and live after hydration", async () => {
    const source = signal("server");
    const state = deepSignal({ profile: { name: "Ada", unread: 0 } });
    const derivedRuns = vi.fn(() => source.value.toUpperCase());
    const derived = computed(derivedRuns);

    function App() {
      useSignals();
      return <span data-testid="tracked-ssr-value">{
        `${derived.value}:${state.value.profile.name}`
      }</span>;
    }

    const firstHtml = renderToString(<App />);
    const secondHtml = renderToString(<App />);
    expect(firstHtml).toBe(secondHtml);
    expect(firstHtml).toContain("SERVER:Ada");

    // A server render must not leave an effect/subscription that evaluates this
    // computed after the request has completed.
    expect(derivedRuns).toHaveBeenCalledTimes(1);
    source.value = "changed without a client";
    expect(derivedRuns).toHaveBeenCalledTimes(1);
    source.value = "server";
    expect(derivedRuns).toHaveBeenCalledTimes(1);

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
});
