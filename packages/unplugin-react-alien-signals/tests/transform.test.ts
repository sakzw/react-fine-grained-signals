import { describe, expect, it } from "vitest";
import {
  transformReactAlienSignals,
  type ReactAlienSignalsMode,
  type ReactAlienSignalsTransform,
} from "../src/internal/transform.js";

function compile(
  source: string,
  mode: ReactAlienSignalsMode = "manual",
  transform: ReactAlienSignalsTransform = "managed",
  importSource = "react-alien-signals",
): string {
  return (
    transformReactAlienSignals(source, "fixture.tsx", {
      importSource,
      mode,
      transform,
    })?.code ?? source
  );
}

describe("managed render transform", () => {
  it("turns an explicit useSignals call into a managed try/finally scope", () => {
    const output = compile(`
      import { useSignals } from "react-alien-signals";
      export function Counter({ count }) {
        useSignals();
        return <button>{count.value}</button>;
      }
    `);

    expect(output).toContain('from "react-alien-signals/runtime"');
    expect(output).toContain("try {");
    expect(output).toContain("finally {");
    expect(output).toContain("_signals.f();");
    expect(output).not.toMatch(/\buseSignals\(\);/);
  });

  it("keeps the default manual mode and supports comment opt-in/out", () => {
    const output = compile(`
      const count = { value: 1 };
      export function Untouched() { return <p>{count.value}</p>; }
      /** @useSignals */
      export function callback() { return count.value; }
      /** @useSignals */
      export function OptIn() { return <p>{count.value}</p>; }
      /** @noUseSignals */
      export function OptOut() { return <p>{count.value}</p>; }
    `);

    expect(output.match(/finally/g)).toHaveLength(1);
    expect(output).toContain("function Untouched");
    expect(output).toContain("function callback");
    expect(output).toContain("function OptOut");
  });

  it("auto-detects named JSX components that read .value", () => {
    const output = compile(`
      const count = { value: 1 };
      export const Counter = () => <p>{count.value}</p>;
    `, "auto");

    expect(output).toContain("const Counter = () => {");
    expect(output).toContain("finally {");
  });

  it("injects a bare useSignals call without a managed render rewrite", () => {
    const output = compile(`
      const count = { value: 1 };
      export const Counter = () => <p>{count.value}</p>;
    `, "auto", "inject");

    expect(output).toContain('from "react-alien-signals"');
    expect(output).not.toContain('from "react-alien-signals/runtime"');
    expect(output).toContain("const Counter = () => {");
    expect(output).toContain("_useSignals();");
    expect(output).not.toContain("try {");
    expect(output).not.toContain("finally {");
    expect(output).not.toContain(".f();");
  });

  it("reuses a direct import and leaves an explicit bare useSignals call untouched", () => {
    const annotated = compile(`
      import { useSignals as track } from "react-alien-signals";
      /** @useSignals */
      export function Counter() { return <p>tracked</p>; }
    `, "manual", "inject");
    const explicit = `
      import { useSignals } from "react-alien-signals";
      export function Counter() { useSignals(); return <p />; }
    `;

    expect(annotated).toContain("track();");
    expect(annotated).not.toContain("_useSignals");
    expect(compile(explicit, "manual", "inject")).toBe(explicit);
  });

  it("supports custom import sources for the lightweight injection", () => {
    const output = compile(`
      const count = { value: 1 };
      export function Counter() { return <p>{count.value}</p>; }
    `, "auto", "inject", "custom-signals");

    expect(output).toContain('from "custom-signals"');
    expect(output).toContain("_useSignals();");
    expect(output).not.toContain('from "custom-signals/runtime"');
  });

  it("infers component names through memo and forwardRef wrappers", () => {
    const output = compile(`
      import { forwardRef, memo } from "react";
      const count = { value: 1 };
      export const MemoCounter = memo(() => <p>{count.value}</p>);
      export const RefCounter = forwardRef((props, ref) => <p ref={ref}>{count.value}</p>);
    `, "auto");

    expect(output.match(/finally/g)).toHaveLength(2);
    expect(output).toContain("const MemoCounter = memo(() => {");
    expect(output).toContain("const RefCounter = forwardRef((props, ref) => {");
  });

  it("supports comment opt-in on a wrapped named component", () => {
    const output = compile(`
      import { memo } from "react";
      /** @useSignals */
      export const Counter = memo(() => <p>tracked manually</p>);
    `);

    expect(output).toContain("const Counter = memo(() => {");
    expect(output).toContain("finally {");
  });

  it("does not auto-transform lowercase functions, JSX without .value, or non-JSX reads", () => {
    const output = compile(`
      const count = { value: 1 };
      export function render() { return <p>{count.value}</p>; }
      export function Plain() { return <p>plain</p>; }
      export function Value() { return count.value; }
    `, "auto");

    expect(output).not.toContain("react-alien-signals/runtime");
    expect(output).not.toContain("finally");
  });

  it("auto-detects custom hooks that own a .value read", () => {
    const output = compile(`
      const count = { value: 1 };
      export function useCount() { return count.value; }
      export function Counter() { return <p>{useCount()}</p>; }
    `, "auto");

    expect(output.match(/finally/g)).toHaveLength(1);
    expect(output).toContain("function useCount");
  });

  it("recognizes bracket and optional .value reads", () => {
    const output = compile(`
      const count = { value: 1 };
      export function Bracket() { return <p>{count["value"]}</p>; }
      export function Optional() { return <p>{count?.value}</p>; }
    `, "auto");

    expect(output.match(/finally/g)).toHaveLength(2);
  });

  it("all mode wraps named JSX components without a statically visible signal read", () => {
    const output = compile(`
      export function App() { return <main />; }
      export function useValue() { return 1; }
    `, "all");

    expect(output.match(/finally/g)).toHaveLength(1);
    expect(output).toContain("function App");
  });

  it.each(["auto", "all"] as const)(
    "%s mode tracks render callbacks through their owner without injecting a hook into the callback",
    (mode) => {
      const output = compile(`
        const items = [{ value: "one" }];
        export function List() {
          return <ul>{items.map(function Row(item) { return <li>{item.value}</li>; })}</ul>;
        }
      `, mode);

      expect(output.match(/finally/g)).toHaveLength(1);
      expect(output).toMatch(/function List\(\) \{\s+const _signals/);
      expect(output).toMatch(/function Row\(item\) \{\s+return/);
    },
  );

  it("skips automatic async and generator candidates", () => {
    const auto = compile(`
      const count = { value: 1 };
      export async function AsyncPage() { return <p>{count.value}</p>; }
    `, "auto");
    const all = compile(`
      export function* GeneratorPage() { yield <p>value</p>; }
    `, "all");

    expect(auto).not.toContain("react-alien-signals/runtime");
    expect(auto).not.toContain("finally");
    expect(all).not.toContain("react-alien-signals/runtime");
    expect(all).not.toContain("finally");
  });

  it("rejects explicit or annotated async opt-in", () => {
    expect(() => compile(`
      import { useSignals } from "react-alien-signals";
      export async function Explicit() { useSignals(); return <p />; }
    `)).toThrow("only supports synchronous, non-generator functions");

    expect(() => compile(`
      /** @useSignals */
      export async function Annotated() { return <p />; }
    `)).toThrow("only supports synchronous, non-generator functions");
  });

  it("does not turn a late explicit useSignals call into a second hook", () => {
    const output = compile(`
      import { useSignals } from "react-alien-signals";
      const count = { value: 1 };
      export function App() { const prefix = "v"; useSignals(); return <p>{prefix}{count.value}</p>; }
    `, "auto");

    expect(output).not.toContain("react-alien-signals/runtime");
    expect(output).toContain("useSignals();");
  });

  it("recognizes existing namespace and barrel-imported useSignals calls", () => {
    const namespaceSource = `
      import * as signals from "react-alien-signals";
      const count = { value: 1 };
      export function App() { const prefix = "v"; signals.useSignals(); return <p>{prefix}{count.value}</p>; }
    `;
    const barrelSource = `
      import { useSignals as track } from "./signals.js";
      const count = { value: 1 };
      export function App() { const prefix = "v"; track(); return <p>{prefix}{count.value}</p>; }
    `;

    expect(compile(namespaceSource, "auto", "inject")).toBe(namespaceSource);
    expect(compile(barrelSource, "auto", "managed")).toBe(barrelSource);
  });

  it.each(["inject", "managed"] as const)("keeps the %s transform idempotent", (transform) => {
    const source = `
      const count = { value: 1 };
      export function App() { return <p>{count.value}</p>; }
    `;
    const once = compile(source, "auto", transform);

    expect(compile(once, "auto", transform)).toBe(once);
  });

  it("does not inherit an annotation into descendant component declarations", () => {
    const output = compile(`
      /** @useSignals */
      export function Parent() {
        function Child() { return <span>child</span>; }
        return <Child />;
      }
    `);

    expect(output.match(/finally/g)).toHaveLength(1);
  });

  it("parses non-JSX TypeScript syntax according to the module extension", () => {
    const options = {
      importSource: "react-alien-signals",
      mode: "auto" as const,
      transform: "inject" as const,
    };

    expect(
      transformReactAlienSignals("const value = <string>input;", "fixture.ts", options),
    ).toBeNull();
    expect(transformReactAlienSignals("@sealed class Store {}", "fixture.ts", options)).toBeNull();
    expect(
      transformReactAlienSignals(
        "const count = { value: 1 }; export const App = () => <p>{count.value}</p>;",
        "fixture.js",
        options,
      )?.code,
    ).toContain("_useSignals();");
  });

  it("does not reuse a type-only runtime import or a shadowed runtime alias", () => {
    const typeOnly = compile(`
      import { useSignals } from "react-alien-signals";
      import type { useSignals as managed } from "react-alien-signals/runtime";
      export function App() { useSignals(); return <main />; }
    `);
    const shadowed = compile(`
      import { useSignals } from "react-alien-signals";
      import { useSignals as managed } from "react-alien-signals/runtime";
      export function App(managed) { useSignals(); return <main />; }
    `);

    expect(typeOnly).toContain("const _signals = _useSignals();");
    expect(typeOnly).not.toContain("const _signals = managed();");
    expect(shadowed).toContain("const _signals = _useSignals();");
    expect(shadowed).not.toContain("const _signals = managed();");
  });
});
