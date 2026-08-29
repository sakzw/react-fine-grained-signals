import { describe, expect, it } from "vitest";
import {
  canTransform,
  reactFineGrainedSignals,
  type ReactFineGrainedSignalsOptions,
} from "../src/unplugin.js";

const counterSource = "const count = { value: 1 }; export const App = () => <p>{count.value}</p>;";

function transformSource(
  source: string,
  options: ReactFineGrainedSignalsOptions,
): string | undefined {
  const plugin = reactFineGrainedSignals.vite(options) as unknown as {
    transform(code: string, id: string): { code: string } | null;
  };
  return plugin.transform(source, "/project/src/App.tsx")?.code;
}

function transformCounter(options: ReactFineGrainedSignalsOptions): string | undefined {
  return transformSource(counterSource, options);
}

const explicitSource = [
  'import { useSignals } from "react-fine-grained-signals";',
  "const count = { value: 1 };",
  "export function App() { useSignals(); return <p>{count.value}</p>; }",
].join("\n");

const explicitAsyncSource = [
  'import { useSignals } from "react-fine-grained-signals";',
  "const count = { value: 1 };",
  "export async function App() { useSignals(); return <p>{count.value}</p>; }",
].join("\n");

const explicitGeneratorSource = [
  'import { useSignals } from "react-fine-grained-signals";',
  "const count = { value: 1 };",
  "export function* App() { useSignals(); yield <p>{count.value}</p>; }",
].join("\n");

describe("unplugin-react-fine-grained-signals", () => {
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
    expect(reactFineGrainedSignals).toBeDefined();
  });

  it("uses the managed try/finally transform by default", () => {
    const output = transformCounter({ mode: "auto" });

    expect(output).toContain('from "react-fine-grained-signals/runtime"');
    expect(output).toContain("const _signals = _useSignals();");
    expect(output).toContain("try {");
    expect(output).toContain("_signals.f();");
  });

  it("uses the lightweight injection transform when it is opted into", () => {
    const output = transformCounter({ mode: "auto", transform: "inject" });

    expect(output).toContain('from "react-fine-grained-signals"');
    expect(output).not.toContain('from "react-fine-grained-signals/runtime"');
    expect(output).toContain("_useSignals();");
    expect(output).not.toContain("try {");
  });

  it("absorbs an explicit useSignals call into the default managed boundary", () => {
    const output = transformSource(explicitSource, { mode: "auto" });

    // The author's own call is replaced by the managed store declaration, so
    // the body is rewritten rather than left untouched — but no second
    // `useSignals()` call is ever added.
    expect(output).toContain('from "react-fine-grained-signals/runtime"');
    expect(output).toContain("const _signals = _useSignals();");
    expect(output).toContain("try {");
    expect(output).toContain("_signals.f();");
    expect(output).not.toMatch(/^\s*useSignals\(\);$/m);
  });

  it("keeps an explicit useSignals call in place under the injection transform", () => {
    const output = transformSource(explicitSource, { mode: "auto", transform: "inject" });

    expect(output).not.toContain('from "react-fine-grained-signals/runtime"');
    expect(output).not.toContain("try {");
    expect(output).toMatch(/^\s*useSignals\(\);$/m);
  });

  it("rejects an explicit useSignals call in an async or generator function by default", () => {
    expect(() => transformSource(explicitAsyncSource, { mode: "auto" }))
      .toThrow("only supports synchronous, non-generator functions");
    expect(() => transformSource(explicitGeneratorSource, { mode: "auto" }))
      .toThrow("only supports synchronous, non-generator functions");
  });

  it("leaves an explicit async or generator useSignals call alone under the injection transform", () => {
    const asyncOutput = transformSource(explicitAsyncSource, {
      mode: "auto",
      transform: "inject",
    });
    const generatorOutput = transformSource(explicitGeneratorSource, {
      mode: "auto",
      transform: "inject",
    });

    expect(asyncOutput).toContain("async function App()");
    expect(asyncOutput).not.toContain('from "react-fine-grained-signals/runtime"');
    expect(generatorOutput).toContain("function* App()");
    expect(generatorOutput).not.toContain('from "react-fine-grained-signals/runtime"');
  });
});
