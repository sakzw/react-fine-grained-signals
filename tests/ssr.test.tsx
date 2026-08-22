/** @jsxImportSource react-alien-signals */
// @vitest-environment jsdom

import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  signal,
  useComputed,
  useDeepSignal,
  useSignalValue,
  type DeepSignal,
} from "../src/index.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SSR and hydration", () => {
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
      const name = useSignalValue(useComputed(() => state.value.user.name));
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
