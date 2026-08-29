/** @jsxImportSource react-fine-grained-signals */
// @vitest-environment jsdom

import { StrictMode, createRef, act } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsx, jsxs } from "../src/jsx-runtime.js";
import { jsxDEV } from "../src/jsx-dev-runtime.js";
import { signal } from "../src/index.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Signal children, props, and refs", () => {
  it("updates a signal child without rerendering its parent", () => {
    const source = signal("before");
    const parentRenders = vi.fn();

    function Parent() {
      parentRenders();
      return <span>{source}</span>;
    }

    render(<Parent />);
    expect(screen.getByText("before")).toBeTruthy();
    expect(parentRenders).toHaveBeenCalledTimes(1);
    act(() => {
      source.value = "after";
    });
    expect(screen.getByText("after")).toBeTruthy();
    expect(parentRenders).toHaveBeenCalledTimes(1);
  });

  it("updates an SVG signal child without rerendering its parent", () => {
    const source = signal("before");
    const parentRenders = vi.fn();

    function Parent() {
      parentRenders();
      return (
        <svg aria-label="signal chart">
          <text>{source}</text>
        </svg>
      );
    }

    const view = render(<Parent />);
    const text = view.container.querySelector("text");
    expect(text?.textContent).toBe("before");
    expect(parentRenders).toHaveBeenCalledTimes(1);

    act(() => {
      source.value = "after";
    });
    expect(text?.textContent).toBe("after");
    expect(parentRenders).toHaveBeenCalledTimes(1);
  });

  it("updates an array-valued signal child without rerendering its parent", () => {
    const items = signal(["a", "b"]);
    const parentRenders = vi.fn();

    function Parent() {
      parentRenders();
      return <ul aria-label="signal list">{items}</ul>;
    }

    render(<Parent />);
    expect(screen.getByLabelText("signal list").textContent).toBe("ab");
    expect(parentRenders).toHaveBeenCalledTimes(1);

    act(() => {
      items.value = ["c", "d", "e"];
    });
    expect(screen.getByLabelText("signal list").textContent).toBe("cde");
    expect(parentRenders).toHaveBeenCalledTimes(1);
  });

  it("updates a signal child nested inside another signal without rerendering its parent", () => {
    const inner = signal("leaf");
    const outer = signal<string | typeof inner>(inner);
    const parentRenders = vi.fn();

    function Parent() {
      parentRenders();
      return <span aria-label="nested signal child">{outer}</span>;
    }

    render(<Parent />);
    expect(screen.getByLabelText("nested signal child").textContent).toBe("leaf");
    expect(parentRenders).toHaveBeenCalledTimes(1);

    act(() => {
      inner.value = "changed";
    });
    expect(screen.getByLabelText("nested signal child").textContent).toBe("changed");
    expect(parentRenders).toHaveBeenCalledTimes(1);
  });

  it("updates className safely on a tag shared by the HTML and SVG namespaces", () => {
    const className = signal("before");

    render(
      <svg aria-label="shared namespace host">
        <a aria-label="svg link" className={className} />
      </svg>,
    );
    const link = screen.getByLabelText("svg link");
    expect(link.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(link.getAttribute("class")).toBe("before");

    act(() => {
      className.value = "after";
    });
    expect(link.getAttribute("class")).toBe("after");
  });

  it("does not unwrap a signal passed as a React component prop", () => {
    const source = signal("value");
    const childRenders = vi.fn();

    function Child({ value }: { value: typeof source }) {
      childRenders();
      return <output data-testid="component-prop">{value === source ? "signal" : "unwrapped"}</output>;
    }

    function Parent() {
      return <Child value={source} />;
    }

    render(<Parent />);
    expect(screen.getByTestId("component-prop").textContent).toBe("signal");
    expect(childRenders).toHaveBeenCalledTimes(1);
    act(() => {
      source.value = "changed";
    });
    expect(screen.getByTestId("component-prop").textContent).toBe("signal");
    expect(childRenders).toHaveBeenCalledTimes(1);
  });

  it("passes a signal child to a custom component without changing identity", () => {
    const source = signal("child");
    const childRenders = vi.fn();

    function Child({ children }: { children?: unknown }) {
      childRenders();
      return <output aria-label="child-identity">{children === source ? "same" : "different"}</output>;
    }

    render(<Child>{source}</Child>);
    expect(screen.getByLabelText("child-identity").textContent).toBe("same");
    expect(childRenders).toHaveBeenCalledTimes(1);
    act(() => {
      source.value = "updated";
    });
    expect(screen.getByLabelText("child-identity").textContent).toBe("same");
    expect(childRenders).toHaveBeenCalledTimes(1);
  });

  it("stops host signal prop updates after unmount", () => {
    const title = signal("attached");

    function Host() {
      return <span aria-label="detached host" title={title}>host</span>;
    }

    const view = render(<Host />);
    const node = screen.getByLabelText("detached host") as HTMLSpanElement;
    expect(node.title).toBe("attached");
    view.unmount();
    title.value = "after unmount";
    expect(node.title).toBe("attached");
  });

  it("balances callback ref setup and cleanup for a host signal binding", () => {
    const title = signal("attached");
    const setups = vi.fn();
    const cleanups = vi.fn();

    function Host() {
      return (
        <span
          aria-label="ref host"
          title={title}
          ref={(node) => {
            if (!node) return;
            setups();
            return cleanups;
          }}
        >
          host
        </span>
      );
    }

    const view = render(<Host />);
    expect(setups).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(cleanups).toHaveBeenCalledTimes(setups.mock.calls.length);
  });

  it("keeps a StrictMode host binding live for one update and inert after unmount", () => {
    const title = signal("before");
    const setups = vi.fn();
    const cleanups = vi.fn();

    function Host() {
      return (
        <StrictMode>
          <span
            aria-label="strict host"
            title={title}
            ref={(node) => {
              if (!node) return;
              setups();
              return cleanups;
            }}
          >
            host
          </span>
        </StrictMode>
      );
    }

    const view = render(<Host />);
    const node = screen.getByLabelText("strict host") as HTMLSpanElement;
    expect(node.title).toBe("before");
    act(() => {
      title.value = "after";
    });
    expect(node.title).toBe("after");

    view.unmount();
    const cleanupCount = cleanups.mock.calls.length;
    title.value = "after unmount";
    expect(node.title).toBe("after");
    expect(cleanups).toHaveBeenCalledTimes(setups.mock.calls.length);
    expect(cleanupCount).toBe(setups.mock.calls.length);
  });

  it("sets an object ref to the host node and clears it on unmount", () => {
    const title = signal("attached");
    const userRef = createRef<HTMLSpanElement>();

    const view = render(
      <span aria-label="object ref host" title={title} ref={userRef}>
        host
      </span>,
    );
    expect(userRef.current).not.toBeNull();
    expect(userRef.current?.title).toBe("attached");

    view.unmount();
    expect(userRef.current).toBeNull();
  });

  it("preserves factory keys and signal identity for custom component props and children", () => {
    const source = signal("child");

    function Child(_props: { value: typeof source; children: typeof source }) {
      return null;
    }

    const single = jsx(Child, { value: source, children: source }, "single-key");
    const many = jsxs(Child, { value: source, children: [source, "tail"] }, "many-key");
    const dev = jsxDEV(
      Child,
      { value: source, children: source },
      "dev-key",
      false,
      undefined,
      undefined,
    );
    const readProps = (element: { props: unknown }) => element.props as {
      value: typeof source;
      children: unknown;
    };
    const singleProps = readProps(single);
    const manyProps = readProps(many);
    const devProps = readProps(dev);

    expect(single.key).toBe("single-key");
    expect(singleProps.value).toBe(source);
    expect(singleProps.children).toBe(source);
    expect(many.key).toBe("many-key");
    expect(manyProps.value).toBe(source);
    expect((manyProps.children as unknown[])[0]).toBe(source);
    expect(dev.key).toBe("dev-key");
    expect(devProps.value).toBe(source);
    expect(devProps.children).toBe(source);
  });
});
