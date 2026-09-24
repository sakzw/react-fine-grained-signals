import * as runtime from "../src/runtime.js";
import { describe, expect, it } from "vitest";

describe("runtime entry point exports", () => {
  it("exports useManagedSignals without the ambiguous useSignals alias", () => {
    expect(runtime.useManagedSignals).toBeTypeOf("function");
    expect("useSignals" in runtime).toBe(false);
  });
});
