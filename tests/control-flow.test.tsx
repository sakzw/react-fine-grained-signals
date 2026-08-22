// @vitest-environment jsdom

import { act, Fragment, StrictMode, useState } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deepSignal, signal } from "../src/index.js";
import { For, Match, Show, Switch } from "react-alien-signals/utils";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

describe("JSX control flow utilities", () => {
  it("updates Show locally and renders its fallback", () => {
    const visible = signal(false);
    const parentRenders = vi.fn();

    function Parent() {
      parentRenders();
      return (
        <Show when={visible} fallback={<p>hidden</p>}>
          {(value) => <p>shown:{String(value)}</p>}
        </Show>
      );
    }

    render(<Parent />);
    expect(screen.getByText("hidden")).toBeTruthy();
    expect(parentRenders).toHaveBeenCalledTimes(1);

    act(() => {
      visible.value = true;
    });
    expect(screen.getByText("shown:true")).toBeTruthy();
    expect(parentRenders).toHaveBeenCalledTimes(1);

    act(() => {
      visible.value = false;
    });
    expect(screen.getByText("hidden")).toBeTruthy();
  });

  it("keeps utility subscriptions live through Strict Mode replay", () => {
    const visible = signal(false);
    const items = signal(["Ada"]);

    const view = render(
      <StrictMode>
        <Show when={visible} fallback={<p data-testid="strict-visible">hidden</p>}>
          <p data-testid="strict-visible">visible</p>
        </Show>
        <ul>
          <For each={items} fallback={<li>empty</li>}>
            {(item) => <li>{item}</li>}
          </For>
        </ul>
      </StrictMode>,
    );

    act(() => {
      visible.value = true;
      items.value = ["Ada", "Bea"];
    });
    expect(screen.getByTestId("strict-visible").textContent).toBe("visible");
    expect(view.container.querySelectorAll("li")).toHaveLength(2);

    view.unmount();
    act(() => {
      visible.value = false;
      items.value = [];
    });
  });

  it("uses the first truthy Match and supports fragments", () => {
    const primary = signal(false);
    const secondary = signal(false);

    render(
      <Switch fallback={<p>fallback</p>}>
        <Match when={primary}><p>primary</p></Match>
        <Fragment>
          <Match when={secondary}>{(value) => <p>secondary:{String(value)}</p>}</Match>
        </Fragment>
        <Match when={false}><p>later branch</p></Match>
      </Switch>,
    );

    expect(screen.getByText("fallback")).toBeTruthy();
    expect(screen.queryByText("later branch")).toBeNull();

    act(() => {
      secondary.value = true;
    });
    expect(screen.getByText("secondary:true")).toBeTruthy();

    act(() => {
      primary.value = true;
    });
    expect(screen.getByText("primary")).toBeTruthy();
    expect(screen.queryByText("secondary:true")).toBeNull();

    act(() => {
      primary.value = false;
      secondary.value = false;
    });
    expect(screen.getByText("fallback")).toBeTruthy();
  });

  it("renders a deep-signal array, its fallback, and keyed reorders", () => {
    const items = deepSignal([
      { id: "a", label: "Ada" },
      { id: "b", label: "Bea" },
      { id: "c", label: "Cy" },
    ]);

    function Row({ item }: { item: { id: string; label: string } }) {
      const [mountedFor] = useState(item.id);
      return <li data-testid={item.id}>{`${mountedFor}:${item.label}`}</li>;
    }

    const view = render(
      <ul>
        <For each={items} by={(item) => item.id} fallback={<li>empty</li>}>
          {(item) => <Row item={item} />}
        </For>
      </ul>,
    );
    const list = view.container.querySelector("ul")!;
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["a:Ada", "b:Bea", "c:Cy"]);

    act(() => {
      items.value = [items.value[2]!, items.value[0]!, items.value[1]!];
    });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["c:Cy", "a:Ada", "b:Bea"]);

    act(() => {
      items.value[0]!.label = "Cyra";
    });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["c:Cyra", "a:Ada", "b:Bea"]);

    act(() => {
      items.value = [];
    });
    expect(within(list).getByText("empty")).toBeTruthy();
  });
});
