// @vitest-environment jsdom

import { act, Fragment, StrictMode, useState } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deepSignal, signal, useSignals } from "../src/index.js";
import { For, Index, Match, Show, Switch } from "react-alien-signals/utils";

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
          <For each={items} by={(item) => item} fallback={<li>empty</li>}>
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

    const keyCalls = vi.fn((item: { id: string }) => item.id);

    function Row({ item }: { item: { id: string; label: string } }) {
      useSignals();
      const [mountedFor] = useState(item.id);
      return <li data-testid={item.id}>{`${mountedFor}:${item.label}`}</li>;
    }

    const view = render(
      <ul>
        <For each={items} by={keyCalls} fallback={<li>empty</li>}>
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
    const callsBeforeLeafUpdate = keyCalls.mock.calls.length;

    act(() => {
      items.value[0]!.label = "Cyra";
    });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["c:Cyra", "a:Ada", "b:Bea"]);
    expect(keyCalls).toHaveBeenCalledTimes(callsBeforeLeafUpdate);

    act(() => {
      items.value = [];
    });
    expect(within(list).getByText("empty")).toBeTruthy();
  });

  it("renders For's fallback for a null or undefined collection", () => {
    const items = signal<string[] | null | undefined>(["Ada"]);

    render(
      <ul>
        <For each={items} by={(item) => item} fallback={<li>empty</li>}>{(item) => <li>{item}</li>}</For>
      </ul>,
    );
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Ada"]);

    act(() => {
      items.value = null;
    });
    expect(screen.getByText("empty")).toBeTruthy();

    act(() => {
      items.value = undefined;
    });
    expect(screen.getByText("empty")).toBeTruthy();

    act(() => {
      items.value = ["Bea"];
    });
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Bea"]);
  });

  it("renders Map and Set inputs after immutable collection replacement", () => {
    const tags = signal(new Set(["react"]));
    const users = signal(new Map([["ada", { name: "Ada" }]]));

    render(
      <>
        <ul data-testid="tags">
          <For each={tags} by={(tag) => tag}>{(tag) => <li>{tag}</li>}</For>
        </ul>
        <ul data-testid="users">
          <For each={users} by={([id]) => id}>
            {([id, user]) => <li>{`${id}:${user.name}`}</li>}
          </For>
        </ul>
      </>,
    );

    expect(within(screen.getByTestId("tags")).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["react"]);
    expect(within(screen.getByTestId("users")).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["ada:Ada"]);

    act(() => {
      tags.value = new Set(["signals", "react"]);
      users.value = new Map([
        ["bea", { name: "Bea" }],
        ["ada", { name: "Ada Lovelace" }],
      ]);
    });
    expect(within(screen.getByTestId("tags")).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["signals", "react"]);
    expect(within(screen.getByTestId("users")).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["bea:Bea", "ada:Ada Lovelace"]);
  });

  it("keeps Index row state at a position while its item changes", () => {
    const items = deepSignal([
      { id: "ada", name: "Ada" },
      { id: "bea", name: "Bea" },
    ]);

    function Row({ item }: { item: () => { id: string; name: string } }) {
      useSignals();
      const current = item();
      const [positionOwner] = useState(current.id);
      return <li>{`${positionOwner}:${current.name}`}</li>;
    }

    const view = render(
      <ul>
        <Index each={items} fallback={<li>empty</li>}>
          {(item) => <Row item={item} />}
        </Index>
      </ul>,
    );
    const list = view.container.querySelector("ul")!;
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["ada:Ada", "bea:Bea"]);

    act(() => {
      items.value = [items.value[1]!, items.value[0]!];
    });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["ada:Bea", "bea:Ada"]);

    act(() => {
      items.value[0]!.name = "Beatrice";
    });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["ada:Beatrice", "bea:Ada"]);

    act(() => {
      items.value = [];
    });
    expect(within(list).getByText("empty")).toBeTruthy();
  });
});
