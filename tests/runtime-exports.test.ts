import * as runtime from "../src/internal.js";
import * as root from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("public tracking hook exports", () => {
  it("exports useSignalTracking from the root and only the transform's capture hook from /internal", () => {
    expect(root.useSignalTracking).toBeTypeOf("function");
    expect("useSignals" in root).toBe(false);
    expect("useManagedSignals" in root).toBe(false);
    expect(runtime.useSignalCapture).toBeTypeOf("function");
    expect("useManagedSignals" in runtime).toBe(false);
    expect("useSignalTracking" in runtime).toBe(false);
  });
});
