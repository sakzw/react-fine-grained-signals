/** @jsxImportSource react-alien-signals */
// @vitest-environment jsdom

import { StrictMode, act } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signal, useSignalEffect } from "../src/index.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useSignalEffect", () => {
  it("runs useSignalEffect on changes and disposes it on unmount", () => {
    const source = signal(0);
    const seen: number[] = [];
    const cleanups: number[] = [];

    function Observer() {
      useSignalEffect(() => {
        seen.push(source.value);
        return () => cleanups.push(source.value);
      });
      return null;
    }

    const view = render(<Observer />);
    expect(seen).toEqual([0]);
    act(() => {
      source.value = 1;
    });
    expect(seen).toEqual([0, 1]);
    view.unmount();
    expect(cleanups.length).toBeGreaterThanOrEqual(1);
    const runsAfterUnmount = seen.length;
    act(() => {
      source.value = 2;
    });
    expect(seen).toHaveLength(runsAfterUnmount);
  });

  it("does not restart an inline useSignalEffect after an unrelated render", () => {
    const source = signal(0);
    const setups = vi.fn();
    const cleanups = vi.fn();

    function Observer({ label }: { label: string }) {
      useSignalEffect(() => {
        source.value;
        setups(label);
        return cleanups;
      });
      return <span>{label}</span>;
    }

    const view = render(<Observer label="first" />);
    view.rerender(<Observer label="second" />);

    expect(setups).toHaveBeenCalledTimes(1);
    expect(setups).toHaveBeenLastCalledWith("first");
    expect(cleanups).not.toHaveBeenCalled();

    act(() => {
      source.value = 1;
    });
    expect(setups).toHaveBeenCalledTimes(2);
    expect(setups).toHaveBeenLastCalledWith("first");
  });

  it("reconnects useSignalEffect when an explicit React dependency changes", () => {
    const source = signal(0);
    const setups = vi.fn();
    const cleanups = vi.fn();

    function Observer({ label }: { label: string }) {
      useSignalEffect(() => {
        source.value;
        setups(label);
        return () => cleanups(label);
      }, [label]);
      return null;
    }

    const view = render(<Observer label="first" />);
    view.rerender(<Observer label="second" />);

    expect(setups).toHaveBeenCalledTimes(2);
    expect(setups).toHaveBeenLastCalledWith("second");
    expect(cleanups).toHaveBeenCalledWith("first");

    act(() => {
      source.value = 1;
    });
    expect(setups).toHaveBeenCalledTimes(3);
    expect(setups).toHaveBeenLastCalledWith("second");
  });

  it("cleans every StrictMode signal effect subscription", () => {
    const source = signal(0);
    const setups = vi.fn();
    const cleanups = vi.fn();

    function StrictObserver() {
      useSignalEffect(() => {
        source.value;
        setups();
        return cleanups;
      });
      return null;
    }

    const view = render(
      <StrictMode>
        <StrictObserver />
      </StrictMode>,
    );
    expect(setups).toHaveBeenCalled();
    view.unmount();
    expect(cleanups).toHaveBeenCalledTimes(setups.mock.calls.length);
    act(() => {
      source.value++;
    });
    expect(cleanups).toHaveBeenCalledTimes(setups.mock.calls.length);
  });
});
