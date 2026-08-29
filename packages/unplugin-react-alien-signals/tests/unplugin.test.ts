import { describe, expect, it } from "vitest";
import {
  canTransform,
  reactAlienSignals,
  type ReactAlienSignalsOptions,
} from "../src/unplugin.js";

const counterSource = "const count = { value: 1 }; export const App = () => <p>{count.value}</p>;";

function transformCounter(options: ReactAlienSignalsOptions): string | undefined {
  const plugin = reactAlienSignals.vite(options) as unknown as {
    transform(code: string, id: string): { code: string } | null;
  };
  return plugin.transform(counterSource, "/project/src/App.tsx")?.code;
}

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

  it("uses the managed try/finally transform by default", () => {
    const output = transformCounter({ mode: "auto" });

    expect(output).toContain('from "react-alien-signals/runtime"');
    expect(output).toContain("const _signals = _useSignals();");
    expect(output).toContain("try {");
    expect(output).toContain("_signals.f();");
  });

  it("uses the lightweight injection transform when it is opted into", () => {
    const output = transformCounter({ mode: "auto", transform: "inject" });

    expect(output).toContain('from "react-alien-signals"');
    expect(output).not.toContain('from "react-alien-signals/runtime"');
    expect(output).toContain("_useSignals();");
    expect(output).not.toContain("try {");
  });
});
