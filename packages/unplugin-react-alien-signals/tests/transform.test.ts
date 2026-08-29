import { describe, expect, it } from "vitest";
import {
  transformReactAlienSignals,
  type ReactAlienSignalsMode,
  type ReactAlienSignalsReactCompiler,
  type ReactAlienSignalsTransform,
} from "../src/internal/transform.js";

function compile(
  source: string,
  mode: ReactAlienSignalsMode = "manual",
  transform: ReactAlienSignalsTransform = "managed",
  importSource = "react-alien-signals",
  reactCompiler: ReactAlienSignalsReactCompiler = "auto",
  reactImportSource = "react",
): string {
  return (
    transformReactAlienSignals(source, "fixture.tsx", {
      importSource,
      mode,
      transform,
      reactCompiler,
      reactImportSource,
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
    expect(compile(explicit, "manual", "inject", "react-alien-signals", "off")).toBe(explicit);
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

  it("prefers the wrapper's assigned name over a wrapped function's own inner name", () => {
    const memoOutput = compile(`
      import { memo } from "react";
      const count = { value: 1 };
      export const Counter = memo(function inner() { return <p>{count.value}</p>; });
    `, "auto");
    const forwardRefOutput = compile(`
      import { forwardRef } from "react";
      const count = { value: 1 };
      export const Counter = forwardRef(function render(props, ref) {
        return <p ref={ref}>{count.value}</p>;
      });
    `, "auto");

    expect(memoOutput).toContain("memo(function inner() {");
    expect(memoOutput.match(/finally/g)).toHaveLength(1);
    expect(memoOutput).toContain("_signals.f();");
    expect(forwardRefOutput).toContain("forwardRef(function render(props, ref) {");
    expect(forwardRefOutput.match(/finally/g)).toHaveLength(1);
    expect(forwardRefOutput).toContain("_signals.f();");
  });

  it("recognizes memo imported from a configured react re-export module", () => {
    const namedSource = `
      import { memo } from "./react-compat";
      const count = { value: 1 };
      export const Counter = memo(() => <p>{count.value}</p>);
    `;
    const namespaceSource = `
      import * as React from "./react-compat";
      const count = { value: 1 };
      export const Counter = React.memo(() => <p>{count.value}</p>);
    `;
    const named = compile(namedSource, "auto", "managed", "react-alien-signals", "auto", "./react-compat");
    const namespaced = compile(
      namespaceSource, "auto", "managed", "react-alien-signals", "auto", "./react-compat",
    );

    expect(named).toContain("const Counter = memo(() => {");
    expect(named).toContain("finally {");
    expect(namespaced).toContain("const Counter = React.memo(() => {");
    expect(namespaced).toContain("finally {");
    // Documented limitation: the default only matches a direct "react" import,
    // because a single-file transform cannot follow the re-export chain.
    expect(compile(namedSource, "auto")).not.toContain("finally");
    expect(compile(namedSource, "auto")).not.toContain("react-alien-signals/runtime");
    expect(compile(namespaceSource, "auto")).not.toContain("finally");
  });

  it("keeps recognizing direct react imports when reactImportSource is configured", () => {
    const output = compile(`
      import { forwardRef, memo } from "react";
      const count = { value: 1 };
      export const MemoCounter = memo(() => <p>{count.value}</p>);
      export const RefCounter = forwardRef((props, ref) => <p ref={ref}>{count.value}</p>);
    `, "auto", "managed", "react-alien-signals", "auto", "./react-compat");

    expect(output.match(/finally/g)).toHaveLength(2);
    expect(output).toContain("const MemoCounter = memo(() => {");
    expect(output).toContain("const RefCounter = forwardRef((props, ref) => {");
  });

  it("infers component names through memo and forwardRef reached via a React namespace or default import", () => {
    const namespaceOutput = compile(`
      import * as React from "react";
      const count = { value: 1 };
      export const MemoCounter = React.memo(() => <p>{count.value}</p>);
      export const RefCounter = React.forwardRef((props, ref) => <p ref={ref}>{count.value}</p>);
    `, "auto");
    const defaultOutput = compile(`
      import React from "react";
      const count = { value: 1 };
      export const MemoCounter = React.memo(() => <p>{count.value}</p>);
    `, "auto");

    expect(namespaceOutput.match(/finally/g)).toHaveLength(2);
    expect(namespaceOutput).toContain("const MemoCounter = React.memo(() => {");
    expect(namespaceOutput).toContain("const RefCounter = React.forwardRef((props, ref) => {");
    expect(defaultOutput.match(/finally/g)).toHaveLength(1);
    expect(defaultOutput).toContain("const MemoCounter = React.memo(() => {");
  });

  it("does not mistake a local memo helper or a memo from another package for React's wrapper", () => {
    const localHelper = compile(`
      const state = { value: 1 };
      function memo(fn) {
        const cache = new Map();
        return (...args) => {
          const key = JSON.stringify(args);
          if (!cache.has(key)) cache.set(key, fn(...args));
          return cache.get(key);
        };
      }
      export const useCachedValue = memo(() => state.value);
    `, "auto");
    const otherPackage = compile(`
      import { memo } from "state-lib";
      const state = { value: 1 };
      export const useCachedValue = memo(() => state.value);
    `, "auto");
    const memberExpressionHelper = compile(`
      import * as Utils from "state-lib";
      const state = { value: 1 };
      export const useCachedValue = Utils.memo(() => state.value);
    `, "auto");

    for (const output of [localHelper, otherPackage, memberExpressionHelper]) {
      expect(output).not.toContain("finally");
      expect(output).not.toContain("react-alien-signals/runtime");
    }
  });

  it("infers component names through memo and forwardRef wrappers reached via an aliased React import", () => {
    const output = compile(`
      import { memo as m, forwardRef as fr } from "react";
      const count = { value: 1 };
      export const MemoCounter = m(() => <p>{count.value}</p>);
      export const RefCounter = fr((props, ref) => <p ref={ref}>{count.value}</p>);
    `, "auto");

    expect(output.match(/finally/g)).toHaveLength(2);
    expect(output).toContain("const MemoCounter = m(() => {");
    expect(output).toContain("const RefCounter = fr((props, ref) => {");
  });

  it("does not mistake an aliased memo import from another package for React's wrapper", () => {
    const output = compile(`
      import { memo as m } from "state-lib";
      const state = { value: 1 };
      export const useCachedValue = m(() => state.value);
    `, "auto");

    expect(output).not.toContain("finally");
    expect(output).not.toContain("react-alien-signals/runtime");
  });

  it.each(["auto", "all"] as const)(
    "transforms named default-export memo and forwardRef components in %s mode",
    (mode) => {
      const memoOutput = compile(`
          import { memo } from "react";
          const count = { value: 1 };
          export default memo(function Inner() { return <p>{count.value}</p>; });
        `, mode);
      const forwardRefOutput = compile(`
          import { forwardRef } from "react";
          const count = { value: 1 };
          export default forwardRef(function Inner(props, ref) {
            return <p ref={ref}>{count.value}</p>;
          });
        `, mode);

      expect(memoOutput).toContain("memo(function Inner() {");
      expect(memoOutput).toContain("finally {");
      expect(forwardRefOutput).toContain("forwardRef(function Inner(props, ref) {");
      expect(forwardRefOutput).toContain("finally {");
    },
  );

  it.each(["auto", "all"] as const)(
    "does not transform anonymous default-export wrappers in %s mode",
    (mode) => {
      const memoOutput = compile(`
          import { memo } from "react";
          const count = { value: 1 };
          export default memo(() => <p>{count.value}</p>);
        `, mode);
      const forwardRefOutput = compile(`
          import { forwardRef } from "react";
          const count = { value: 1 };
          export default forwardRef((props, ref) => <p ref={ref}>{count.value}</p>);
        `, mode);

      expect(memoOutput).not.toContain("finally {");
      expect(memoOutput).not.toContain('from "react-alien-signals/runtime"');
      expect(forwardRefOutput).not.toContain("finally {");
      expect(forwardRefOutput).not.toContain('from "react-alien-signals/runtime"');
    },
  );

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
      expect(output).toMatch(/function List\(\) \{\s+(?:"use no memo";\s+)?const _signals/);
      expect(output).toMatch(/function Row\(item\) \{\s+return/);
    },
  );

  it.each(["auto", "all"] as const)(
    "%s mode tracks directly returned map callbacks through the outer component",
    (mode) => {
      const output = compile(`
        const items = [{ value: "one" }];
        export function ArrowList() {
          return items.map((item) => <li>{item.value}</li>);
        }
        export function NamedList() {
          return items.map(function Row(item) { return <li>{item.value}</li>; });
        }
      `, mode);

      expect(output.match(/finally/g)).toHaveLength(2);
      expect(output).toMatch(/function ArrowList\(\) \{\s+(?:"use no memo";\s+)?const _signals/);
      expect(output).toMatch(/function NamedList\(\) \{\s+(?:"use no memo";\s+)?const _signals\d*/);
      expect(output).toMatch(/function Row\(item\) \{\s+return/);
    },
  );

  it("transforms a named component returned from a HOC", () => {
    const output = compile(`
      const count = { value: 1 };
      export function withCount(Base) {
        return function Wrapped(props) {
          return <Base {...props} count={count.value} />;
        };
      }
    `, "auto");

    expect(output.match(/finally/g)).toHaveLength(1);
    expect(output).toMatch(/function withCount\(Base\) \{\s+return function Wrapped/);
    expect(output).toMatch(/function Wrapped\(props\) \{\s+(?:"use no memo";\s+)?const _signals/);
  });

  it("gives nested named components their own automatic tracking boundary", () => {
    const source = `
      const count = { value: 1 };
      export function Parent() {
        const Child = () => <p>{count.value}</p>;
        return <Child />;
      }
    `;
    const auto = compile(source, "auto");
    const all = compile(source, "all");

    expect(auto.match(/finally/g)).toHaveLength(1);
    expect(auto).toMatch(/function Parent\(\) \{\s+const Child/);
    expect(auto).toMatch(/const Child = \(\) => \{\s+(?:"use no memo";\s+)?const _signals/);
    expect(all.match(/finally/g)).toHaveLength(2);
    expect(all).toMatch(/function Parent\(\) \{\s+(?:"use no memo";\s+)?const _signals/);
    expect(all).toMatch(/const Child = \(\) => \{\s+(?:"use no memo";\s+)?const _signals\d*/);
  });

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
    const namespaceBarrelSource = `
      import * as signals from "./signals.js";
      const count = { value: 1 };
      export function App() { const prefix = "v"; signals.useSignals(); return <p>{prefix}{count.value}</p>; }
    `;

    expect(compile(namespaceSource, "auto", "inject")).toBe(namespaceSource);
    expect(compile(barrelSource, "auto", "managed")).toBe(barrelSource);
    expect(compile(namespaceBarrelSource, "auto", "inject")).toBe(namespaceBarrelSource);
    expect(compile(namespaceBarrelSource, "auto", "managed")).toBe(namespaceBarrelSource);
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
      reactCompiler: "auto" as const,
      reactImportSource: "react",
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

describe("React Compiler opt-out directive", () => {
  const autoSource = `
    const count = { value: 1 };
    export function Counter() { return <p>{count.value}</p>; }
  `;

  it.each(["inject", "managed"] as const)(
    "marks a %s-transformed function with the memoization opt-out",
    (transform) => {
      const output = compile(autoSource, "auto", transform);

      expect(output).toContain('"use no memo";');
      expect(compile(autoSource, "auto", transform, "react-alien-signals", "off"))
        .not.toContain("use no memo");
    },
  );

  it("marks a custom hook it transforms", () => {
    const output = compile(`
      const count = { value: 1 };
      export function useTotal() { return count.value + 1; }
    `, "auto", "inject");

    expect(output).toContain('"use no memo";');
  });

  it("marks an explicit useSignals component the inject transform leaves alone", () => {
    const explicit = `
      import { useSignals } from "react-alien-signals";
      export function Counter({ count }) { useSignals(); return <p>{count.value}</p>; }
    `;
    const output = compile(explicit, "manual", "inject");

    expect(output).toContain('"use no memo";');
    expect(output).toContain("useSignals();");
    expect(output).not.toContain("_useSignals");
  });

  it("does not mark functions it leaves untransformed", () => {
    const output = compile(`
      const count = { value: 1 };
      export function Untouched() { return <p>{count.value}</p>; }
      /** @noUseSignals */
      export function OptOut() { return <p>{count.value}</p>; }
      export function helper() { return count.value; }
    `, "manual", "inject");

    expect(output).not.toContain("use no memo");
  });

  it("respects an author's own memoization directive", () => {
    const optIn = compile(`
      const count = { value: 1 };
      export function Counter() { "use memo"; return <p>{count.value}</p>; }
    `, "auto", "inject");

    expect(optIn).toContain('"use memo";');
    expect(optIn).not.toContain("use no memo");
    expect(optIn).toContain("_useSignals();");
  });

  it.each(["inject", "managed"] as const)(
    "stays idempotent with the %s transform",
    (transform) => {
      const once = compile(autoSource, "auto", transform);

      expect(once.match(/use no memo/g)).toHaveLength(1);
      expect(compile(once, "auto", transform)).toBe(once);
    },
  );
});
