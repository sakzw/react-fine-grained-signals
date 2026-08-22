import { transformSync } from "@babel/core";
import { describe, expect, it } from "vitest";
import transform from "../src/index.js";

function compile(source: string): string {
  const result = transformSync(source, {
    babelrc: false,
    configFile: false,
    filename: "fixture.tsx",
    parserOpts: { plugins: ["jsx", "typescript"] },
    plugins: [transform],
  });
  const code = result?.code;
  if (code == null) throw new Error("Babel produced no code");
  return code;
}

describe("babel-plugin-react-alien-signals", () => {
  it("turns an explicit useSignals call into a managed try/finally scope", () => {
    const output = compile(`
      import { useSignals } from "react-alien-signals";
      export function Counter({ count }) {
        useSignals();
        if (count.value < 0) throw new Error("negative");
        return <button>{count.value}</button>;
      }
    `);

    expect(output).toContain('from "react-alien-signals/runtime"');
    expect(output).toMatch(/const _signals = _useSignals\(\);/);
    expect(output).toContain("try {");
    expect(output).toContain("finally {");
    expect(output).toContain("_signals.f();");
    expect(output.match(/useSignals\(\)/g)).toHaveLength(1);
  });

  it("supports aliased imports and block-bodied arrows", () => {
    const output = compile(`
      import { useSignals as track } from "react-alien-signals";
      export const Counter = ({ count }) => {
        track();
        return <button>{count.value}</button>;
      };
    `);

    expect(output).toContain("const _signals = _useSignals();");
    expect(output).not.toContain("track();");
  });

  it("preserves directives and reuses an existing runtime import", () => {
    const output = compile(`
      "use client";
      import { useSignals } from "react-alien-signals";
      import { useSignals as managed } from "react-alien-signals/runtime";
      export default function App() {
        useSignals();
        return <main />;
      }
    `);

    expect(output.startsWith('"use client";')).toBe(true);
    expect(output.match(/react-alien-signals\/runtime/g)).toHaveLength(1);
    expect(output).toContain("const _signals = managed();");
  });

  it("does not reuse a type-only managed runtime import", () => {
    const output = compile(`
      import { useSignals } from "react-alien-signals";
      import type { useSignals as managed } from "react-alien-signals/runtime";
      import { type useSignals as inlineManaged } from "react-alien-signals/runtime";
      export default function App() {
        useSignals();
        return <main />;
      }
    `);

    expect(output).toContain(
      'import { useSignals as _useSignals } from "react-alien-signals/runtime";',
    );
    expect(output).toContain("const _signals = _useSignals();");
    expect(output).not.toContain("const _signals = managed();");
    expect(output).not.toContain("const _signals = inlineManaged();");
  });

  it("adds a fresh runtime import when an existing alias is shadowed", () => {
    const output = compile(`
      import { useSignals } from "react-alien-signals";
      import { useSignals as managed } from "react-alien-signals/runtime";
      export function App(managed) {
        useSignals();
        return <main />;
      }
    `);

    expect(output).toContain(
      'import { useSignals as _useSignals } from "react-alien-signals/runtime";',
    );
    expect(output).toContain("const _signals = _useSignals();");
    expect(output).not.toContain("const _signals = managed();");
  });

  it("does not transform a call backed by a type-only root import", () => {
    const output = compile(`
      import type { useSignals } from "react-alien-signals";
      export function App() {
        useSignals();
        return <main />;
      }
    `);

    expect(output).not.toContain("react-alien-signals/runtime");
    expect(output).not.toContain("finally");
    expect(output).toContain("useSignals();");
  });

  it("leaves functions without a first-statement useSignals call unchanged", () => {
    const output = compile(`
      import { useSignals } from "react-alien-signals";
      export function Plain() { return <div />; }
      export function Late() { const value = 1; useSignals(); return <div>{value}</div>; }
    `);

    expect(output).not.toContain("react-alien-signals/runtime");
    expect(output).not.toContain("finally");
  });

  it("rejects async functions that opt into render tracking", () => {
    expect(() => compile(`
      import { useSignals } from "react-alien-signals";
      export async function AsyncComponent() { useSignals(); return <div />; }
    `)).toThrow("only supports synchronous, non-generator functions");
  });

  it("supports a custom import source", () => {
    const result = transformSync(`
      import { useSignals } from "@scope/signals";
      export function App() { useSignals(); return <main />; }
    `, {
      babelrc: false,
      configFile: false,
      filename: "fixture.tsx",
      parserOpts: { plugins: ["jsx", "typescript"] },
      plugins: [[transform, { importSource: "@scope/signals" }]],
    });

    expect(result?.code).toContain('from "@scope/signals/runtime"');
  });

  it("preserves source locations for Babel source-map chaining", () => {
    const result = transformSync(`
      import { useSignals } from "react-alien-signals";
      export function App() { useSignals(); return <main />; }
    `, {
      babelrc: false,
      configFile: false,
      filename: "fixture.tsx",
      parserOpts: { plugins: ["jsx", "typescript"] },
      plugins: [transform],
      sourceMaps: true,
    });

    expect(result?.map?.sources).toEqual(["fixture.tsx"]);
    expect(result?.map?.mappings).not.toBe("");
  });
});
