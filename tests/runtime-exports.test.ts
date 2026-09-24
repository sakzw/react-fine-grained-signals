import * as runtime from "../src/runtime.js";
import * as root from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("public tracking hook exports", () => {
  it("exports useSignalTracking from the root and keeps the managed API on runtime", () => {
    expect(root.useSignalTracking).toBeTypeOf("function");
    expect("useSignals" in root).toBe(false);
    expect(runtime.useManagedSignals).toBeTypeOf("function");
    expect("useSignalTracking" in runtime).toBe(false);
  });
});
