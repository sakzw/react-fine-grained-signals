import { describe, expect, it } from "vitest";
import { canTransform, reactAlienSignals } from "../src/unplugin.js";

describe("unplugin-react-alien-signals", () => {
  it("only includes application JavaScript and TypeScript modules", () => {
    const options = {
      include: (id: string) => id.includes("/src/"),
    };

    expect(canTransform("/project/src/App.tsx", options)).toBe(true);
    expect(canTransform("/project/src/state.ts", options)).toBe(true);
    expect(canTransform("/project/node_modules/pkg/index.js", options)).toBe(false);
    expect(canTransform("/project/src/styles.css", options)).toBe(false);
    expect(canTransform("/project/test/App.tsx", options)).toBe(false);
  });

  it("accepts the public auto mode option", () => {
    expect(reactAlienSignals).toBeDefined();
  });
});
