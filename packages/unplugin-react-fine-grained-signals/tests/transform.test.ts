import { afterEach, describe, expect, it, vi } from "vitest";
import {
  transformReactFineGrainedSignals,
  type ReactFineGrainedSignalsMode,
  type ReactFineGrainedSignalsReactCompiler,
  type ReactFineGrainedSignalsTransform,
} from "../src/internal/transform.js";

function compile(
  source: string,
  mode: ReactFineGrainedSignalsMode = "manual",
  transform: ReactFineGrainedSignalsTransform = "managed",
  importSource = "react-fine-grained-signals",
  reactCompiler: ReactFineGrainedSignalsReactCompiler = "auto",
  reactImportSource = "react",
): string {
  return (
    transformReactFineGrainedSignals(source, "fixture.tsx", {
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
      import { useSignals } from "react-fine-grained-signals";
      export function Counter({ count }) {
        useSignals();
        return <button>{count.value}</button>;
      }
    `);

    expect(output).toContain('from "react-fine-grained-signals/runtime"');
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

    expect(output).toContain('from "react-fine-grained-signals"');
    expect(output).not.toContain('from "react-fine-grained-signals/runtime"');
    expect(output).toContain("const Counter = () => {");
    expect(output).toContain("_useSignals();");
    expect(output).not.toContain("try {");
    expect(output).not.toContain("finally {");
    expect(output).not.toContain(".f();");
  });

  it("reuses a direct import and leaves an explicit bare useSignals call untouched", () => {
    const annotated = compile(`
      import { useSignals as track } from "react-fine-grained-signals";
      /** @useSignals */
      export function Counter() { return <p>tracked</p>; }
    `, "manual", "inject");
    const explicit = `
      import { useSignals } from "react-fine-grained-signals";
      export function Counter() { useSignals(); return <p />; }
    `;

    expect(annotated).toContain("track();");
    expect(annotated).not.toContain("_useSignals");
    expect(compile(explicit, "manual", "inject", "react-fine-grained-signals", "off")).toBe(explicit);
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

  it("prefers the assigned binding over an unwrapped function expression's own name", () => {
    // A function expression's own name is a stack-trace label, so the binding
    // decides in both directions, wrapper or not.
    const component = compile(`
      const s = { value: 1 };
      export const Counter = function render() { return <p>{s.value}</p>; };
    `, "auto");
    const helper = compile(`
      const s = { value: 1 };
      const helper = function Counter() { return <p>{s.value}</p>; };
    `, "auto");

    expect(component).toContain("export const Counter = function render() {");
    expect(component.match(/finally/g)).toHaveLength(1);
    expect(component).toContain("_signals.f();");
    expect(helper).not.toContain("finally");
    expect(helper).not.toContain("react-fine-grained-signals/runtime");
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
    const named = compile(namedSource, "auto", "managed", "react-fine-grained-signals", "auto", "./react-compat");
    const namespaced = compile(
      namespaceSource, "auto", "managed", "react-fine-grained-signals", "auto", "./react-compat",
    );

    expect(named).toContain("const Counter = memo(() => {");
    expect(named).toContain("finally {");
    expect(namespaced).toContain("const Counter = React.memo(() => {");
    expect(namespaced).toContain("finally {");
    // Documented limitation: the default only matches a direct "react" import,
    // because a single-file transform cannot follow the re-export chain.
    expect(compile(namedSource, "auto")).not.toContain("finally");
    expect(compile(namedSource, "auto")).not.toContain("react-fine-grained-signals/runtime");
    expect(compile(namespaceSource, "auto")).not.toContain("finally");
  });

  it("keeps recognizing direct react imports when reactImportSource is configured", () => {
    const output = compile(`
      import { forwardRef, memo } from "react";
      const count = { value: 1 };
      export const MemoCounter = memo(() => <p>{count.value}</p>);
      export const RefCounter = forwardRef((props, ref) => <p ref={ref}>{count.value}</p>);
    `, "auto", "managed", "react-fine-grained-signals", "auto", "./react-compat");

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
      expect(output).not.toContain("react-fine-grained-signals/runtime");
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
    expect(output).not.toContain("react-fine-grained-signals/runtime");
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
    "transforms anonymous default-export wrappers in %s mode",
    (mode) => {
      // These used to pass straight through: an anonymous default export has no
      // binding, no key and no function `id`, so no identity resolved and the
      // export was skipped without a word -- one line away from the named form
      // above, which was transformed. The module's own file name is the name the
      // rest of the codebase imports it by, so it supplies the identity.
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

      expect(memoOutput).toContain("memo(() => {");
      expect(memoOutput).toContain("finally {");
      expect(forwardRefOutput).toContain("forwardRef((props, ref) => {");
      expect(forwardRefOutput).toContain("finally {");
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

    expect(output).not.toContain("react-fine-grained-signals/runtime");
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

  describe("value reads that are not signal reads", () => {
    // Every one of these components uses no signal at all. Counting their
    // `.value` member accesses as evidence would opt an ordinary form or event
    // component out of React Compiler memoization and wrap its render in a
    // try/finally boundary it has no use for.
    it.each([
      [
        "e.target.value in an inline change handler",
        `export function Form({ setV }) {
          return <input onChange={(e) => setV(e.target.value)} />;
        }`,
      ],
      [
        "e.target.value in a handler factored into a binding",
        `export function Form({ setV }) {
          const onChange = (e) => setV(e.target.value);
          return <input onChange={onChange} />;
        }`,
      ],
      [
        "e.currentTarget.value",
        `export function Form({ setV }) {
          return <input onInput={(e) => setV(e.currentTarget.value)} />;
        }`,
      ],
      [
        "ref.current.value",
        `export function Field({ ref, submit }) {
          const read = () => submit(ref.current.value);
          return <input ref={ref} onBlur={read} />;
        }`,
      ],
      [
        "a read confined to a useEffect callback",
        `export function Panel({ store, useEffect }) {
          useEffect(() => { console.log(store.value); }, [store]);
          return <p>panel</p>;
        }`,
      ],
      [
        "a read confined to a React.useLayoutEffect callback",
        `export function Panel({ store }) {
          React.useLayoutEffect(() => { console.log(store.value); }, [store]);
          return <p>panel</p>;
        }`,
      ],
      [
        "a read confined to a useCallback callback",
        `export function Panel({ store, useCallback }) {
          const read = useCallback(() => store.value, [store]);
          return <p onClick={read}>panel</p>;
        }`,
      ],
      [
        "a read confined to an async callback",
        `export function Panel({ store, load }) {
          const run = async () => { await load(store.value); };
          return <p>{String(run)}</p>;
        }`,
      ],
    ])("leaves a component whose only .value read is %s untransformed", (_label, source) => {
      const output = compile(source, "auto");

      expect(output).not.toContain("react-fine-grained-signals/runtime");
      expect(output).not.toContain("finally");
      expect(output).not.toContain("use no memo");
    });

    it("still tracks a genuine signal read alongside an event handler", () => {
      // The exclusions must stay narrow: a component that reads a signal in its
      // own body keeps its boundary even when it also reads `e.target.value`.
      const output = compile(`
        const count = { value: 1 };
        export function Form({ setV }) {
          return <input value={count.value} onChange={(e) => setV(e.target.value)} />;
        }
      `, "auto");

      expect(output.match(/finally/g)).toHaveLength(1);
      expect(output).toMatch(/function Form\(\{[^}]*\}\) \{\s+(?:"use no memo";\s+)?const _signals/);
    });

    it("keeps a receiver that could genuinely be a signal", () => {
      // Only `target`/`currentTarget`/`current` receivers are ruled out; an
      // element of an array or a nested prop still counts, or a real signal
      // reached through one would silently lose its subscription.
      const output = compile(`
        const items = [{ value: 1 }];
        export function First() { return <p>{items[0].value}</p>; }
        export function Nested({ props }) { return <p>{props.count.value}</p>; }
      `, "auto");

      expect(output.match(/finally/g)).toHaveLength(2);
    });
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

  it.each(["auto", "all"] as const)(
    "%s mode tracks a callback factored into a binding and passed by reference",
    (mode) => {
      const output = compile(`
        const items = [{ value: "one" }];
        export function List() {
          const Row = (item) => <li>{item.value}</li>;
          return <ul>{items.map(Row)}</ul>;
        }
      `, mode);

      // Row runs once per item inside List's single render, so a hook injected
      // into it would break hook order: List owns the read instead.
      expect(output.match(/finally/g)).toHaveLength(1);
      expect(output).toMatch(/function List\(\) \{\s+(?:"use no memo";\s+)?const _signals/);
      expect(output).toContain("const Row = item => <li>{item.value}</li>;");
    },
  );

  it.each(["auto", "all"] as const)(
    "%s mode tracks a function declaration passed by reference to an iteration method",
    (mode) => {
      const output = compile(`
        const items = [{ value: "one" }];
        function Row(item) { return <li>{item.value}</li>; }
        export function List() { return <ul>{items.map(Row)}</ul>; }
      `, mode);

      // Row runs once per item inside List's single render, so injecting a hook
      // into it breaks hook order even though it is a function declaration
      // rather than a `const` binding.
      expect(output.match(/finally/g)).toHaveLength(1);
      expect(output).toMatch(/function Row\(item\) \{\s+return <li>/);
      expect(output).toMatch(/function List\(\) \{\s+(?:"use no memo";\s+)?const _signals/);
    },
  );

  it("folds a separately defined render callback's reads into the component that runs it", () => {
    // List's own body contains neither a `.value` read nor JSX: both live in
    // Row, which List invokes once per item. Without folding Row's inspection
    // into List's, nothing in the module would subscribe.
    const output = compile(`
      const items = [{ value: "one" }];
      const Row = (item) => <li>{item.value}</li>;
      export function List() { return items.map(Row); }
    `, "auto");

    expect(output.match(/finally/g)).toHaveLength(1);
    expect(output).toContain("const Row = item => <li>{item.value}</li>;");
    expect(output).toMatch(/function List\(\) \{\s+(?:"use no memo";\s+)?const _signals/);
  });

  it("stops folding at a cycle between mutually referenced render callbacks", () => {
    const output = compile(`
      const items = [{ value: 1 }];
      function First(item) { return <li>{items.map(Second)}</li>; }
      function Second(item) { return <li>{items.map(First)}{item.value}</li>; }
      export function List() { return <ul>{items.map(First)}</ul>; }
    `, "auto");

    expect(output.match(/finally/g)).toHaveLength(1);
    expect(output).toMatch(/function First\(item\) \{\s+return <li>/);
    expect(output).toMatch(/function Second\(item\) \{\s+return <li>/);
    expect(output).toMatch(/function List\(\) \{\s+(?:"use no memo";\s+)?const _signals/);
  });

  it("recognizes optional-chained iteration calls", () => {
    const output = compile(`
      const rows = [{ value: 1 }];
      function Row(item) { return <li>{item.value}</li>; }
      export function List() { return <ul>{rows?.map(Row)}</ul>; }
      export function Inline({ items }) {
        const Cell = (item) => <li>{item.value}</li>;
        return <ul>{items?.map(Cell)}</ul>;
      }
    `, "auto");

    expect(output.match(/finally/g)).toHaveLength(2);
    expect(output).toMatch(/function Row\(item\) \{\s+return <li>/);
    expect(output).toContain("const Cell = item => <li>{item.value}</li>;");
    expect(output).toMatch(/function List\(\) \{\s+(?:"use no memo";\s+)?const _signals/);
    expect(output).toMatch(/function Inline\(\{[^}]*\}\) \{\s+(?:"use no memo";\s+)?const _signals/);
  });

  it("recognizes flatMap and forEach alongside map", () => {
    const output = compile(`
      const items = [{ value: 1 }];
      function Row(item) { return <li>{item.value}</li>; }
      export function Flat() { return <ul>{items.flatMap(Row)}</ul>; }
      export function Each() { const out = []; items.forEach(Row); return <ul>{out}</ul>; }
    `, "auto");

    expect(output.match(/finally/g)).toHaveLength(2);
    expect(output).toMatch(/function Row\(item\) \{\s+return <li>/);
    expect(output).toMatch(/function Flat\(\) \{\s+(?:"use no memo";\s+)?const _signals/);
    expect(output).toMatch(/function Each\(\) \{\s+(?:"use no memo";\s+)?const _signals/);
  });

  it.each(["map", "forEach"] as const)(
    "treats only %s's first argument as its callback, not its thisArg",
    (method) => {
      // `map`/`flatMap`/`forEach` are all `(callbackFn, thisArg?)`, so the
      // second argument is never invoked. A component parked there must keep
      // its own subscription or it silently goes stale.
      const output = compile(`
        const items = [{ value: 1 }];
        const Row = (item) => <li>{item.value}</li>;
        const Host = () => <li>{items[0].value}</li>;
        export const out = items.${method}(Row, Host);
      `, "auto");

      expect(output.match(/finally/g)).toHaveLength(1);
      expect(output).toMatch(/const Host = \(\) => \{\s+(?:"use no memo";\s+)?const _signals/);
      expect(output).toContain("const Row = item => <li>{item.value}</li>;");
    },
  );

  it.each([
    ["a non-null assertion", "Row!"],
    ["an as-expression", "Row as typeof Row"],
    ["a satisfies-expression", "Row satisfies typeof Row"],
    ["an instantiation expression", "Row<{ value: string }>"],
    ["a doubly wrapped reference", "(Row! as typeof Row)"],
  ])("looks through %s on a referenced render callback", (_label, reference) => {
    // The wrapper is erased at runtime, so `Row` is still the function `map`
    // calls once per item: it must not get a hook of its own, and its reads
    // still have to be folded into the component that runs it.
    const output = compile(`
      const items = [{ value: "one" }];
      const Row = (item) => <li>{item.value}</li>;
      export function List() { return items.map(${reference}); }
    `, "auto");

    expect(output.match(/finally/g)).toHaveLength(1);
    expect(output).toContain("const Row = item => <li>{item.value}</li>;");
    expect(output).toMatch(/function List\(\) \{\s+(?:"use no memo";\s+)?const _signals/);
  });

  it("looks through an angle-bracket type assertion in a non-JSX TypeScript module", () => {
    // `<Fn>Row` only parses where angle brackets are not JSX, so this case
    // needs a `.ts` fixture and a hook rather than a component.
    const output = transformReactFineGrainedSignals(`
      const items = [{ value: 1 }];
      const useRow = (item) => item.value;
      export function useTotal() { return items.map(<typeof useRow>useRow); }
    `, "fixture.ts", {
      importSource: "react-fine-grained-signals",
      mode: "auto",
      transform: "managed",
      reactCompiler: "auto",
      reactImportSource: "react",
    })?.code ?? "";

    expect(output.match(/finally/g)).toHaveLength(1);
    expect(output).toContain("const useRow = item => item.value;");
    expect(output).toMatch(/function useTotal\(\) \{\s+(?:"use no memo";\s+)?const _signals/);
  });

  it("looks through a non-null assertion on the iteration method itself", () => {
    const output = compile(`
      const items = [{ value: "one" }];
      const Row = (item) => <li>{item.value}</li>;
      export function List() { return items.map!(Row); }
    `, "auto");

    expect(output.match(/finally/g)).toHaveLength(1);
    expect(output).toContain("const Row = item => <li>{item.value}</li>;");
    expect(output).toMatch(/function List\(\) \{\s+(?:"use no memo";\s+)?const _signals/);
  });

  it("keeps an inline render callback wrapped in a type assertion part of its owner", () => {
    const output = compile(`
      const items = [{ value: "one" }];
      export function List() {
        return <ul>{items.map(((item) => <li>{item.value}</li>) as any)}</ul>;
      }
    `, "auto");

    expect(output.match(/finally/g)).toHaveLength(1);
    expect(output).toMatch(/function List\(\) \{\s+(?:"use no memo";\s+)?const _signals/);
  });

  it.each([
    ["an as-expression", " as any"],
    ["a non-null assertion", "!"],
    ["a satisfies-expression", " satisfies unknown"],
    ["a doubly wrapped initializer", "! as any"],
  ])("looks through %s on a referenced callback's own initializer", (_label, wrapper) => {
    // The wrapper sits between the declarator and the function it initializes,
    // so both directions have to see past it: `Row` is still the callback `map`
    // runs per item (no hook of its own), and its reads still have to reach the
    // component that runs it -- which otherwise reads no signal at all and
    // would be left untransformed too, leaving nothing subscribed.
    const output = compile(`
      const items = [{ value: "one" }];
      const Row = ((item) => <li>{item.value}</li>)${wrapper};
      export function List() { return items.map(Row); }
    `, "auto");

    expect(output.match(/finally/g)).toHaveLength(1);
    expect(output).toContain(`const Row = (item => <li>{item.value}</li>)${wrapper};`);
    expect(output).toMatch(/function List\(\) \{\s+(?:"use no memo";\s+)?const _signals/);
  });

  it("names a component through interleaved memo and type-assertion wrappers", () => {
    // The two wrapper families nest in either order, so the climb to the
    // binding that names the function has to alternate between them.
    const output = compile(`
      import { memo } from "react";
      const count = { value: 1 };
      export const Inner = memo(((props) => <p>{count.value}</p>) as any);
      export const Outer = (memo((props) => <p>{count.value}</p>)) as any;
      export const Both = (memo(((props) => <p>{count.value}</p>) as any))!;
    `, "auto");

    expect(output.match(/finally/g)).toHaveLength(3);
    expect(output).toMatch(/memo\(\(props => \{\s+(?:"use no memo";\s+)?const _signals/);
    expect(output).toMatch(/memo\(props => \{\s+(?:"use no memo";\s+)?const _signals/);
  });

  it.each(["map", "flatMap"] as const)(
    "looks through a type assertion on a computed %s property",
    (method) => {
      // Here the wrapper is around the key alone, so the callee is already a
      // plain member expression and only the property node is wrapped.
      const output = compile(`
        const items = [{ value: "one" }];
        const Row = (item) => <li>{item.value}</li>;
        export function List() { return items["${method}" as const](Row); }
      `, "auto");

      expect(output.match(/finally/g)).toHaveLength(1);
      expect(output).toContain("const Row = item => <li>{item.value}</li>;");
      expect(output).toMatch(/function List\(\) \{\s+(?:"use no memo";\s+)?const _signals/);
    },
  );

  it("keeps a wrapped memo or HOC reference from counting as a render callback", () => {
    // Unwrapping the transparent wrappers must not widen the exclusion: neither
    // `memo` nor a third-party HOC is an iteration method, so both keep their
    // wrapped component eligible for its own hook.
    const output = compile(`
      import { memo } from "react";
      const count = { value: 1 };
      function observer(Component) { return Component; }
      const Row = () => <li>{count.value}</li>;
      const Cell = () => <li>{count.value}</li>;
      export const MemoRow = memo(Row!);
      export default observer(Cell as typeof Cell);
    `, "auto");

    expect(output.match(/finally/g)).toHaveLength(2);
    expect(output).toMatch(/const Row = \(\) => \{\s+(?:"use no memo";\s+)?const _signals/);
    expect(output).toMatch(/const Cell = \(\) => \{\s+(?:"use no memo";\s+)?const _signals/);
  });

  it("keeps predicate iteration methods out of the recognized set", () => {
    // `filter`/`find`/`some` take predicates, not element renderers, so a
    // component-shaped callback handed to one is far likelier to be a call on
    // an unrelated user-defined method than a genuine render callback. Keeping
    // the set minimal avoids denying a real component its subscription.
    const output = compile(`
      const items = [{ value: 1 }];
      const Row = (item) => <li>{item.value}</li>;
      export const kept = items.filter(Row);
    `, "auto");

    expect(output.match(/finally/g)).toHaveLength(1);
    expect(output).toMatch(/const Row = item => \{\s+(?:"use no memo";\s+)?const _signals/);
  });

  it("keeps a component referenced by a third-party HOC eligible", () => {
    // `observer(Row)` / `connect(...)(Row)` register an independent component
    // that React instantiates as its own fiber, so Row must keep its own hook.
    const output = compile(`
      const count = { value: 1 };
      function observer(Component) { return Component; }
      function connect() { return (Component) => Component; }
      const Row = () => <li>{count.value}</li>;
      const Cell = () => <li>{count.value}</li>;
      export default observer(Row);
      export const ConnectedCell = connect()(Cell);
    `, "auto");

    expect(output.match(/finally/g)).toHaveLength(2);
    expect(output).toMatch(/const Row = \(\) => \{\s+(?:"use no memo";\s+)?const _signals/);
    expect(output).toMatch(/const Cell = \(\) => \{\s+(?:"use no memo";\s+)?const _signals/);
    expect(output).toContain("export default observer(Row);");
    expect(output).toContain("export const ConnectedCell = connect()(Cell);");
  });

  it("keeps forwardRef and namespaced memo references from counting as render callbacks", () => {
    const output = compile(`
      import * as React from "react";
      import { forwardRef } from "react";
      const count = { value: 1 };
      const Row = () => <li>{count.value}</li>;
      const Ref = (props, ref) => <li ref={ref}>{count.value}</li>;
      export const MemoRow = React.memo(Row);
      export const RefRow = forwardRef(Ref);
    `, "auto");

    expect(output.match(/finally/g)).toHaveLength(2);
    expect(output).toMatch(/const Row = \(\) => \{\s+(?:"use no memo";\s+)?const _signals/);
    expect(output).toMatch(/const Ref = \(props, ref\) => \{\s+(?:"use no memo";\s+)?const _signals/);
  });

  it.each(["auto", "all"] as const)(
    "%s mode leaves memo's areEqual comparator alone",
    (mode) => {
      // React calls `areEqual` during reconciliation, outside any component's
      // render, so a hook injected into it throws "Invalid hook call" on the
      // first re-render. Only argument 0 of memo() is the component.
      const output = compile(`
        import { memo } from "react";
        const count = { value: 1 };
        const Row = (props) => <li>{count.value}</li>;
        export const MemoRow = memo(Row, (a, b) => a.id === b.id);
      `, mode);

      expect(output.match(/finally/g)).toHaveLength(1);
      expect(output).toMatch(/const Row = props => \{\s+(?:"use no memo";\s+)?const _signals/);
      expect(output).toContain("memo(Row, (a, b) => a.id === b.id)");
    },
  );

  it("leaves memo's comparator alone even under an explicit annotation", () => {
    // The annotation names the wrapped component, and the comparator must not
    // inherit that identity by sitting in the same call.
    const output = compile(`
      import { memo } from "react";
      /** @useSignals */
      export const MemoRow = memo((props) => <li />, (a, b) => a.id === b.id);
    `);

    expect(output.match(/finally/g)).toHaveLength(1);
    expect(output).toContain("(a, b) => a.id === b.id");
  });

  it.each(["auto", "all"] as const)(
    "%s mode tracks a component called directly inside a render callback",
    (mode) => {
      // `items.map((i) => Row(i))` calls Row as a plain function once per item
      // inside List's single render: React never mounts it, so hooks injected
      // into it would run in a loop and crash with "Rendered more hooks than
      // during the previous render". List owns the read instead.
      const output = compile(`
        const items = [{ value: 1 }];
        function Row(item) { return <li>{item.value}</li>; }
        export function List() { return <ul>{items.map((i) => Row(i))}</ul>; }
      `, mode);

      expect(output.match(/finally/g)).toHaveLength(1);
      expect(output).toMatch(/function Row\(item\) \{\s+return <li>/);
      expect(output).toMatch(/function List\(\) \{\s+(?:"use no memo";\s+)?const _signals/);
    },
  );

  it.each(["auto", "all"] as const)(
    "%s mode tracks a hook called directly inside a render callback",
    (mode) => {
      // The render-callback exclusion demotes by position, never by name, so a
      // `useX`-named helper called once per item loses the boundary its hook
      // identity would otherwise have earned it -- exactly as the
      // component-shaped callee above does. Folding its read into List is the
      // only thing left that can subscribe: the by-reference twin
      // (`items.map(useLabel)`) already does, and the direct-call form must not
      // silently differ from it.
      const output = compile(`
        const count = { value: 1 };
        const items = [1];
        const useLabel = (item) => count.value + item;
        export function List() {
          return <ul>{items.map((item) => <li>{useLabel(item)}</li>)}</ul>;
        }
      `, mode);

      expect(output.match(/finally/g)).toHaveLength(1);
      expect(output).toContain("const useLabel = item => count.value + item;");
      expect(output).toMatch(/function List\(\) \{\s+(?:"use no memo";\s+)?const _signals/);
    },
  );

  it("keeps a component called from an event handler inside a render callback eligible", () => {
    // The call sits in an onClick handler, not in the render callback's own
    // body, so it is not a per-item render call and Row keeps its own boundary.
    const output = compile(`
      const count = { value: 1 };
      const items = [1];
      const Row = (item) => <li>{count.value}</li>;
      export function List() {
        return <ul>{items.map((i) => <button onClick={() => Row(i)} />)}</ul>;
      }
    `, "auto");

    expect(output).toMatch(/const Row = item => \{\s+(?:"use no memo";\s+)?const _signals/);
  });

  it("documents the JSX render-prop limitation and the inline workaround", () => {
    // A bare identifier in a JSX attribute is syntactically identical whether
    // the receiver instantiates it as a component or calls it per item, so a
    // referenced callback keeps its own hook (known limitation), while the
    // recommended inline form is collected by the component that owns it.
    const referenced = compile(`
      const count = { value: 1 };
      const Row = (item) => <li>{item.value}</li>;
      export function List() { return <Grid renderItem={Row} />; }
    `, "auto");
    const inline = compile(`
      export function List() {
        return <Grid renderItem={(item) => <li>{item.value}</li>} />;
      }
    `, "auto");

    expect(referenced.match(/finally/g)).toHaveLength(1);
    expect(referenced).toMatch(/const Row = item => \{\s+(?:"use no memo";\s+)?const _signals/);
    expect(inline.match(/finally/g)).toHaveLength(1);
    expect(inline).toMatch(/function List\(\) \{\s+(?:"use no memo";\s+)?const _signals/);
    expect(inline).toContain("renderItem={item => <li>{item.value}</li>}");
  });

  it("still transforms a component referenced by name into memo", () => {
    const output = compile(`
      import { memo } from "react";
      const count = { value: 1 };
      const Row = () => <li>{count.value}</li>;
      export const MemoRow = memo(Row);
    `, "auto");

    expect(output.match(/finally/g)).toHaveLength(1);
    expect(output).toMatch(/const Row = \(\) => \{\s+(?:"use no memo";\s+)?const _signals/);
    expect(output).toContain("export const MemoRow = memo(Row);");
  });

  it("still transforms a nested component referenced only through JSX", () => {
    const output = compile(`
      const count = { value: 1 };
      export function List() {
        const Row = () => <li>{count.value}</li>;
        return <ul><Row /></ul>;
      }
    `, "auto");

    expect(output.match(/finally/g)).toHaveLength(1);
    expect(output).toMatch(/const Row = \(\) => \{\s+(?:"use no memo";\s+)?const _signals/);
    expect(output).toMatch(/export function List\(\) \{\s+const Row/);
  });

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

  describe("anonymous component returned from a HOC factory", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("auto-detects the component a concise-body factory returns", () => {
      // The inner arrow is the real component, but its only identity comes
      // from being what `withCount` returns. Unresolved, it used to be no
      // candidate at all: no boundary, no warning, and a signal write that
      // silently stopped re-rendering it.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const output = compile(`
        const count = { value: 1 };
        export const withCount = (Base) => (props) => <Base {...props} count={count.value} />;
      `, "auto");

      expect(output.match(/finally/g)).toHaveLength(1);
      expect(output).toMatch(
        /const withCount = Base => props => \{\s+(?:"use no memo";\s+)?const _signals/,
      );
      expect(warn).not.toHaveBeenCalled();
    });

    it("auto-detects the component a block-bodied factory returns", () => {
      // The same identity, reached through every other shape the returned
      // function can take: a block-bodied arrow, an explicit `return`, and an
      // anonymous function expression.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const output = compile(`
        const count = { value: 1 };
        export const withBlock = (Base) => (props) => {
          return <Base {...props} count={count.value} />;
        };
        export function withReturn(Base) {
          return (props) => <Base {...props} count={count.value} />;
        }
        export function withExpression(Base) {
          return function (props) {
            return <Base {...props} count={count.value} />;
          };
        }
      `, "auto");

      expect(output.match(/finally/g)).toHaveLength(3);
      // Only the returned components are wrapped; the factories keep their
      // bodies, which React never renders.
      expect(output).toMatch(/const withBlock = Base => props => \{\s+(?:"use no memo";\s+)?const _signals/);
      expect(output).toMatch(/function withReturn\(Base\) \{\s+return props => \{/);
      expect(output).toMatch(/function withExpression\(Base\) \{\s+return function \(props\) \{/);
      expect(warn).not.toHaveBeenCalled();
    });

    it("derives the identity through a memo wrapper without adopting its comparator", () => {
      // The returned component is still reached through React's own wrappers,
      // and argument 0 is still the only one that may inherit an identity:
      // `areEqual` runs during reconciliation, outside any render.
      const output = compile(`
        import { memo } from "react";
        const count = { value: 1 };
        export const withCount = (Base) =>
          memo((props) => <Base {...props} count={count.value} />, (a, b) => a.id === b.id);
      `, "auto");

      expect(output.match(/finally/g)).toHaveLength(1);
      expect(output).toMatch(/memo\(props => \{\s+(?:"use no memo";\s+)?const _signals/);
      expect(output).toContain("(a, b) => a.id === b.id");
    });

    it("still gates on the auto-mode signal-read heuristic", () => {
      // Identity resolution is all this fixes: a returned component with no
      // `.value` read is still nothing for `auto` mode to subscribe, while
      // `all` mode wraps it as it does any other component.
      // `count` exists but is never read by the component, so the file still
      // gets past the pre-parse screen and the decision is the AST's.
      const source = `
        const count = { value: 1 };
        export const withCount = (Base) => (props) => <Base {...props} />;
      `;

      expect(compile(source, "auto")).toBe(source);
      expect(compile(source, "all").match(/finally/g)).toHaveLength(1);
    });

    it("attributes an annotation on the returned component to it", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const output = compile(`
        const count = { value: 1 };
        export function withCount(Base) {
          /** @useSignals */
          return (props) => <Base {...props} count={count.value} />;
        }
      `);

      expect(output.match(/finally/g)).toHaveLength(1);
      expect(output).toMatch(/return props => \{\s+(?:"use no memo";\s+)?const _signals/);
      expect(warn).not.toHaveBeenCalled();
    });

    it("attributes an annotation on the factory to the component it returns", () => {
      // A factory is never a component itself, so an annotation written on its
      // declaration can only mean the component it hands back -- in both the
      // concise form (where the comment climb already reached the inner arrow)
      // and the block-bodied one (where it stops at the `return`).
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const output = compile(`
        const count = { value: 1 };
        /** @useSignals */
        export const withConcise = (Base) => (props) => <Base {...props} count={count.value} />;
        /** @useSignals */
        export function withBlock(Base) {
          return (props) => <Base {...props} count={count.value} />;
        }
      `);

      expect(output.match(/finally/g)).toHaveLength(2);
      expect(output).toMatch(
        /const withConcise = Base => props => \{\s+(?:"use no memo";\s+)?const _signals/,
      );
      expect(output).toMatch(/function withBlock\(Base\) \{\s+return props => \{/);
      expect(warn).not.toHaveBeenCalled();
    });

    it("honors a @noUseSignals opt-out written on the factory", () => {
      const output = compile(`
        const count = { value: 1 };
        /** @noUseSignals */
        export function withCount(Base) {
          return (props) => <Base {...props} count={count.value} />;
        }
      `, "auto");

      expect(output).not.toContain("finally");
    });

    it("leaves a factory that returns a plain closure alone", () => {
      // Nothing here renders anything, so nothing may be mistaken for a
      // component: a hook injected into a closure React never mounts throws
      // "Invalid hook call" the first time it is called.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const source = `
        const count = { value: 1 };
        export const readCount = (fallback) => () => count.value ?? fallback;
        export function makeAdder(a) {
          return (b) => a + b.value;
        }
      `;

      expect(compile(source, "auto")).toBe(source);
      expect(compile(source, "all")).toBe(source);
      expect(warn).not.toHaveBeenCalled();
    });

    it("keeps a function returned by a component or a hook off its own boundary", () => {
      // A function returned by a component or a hook is a render prop or a
      // callback that runs inside that owner's render, not an independently
      // mounted component, so the owner keeps the one boundary.
      const output = compile(`
        const count = { value: 1 };
        export function List() { return () => <li>{count.value}</li>; }
        export function useRow() { return () => <li>{count.value}</li>; }
      `, "auto");

      expect(output.match(/finally/g)).toHaveLength(2);
      expect(output.match(/return \(\) => <li>\{count\.value\}<\/li>;/g)).toHaveLength(2);
    });

    it("leaves a factory of factories unresolved rather than guessing", () => {
      // Derivation reaches exactly one level out, to a real binding. The middle
      // function has no name to inherit and renders nothing itself, so neither
      // it nor the component below it is transformed.
      const output = compile(`
        const count = { value: 1 };
        export const makeHoc = () => (Base) => (props) => <Base {...props} count={count.value} />;
      `, "auto");

      expect(output).not.toContain("finally");
    });
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

    expect(auto).not.toContain("react-fine-grained-signals/runtime");
    expect(auto).not.toContain("finally");
    expect(all).not.toContain("react-fine-grained-signals/runtime");
    expect(all).not.toContain("finally");
  });

  it("rejects explicit or annotated async opt-in", () => {
    expect(() => compile(`
      import { useSignals } from "react-fine-grained-signals";
      export async function Explicit() { useSignals(); return <p />; }
    `)).toThrow("only supports synchronous, non-generator functions");

    expect(() => compile(`
      /** @useSignals */
      export async function Annotated() { return <p />; }
    `)).toThrow("only supports synchronous, non-generator functions");
  });

  it("does not turn a late explicit useSignals call into a second hook", () => {
    const output = compile(`
      import { useSignals } from "react-fine-grained-signals";
      const count = { value: 1 };
      export function App() { const prefix = "v"; useSignals(); return <p>{prefix}{count.value}</p>; }
    `, "auto");

    expect(output).not.toContain("react-fine-grained-signals/runtime");
    expect(output).toContain("useSignals();");
  });

  it("recognizes existing namespace and barrel-imported useSignals calls", () => {
    const namespaceSource = `
      import * as signals from "react-fine-grained-signals";
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

  describe("first-statement barrel useSignals() call", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("warns and leaves the component on the bare best-effort boundary", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // useSignals is re-exported through a local barrel module rather than
      // imported directly from the package, so a single-file transform cannot
      // verify it is this library's own useSignals -- but it is called as the
      // very first statement, exactly the shape of a deliberate explicit
      // opt-in, so a developer relying on it would otherwise never learn they
      // did not get the verified/managed boundary.
      const barrelFirstStatementSource = `
        import { useSignals } from "./signals.js";
        export function Counter({ count }) {
          useSignals();
          return <button>{count.value}</button>;
        }
      `;

      const managedOutput = compile(barrelFirstStatementSource, "manual", "managed");
      expect(managedOutput).toBe(barrelFirstStatementSource);
      expect(managedOutput).not.toContain("try {");
      expect(managedOutput).not.toContain("finally {");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("cannot be verified");
      expect(warn.mock.calls[0]?.[0]).toContain("barrel");
      expect(warn.mock.calls[0]?.[0]).toContain("react-fine-grained-signals");

      warn.mockClear();
      const injectOutput = compile(barrelFirstStatementSource, "manual", "inject");
      expect(injectOutput).toBe(barrelFirstStatementSource);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("does not warn for a directly imported explicit useSignals call", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      compile(`
        import { useSignals } from "react-fine-grained-signals";
        export function Counter({ count }) {
          useSignals();
          return <button>{count.value}</button>;
        }
      `);

      expect(warn).not.toHaveBeenCalled();
    });

    it("does not warn when the barrel call is not the function's first statement", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      compile(`
        import { useSignals as track } from "./signals.js";
        const count = { value: 1 };
        export function App() { const prefix = "v"; track(); return <p>{prefix}{count.value}</p>; }
      `, "auto", "managed");

      expect(warn).not.toHaveBeenCalled();
    });

    it("verifies a useSignals imported from the /runtime entry point", () => {
      // `<importSource>/runtime` is a first-party entry point this plugin emits
      // itself, so a bare call imported from it is a verified opt-in. Rejecting
      // it produced a warning telling the author to import from exactly where
      // they already had, and left the file untransformed.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const output = compile(`
        import { useSignals } from "react-fine-grained-signals/runtime";
        const count = { value: 1 };
        export function App() { useSignals(); return <p>{count.value}</p>; }
      `);

      expect(warn).not.toHaveBeenCalled();
      expect(output.match(/finally/g)).toHaveLength(1);
      // The author's own import is reused rather than a second one added.
      expect(output).toContain("const _signals = useSignals();");
      expect(output).not.toContain("_useSignals");
    });

    it("verifies a namespaced useSignals call from the /runtime entry point", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const output = compile(`
        import * as runtime from "react-fine-grained-signals/runtime";
        const count = { value: 1 };
        export function App() { runtime.useSignals(); return <p>{count.value}</p>; }
      `);

      expect(warn).not.toHaveBeenCalled();
      expect(output.match(/finally/g)).toHaveLength(1);
    });

    it("warns when an annotation lands on a function it cannot name", () => {
      // Identity derivation reaches one level out, to the enclosing factory's
      // own binding. Here the annotated arrow is returned by a *middle*
      // function that has no binding of its own either, so there is still no
      // name to attach a boundary to and the annotation is dropped -- loudly.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const output = compile(`
        const count = { value: 1 };
        export function makeHoc() {
          return (Base) => {
            /** @useSignals */
            return (props) => <Base {...props} count={count.value} />;
          };
        }
      `);

      expect(output).not.toContain("finally");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("@useSignals annotation is ignored");
    });

    it("does not warn about an annotation an enclosing component already owns", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      compile(`
        /** @useSignals */
        export function App() {
          const items = [1];
          return <ul>{items.map(() => <li />)}</ul>;
        }
      `);

      expect(warn).not.toHaveBeenCalled();
    });

    it("does not warn about an annotation on a named-but-lowercase function", () => {
      // `callback` and `helper` both have an identity; it is simply not a
      // component or a hook, and that is a deliberate, already-documented no-op
      // rather than a mistake.
      //
      // The `identity === undefined` half of the warning's guard is what keeps
      // them quiet, and it is load-bearing beyond this case: an annotated HOC
      // factory ("attributes an annotation on the factory to the component it
      // returns", above) is also a lowercase-named candidate whose `annotated`
      // is false, so warning on `annotation && !annotated` alone would report
      // "this annotation is ignored" for an annotation the returned component
      // does honor. Name shape cannot separate the two -- a factory is
      // camelCase by definition -- so the warning stays on the genuinely
      // unnameable case only.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      compile(`
        const count = { value: 1 };
        /** @useSignals */
        export function callback() { return count.value; }
        /** @useSignals */
        export const helper = () => { return count.value + 1; };
      `);

      expect(warn).not.toHaveBeenCalled();
    });
  });

  it("drops the import left dead by absorbing an explicit useSignals call", () => {
    // The managed boundary replaces the author's call with its own store
    // declaration, so the non-runtime entry point it came from is no longer
    // referenced and must not stay in the bundle graph.
    const output = compile(`
      import { useSignals } from "react-fine-grained-signals";
      const count = { value: 1 };
      export function App() { useSignals(); return <p>{count.value}</p>; }
    `);

    expect(output).toContain('from "react-fine-grained-signals/runtime"');
    expect(output).not.toContain('from "react-fine-grained-signals"');
    expect(output.match(/finally/g)).toHaveLength(1);
  });

  it("keeps an absorbed import that something else still uses", () => {
    const output = compile(`
      import { useSignals } from "react-fine-grained-signals";
      const count = { value: 1 };
      export const escaped = useSignals;
      export function App() { useSignals(); return <p>{count.value}</p>; }
    `);

    expect(output).toContain('from "react-fine-grained-signals"');
    expect(output).toContain("export const escaped = useSignals;");
  });

  it("keeps other specifiers of a partially absorbed import declaration", () => {
    const output = compile(`
      import { signal, useSignals } from "react-fine-grained-signals";
      const count = signal(1);
      export function App() { useSignals(); return <p>{count.value}</p>; }
    `);

    expect(output).toContain('import { signal } from "react-fine-grained-signals"');
    expect(output).not.toContain("signal, useSignals");
  });

  it("parses class auto-accessors rather than failing the build", () => {
    const options = {
      importSource: "react-fine-grained-signals",
      mode: "auto" as const,
      transform: "managed" as const,
      reactCompiler: "auto" as const,
      reactImportSource: "react",
    };
    const source = "const count = { value: 1 }; class Store { @dec accessor x = 1; }";

    expect(() => transformReactFineGrainedSignals(source, "fixture.ts", options)).not.toThrow();
    expect(() => transformReactFineGrainedSignals(source, "fixture.tsx", options)).not.toThrow();
    expect(() => transformReactFineGrainedSignals(source, "fixture.jsx", options)).not.toThrow();
  });

  it("names the source map's original file without a bundler query string", () => {
    const result = transformReactFineGrainedSignals(
      "const count = { value: 1 }; export const App = () => <p>{count.value}</p>;",
      "/project/src/App.tsx?t=1730000000",
      {
        importSource: "react-fine-grained-signals",
        mode: "auto",
        transform: "managed",
        reactCompiler: "auto",
        reactImportSource: "react",
      },
    );

    expect(result?.map).toBeTruthy();
    expect((result?.map as { sources: string[] } | undefined)?.sources)
      .toEqual(["/project/src/App.tsx"]);
  });

  it("skips the parse entirely for files nothing can apply to", () => {
    const options = {
      importSource: "react-fine-grained-signals",
      transform: "managed" as const,
      reactCompiler: "auto" as const,
      reactImportSource: "react",
    };
    // Syntax the configured parser cannot handle at all: reaching the parser
    // would throw, so returning null proves the raw-text screen ran first.
    const unparsable = "const a = 1 +* 2;";

    expect(
      transformReactFineGrainedSignals(unparsable, "fixture.tsx", { ...options, mode: "manual" }),
    ).toBeNull();
    expect(
      transformReactFineGrainedSignals(unparsable, "fixture.tsx", { ...options, mode: "auto" }),
    ).toBeNull();
    expect(
      transformReactFineGrainedSignals(unparsable, "fixture.tsx", { ...options, mode: "all" }),
    ).toBeNull();
    // A file the screen lets through still parses and transforms as before.
    expect(
      transformReactFineGrainedSignals(
        "const count = { value: 1 }; export const App = () => <p>{count.value}</p>;",
        "fixture.tsx",
        { ...options, mode: "auto" },
      )?.code,
    ).toContain("finally");
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
      importSource: "react-fine-grained-signals",
      mode: "auto" as const,
      transform: "inject" as const,
      reactCompiler: "auto" as const,
      reactImportSource: "react",
    };

    expect(
      transformReactFineGrainedSignals("const value = <string>input;", "fixture.ts", options),
    ).toBeNull();
    expect(transformReactFineGrainedSignals("@sealed class Store {}", "fixture.ts", options)).toBeNull();
    expect(
      transformReactFineGrainedSignals(
        "const count = { value: 1 }; export const App = () => <p>{count.value}</p>;",
        "fixture.js",
        options,
      )?.code,
    ).toContain("_useSignals();");
  });

  it("does not reuse a type-only runtime import or a shadowed runtime alias", () => {
    const typeOnly = compile(`
      import { useSignals } from "react-fine-grained-signals";
      import type { useSignals as managed } from "react-fine-grained-signals/runtime";
      export function App() { useSignals(); return <main />; }
    `);
    const shadowed = compile(`
      import { useSignals } from "react-fine-grained-signals";
      import { useSignals as managed } from "react-fine-grained-signals/runtime";
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
      expect(compile(autoSource, "auto", transform, "react-fine-grained-signals", "off"))
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
      import { useSignals } from "react-fine-grained-signals";
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

describe("PascalCase higher-order component factories", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("puts the boundary on the returned component, not on the factory itself", () => {
    // The blocker this policy exists for. The factory is PascalCase, and the
    // component it returned owned no identity -- so its JSX and `.value` read
    // were credited to the factory's own body and the boundary was injected
    // there. `WithCount(Foo)` is called at module scope, where there is no React
    // dispatcher, so that boundary threw at import time.
    const concise = compile(`
      const count = { value: 1 };
      export const WithCount = (Base) => (props) => <Base n={count.value} />;
    `, "auto");
    const block = compile(`
      const count = { value: 1 };
      export function WithCount(Base) { return (props) => <Base n={count.value} />; }
    `, "auto");

    expect(concise.match(/finally/g)).toHaveLength(1);
    expect(concise).toMatch(
      /const WithCount = Base => props => \{\s+(?:"use no memo";\s+)?const _signals/,
    );
    expect(block.match(/finally/g)).toHaveLength(1);
    expect(block).toMatch(/function WithCount\(Base\) \{\s+return props => \{/);
  });

  it("keeps a PascalCase factory off a boundary in all mode, which needs no signal read", () => {
    // `all` mode wraps every component-named function that contains JSX, so
    // before the factory was recognized as one, every PascalCase HOC in a
    // codebase broke at import time without reading a signal at all.
    const output = compile(`
      const count = { value: 1 };
      export const WithCount = (Base) => (props) => <Base />;
    `, "all");

    expect(output.match(/finally/g)).toHaveLength(1);
    expect(output).toMatch(
      /const WithCount = Base => props => \{\s+(?:"use no memo";\s+)?const _signals/,
    );
  });

  it("recognizes the factory by its parameter, not by what the returned component renders", () => {
    // The discriminator is the PascalCase *parameter*: React calls a component
    // with `(props)` and a render function with `(props, ref)`, so a PascalCase
    // identifier parameter is a component being handed in, which only a factory
    // receives. That holds whether or not the returned component renders the
    // argument directly, which an alias or a spread would hide.
    const output = compile(`
      const count = { value: 1 };
      export const WithCount = (Base) => (props) => <div>{count.value}</div>;
    `, "auto");

    expect(output.match(/finally/g)).toHaveLength(1);
    expect(output).toMatch(
      /const WithCount = Base => props => \{\s+(?:"use no memo";\s+)?const _signals/,
    );
  });

  it("attributes an annotation on a PascalCase factory to the component it returns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const concise = compile(`
      const count = { value: 1 };
      /** @useSignals */
      export const WithCount = (Base) => (props) => <Base n={count.value} />;
    `);
    const block = compile(`
      const count = { value: 1 };
      /** @useSignals */
      export function WithBlock(Base) { return (props) => <Base n={count.value} />; }
    `);

    // Exactly one boundary each: the factory must not take the annotation for
    // itself now that the component it returns can honor it.
    expect(concise.match(/finally/g)).toHaveLength(1);
    expect(concise).toMatch(
      /const WithCount = Base => props => \{\s+(?:"use no memo";\s+)?const _signals/,
    );
    expect(block.match(/finally/g)).toHaveLength(1);
    expect(block).toMatch(/function WithBlock\(Base\) \{\s+return props => \{/);
    expect(warn).not.toHaveBeenCalled();
  });

  it("honors a @noUseSignals opt-out written on a PascalCase factory", () => {
    const output = compile(`
      const count = { value: 1 };
      /** @noUseSignals */
      export const WithCount = (Base) => (props) => <Base n={count.value} />;
    `, "all");

    expect(output).not.toContain("finally");
  });

  it("leaves an author's own useSignals() call in a factory alone", () => {
    // The factory rule withholds the inferred routes -- `auto`, `all` and the
    // annotation. A hand-written call is a statement about the author's own
    // code, and this transform never second-guesses one.
    const output = compile(`
      import { useSignals } from "react-fine-grained-signals";
      const count = { value: 1 };
      export function WithCount(Base) {
        useSignals();
        return (props) => <Base n={count.value} />;
      }
    `);

    expect(output.match(/finally/g)).toHaveLength(1);
    expect(output).toMatch(/function WithCount\(Base\) \{\s+(?:"use no memo";\s+)?const _signals/);
  });

  it("still treats a function whose parameters look ordinary as a component", () => {
    // A destructured prop is an ObjectPattern, not an identifier parameter, so
    // `<Icon />` coming in as a prop leaves `Card` a component; and a function
    // that renders JSX itself is a component whatever its parameters are named.
    const output = compile(`
      const count = { value: 1 };
      export function Card({ Icon }) { return <Icon>{count.value}</Icon>; }
      export function Panel(Base) { return <p>{count.value}</p>; }
    `, "auto");

    expect(output.match(/finally/g)).toHaveLength(2);
  });

  it("gives a useX name no identity-inheritance escape hatch, and still transforms the hook", () => {
    // React calls a hook from inside a render already in progress, so anything
    // it hands back may be invoked during that same render. No structural
    // evidence here can rule that out, so the returned function stays
    // unresolved rather than getting a boundary that would be an invalid hook
    // call.
    //
    // The hook itself is a different question, and the factory rule must not
    // answer it: standing a factory down is justified by React never calling it
    // during a render, which is exactly what React *does* do to a hook. So the
    // one boundary here goes on `useRow`, precisely as it did before the
    // PascalCase-factory policy existed.
    const output = compile(`
      const count = { value: 1 };
      export const useRow = (Base) => (props) => <Base n={count.value} />;
    `, "all");

    expect(output.match(/finally/g)).toHaveLength(1);
    expect(output).toMatch(/const useRow = Base => \{\s+(?:"use no memo";\s+)?const _signals/);
    expect(output).toContain("return props => <Base n={count.value} />;");
  });

  it("keeps transforming a hook that takes a component-shaped parameter", () => {
    // The regression the hook exemption exists for: `useModal` takes a
    // component-shaped parameter and renders no JSX, which is the factory shape
    // exactly -- but it is a hook, so `auto` mode and an annotation both still
    // reach it. Skipping it was silent in both directions: no boundary, and no
    // warning either, since the annotation report is gated on rendering JSX.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const auto = compile(`
      const count = { value: 1 };
      export function useModal(Overlay) {
        const n = count.value;
        return { open: () => n, Overlay };
      }
    `, "auto");
    const annotated = compile(`
      const count = { value: 1 };
      /** @useSignals */
      export function useModal(Overlay) {
        const n = count.value;
        return { open: () => n, Overlay };
      }
    `);

    expect(auto.match(/finally/g)).toHaveLength(1);
    expect(auto).toMatch(/function useModal\(Overlay\) \{\s+(?:"use no memo";\s+)?const _signals/);
    expect(annotated.match(/finally/g)).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("recognizes a factory whose component parameter carries a default value", () => {
    // `(Base = Fallback)` is an AssignmentPattern wrapping the identifier, not
    // an identifier -- so matching only identifiers let a defaulted parameter
    // fall through and put the factory straight back in front of the
    // import-time crash the whole policy exists to prevent.
    const output = compile(`
      const count = { value: 1 };
      const Fallback = () => <p />;
      export const WithCount = (Base = Fallback) => (props) => <Base n={count.value} />;
    `, "auto");

    expect(output).toMatch(
      /const WithCount = \(Base = Fallback\) => props => \{\s+(?:"use no memo";\s+)?const _signals/,
    );
    // `Fallback` renders JSX but reads no signal, so `auto` leaves it alone and
    // the returned component owns the file's only boundary.
    expect(output.match(/finally/g)).toHaveLength(1);
  });

  it("leaves a factory whose returned component is separately named alone", () => {
    // `inner` is a real binding, and a lowercase one, so it is not a component
    // and inherits nothing. Nothing is transformed: the factory is excluded by
    // its parameter and the closure by its name. That is the stale-UI direction,
    // which is the recoverable one.
    const source = `
      const count = { value: 1 };
      export const WithCount = (Base) => {
        const inner = (props) => <Base n={count.value} />;
        return inner;
      };
    `;

    expect(compile(source, "auto")).toBe(source);
    expect(compile(source, "all")).toBe(source);
  });

  it("keeps the two fixes this subsystem was already patched for intact", () => {
    // Locks in commit 9fbda5a (a component returned from a camelCase factory is
    // named by that factory) and commit 74b20e0 (a hook called directly inside a
    // render callback is demoted and its reads folded into the owner), which the
    // PascalCase policy above reaches into the very same code paths for.
    const camelCaseFactory = compile(`
      const count = { value: 1 };
      export const withCount = (Base) => (props) => <Base {...props} count={count.value} />;
    `, "auto");
    const hookInRenderCallback = compile(`
      const count = { value: 1 };
      const items = [1];
      const useLabel = (item) => count.value + item;
      export function List() {
        return <ul>{items.map((item) => <li>{useLabel(item)}</li>)}</ul>;
      }
    `, "auto");

    expect(camelCaseFactory.match(/finally/g)).toHaveLength(1);
    expect(camelCaseFactory).toMatch(
      /const withCount = Base => props => \{\s+(?:"use no memo";\s+)?const _signals/,
    );
    expect(hookInRenderCallback.match(/finally/g)).toHaveLength(1);
    expect(hookInRenderCallback).toContain("const useLabel = item => count.value + item;");
    expect(hookInRenderCallback).toMatch(
      /function List\(\) \{\s+(?:"use no memo";\s+)?const _signals/,
    );
  });
});

describe("anonymous default exports", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["auto", "all"] as const)("transforms an anonymous default export in %s mode", (mode) => {
    // No binding, no key and no function `id`, so no identity resolved and both
    // modes skipped these in silence -- while the named `export default function
    // App()` one line away was transformed.
    const arrow = compile(`
      const count = { value: 1 };
      export default (props) => <p>{count.value}</p>;
    `, mode);
    const expression = compile(`
      const count = { value: 1 };
      export default function () { return <p>{count.value}</p>; }
    `, mode);

    expect(arrow.match(/finally/g)).toHaveLength(1);
    expect(arrow).toMatch(/export default props => \{\s+(?:"use no memo";\s+)?const _signals/);
    expect(expression.match(/finally/g)).toHaveLength(1);
    expect(expression).toMatch(
      /export default function \(\) \{\s+(?:"use no memo";\s+)?const _signals/,
    );
  });

  it("derives the identity from the module's file name, punctuation and all", () => {
    // Only the *shape* of the derived name is ever used -- it classifies the
    // export through the PascalCase convention and is never emitted -- so a
    // kebab-case module name and a bundler query string both resolve cleanly.
    const output = transformReactFineGrainedSignals(
      "const count = { value: 1 }; export default (props) => <p>{count.value}</p>;",
      "/project/src/my-widget.tsx?t=1730000000",
      {
        importSource: "react-fine-grained-signals",
        mode: "auto",
        transform: "managed",
        reactCompiler: "auto",
        reactImportSource: "react",
      },
    )?.code;

    expect(output).toContain("finally {");
  });

  it("leaves a non-component default export alone", () => {
    const source = `
      const count = { value: 1 };
      export default (a, b) => a.value + b.value;
    `;

    expect(compile(source, "all")).toBe(source);
  });

  it("reports an anonymous default export whose module name yields no identifier", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const source = "const count = { value: 1 }; export default (props) => <p>{count.value}</p>;";
    const options = {
      importSource: "react-fine-grained-signals",
      mode: "auto" as const,
      transform: "managed" as const,
      reactCompiler: "auto" as const,
      reactImportSource: "react",
    };

    expect(transformReactFineGrainedSignals(source, "123.tsx", options)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("anonymous default export is left untransformed");

    // `manual` mode transforms nothing on its own, so it has nothing to report.
    warn.mockClear();
    transformReactFineGrainedSignals(source, "123.tsx", { ...options, mode: "manual" });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("components held in keyed slots", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names a compound component from its assignment target", () => {
    const output = compile(`
      const count = { value: 1 };
      const Card = {};
      Card.Header = () => <p>{count.value}</p>;
      Card.Footer = function Footer() { return <p>{count.value}</p>; };
    `, "auto");

    expect(output.match(/finally/g)).toHaveLength(2);
    expect(output).toMatch(/Card\.Header = \(\) => \{\s+(?:"use no memo";\s+)?const _signals/);
    expect(output).toMatch(
      /Card\.Footer = function Footer\(\) \{\s+(?:"use no memo";\s+)?const _signals/,
    );
  });

  it("names a component held in an object-literal namespace or a class field", () => {
    const namespace = compile(`
      const count = { value: 1 };
      export const ns = { Home: () => <p>{count.value}</p> };
      export function App() { return <ns.Home />; }
    `, "auto");
    const field = compile(`
      const count = { value: 1 };
      export class Holder {
        Row = () => <p>{count.value}</p>;
        static Cell = () => <p>{count.value}</p>;
      }
    `, "auto");

    expect(namespace.match(/finally/g)).toHaveLength(1);
    expect(namespace).toMatch(/Home: \(\) => \{\s+(?:"use no memo";\s+)?const _signals/);
    expect(field.match(/finally/g)).toHaveLength(2);
  });

  it("reads the key rather than the function's own name", () => {
    // The slot a function was put in says what it is more reliably than the
    // label it carries, exactly as an enclosing binding already outranks a
    // function expression's own `id`.
    const source = `
      const count = { value: 1 };
      const Card = {};
      Card.onSelect = function Row() { return <p>{count.value}</p>; };
      const ns = { render: () => <p>{count.value}</p> };
    `;

    expect(compile(source, "auto")).toBe(source);
    expect(compile(source, "all")).toBe(source);
  });

  it("reads a string-literal key, computed or not, and stops at a runtime one", () => {
    // A computed key is only readable when it is a string literal, exactly as
    // `items["map"]` is; anything decided at runtime leaves the slot unnamed,
    // which leaves the function untransformed rather than guessed at.
    const literal = compile(`
      const count = { value: 1 };
      export const ns = { "Home": () => <p>{count.value}</p> };
    `, "auto");
    const computed = compile(`
      const count = { value: 1 };
      export const ns = { ["Home"]: () => <p>{count.value}</p> };
    `, "auto");
    const runtime = `
      const count = { value: 1 };
      const key = "Home";
      export const ns = { [key]: () => <p>{count.value}</p> };
    `;

    expect(literal.match(/finally/g)).toHaveLength(1);
    expect(computed.match(/finally/g)).toHaveLength(1);
    expect(compile(runtime, "auto")).toBe(runtime);
    expect(compile(runtime, "all")).toBe(runtime);
  });

  it("names a nested compound target and an inline object property", () => {
    // Naming reads the key alone, so neither a deeper member target nor an
    // object literal that no binding holds needs a holder to resolve through.
    const nested = compile(`
      const count = { value: 1 };
      const Card = { Sub: {} };
      Card.Sub.Header = () => <p>{count.value}</p>;
    `, "auto");
    const inline = compile(`
      const count = { value: 1 };
      function register(config) { return config; }
      export const registered = register({ Home: () => <p>{count.value}</p> });
    `, "auto");

    expect(nested.match(/finally/g)).toHaveLength(1);
    expect(inline.match(/finally/g)).toHaveLength(1);
  });

  it("keeps a keyed component handed to an iteration method off its own boundary", () => {
    // The exclusion that has to come with naming keyed slots: these run once per
    // item inside the owner's single render, so a hook injected into one breaks
    // hook order the moment the array length changes.
    const namespace = compile(`
      const items = [{ value: 1 }];
      const handlers = { Row: (item) => <li>{item.value}</li> };
      export function List() { return <ul>{items.map(handlers.Row)}</ul>; }
    `, "auto");
    const compound = compile(`
      const items = [{ value: 1 }];
      const Card = {};
      Card.Row = (item) => <li>{item.value}</li>;
      export function List() { return <ul>{items.map(Card.Row)}</ul>; }
    `, "auto");

    expect(namespace).not.toContain("finally");
    expect(compound).not.toContain("finally");
  });

  it("follows a nested namespace out to its root binding before excluding it", () => {
    // A one-level holder walk saw `items.map(a.b.Row)` as an unrelated
    // reference, so the per-item callback kept a boundary of its own -- which
    // React would then run once per item inside a single render.
    const nested = `
      const count = { value: 1 };
      const a = { b: { Row: (item) => <li>{count.value}{item}</li> } };
      export const List = ({ items }) => <ul>{items.map(a.b.Row)}</ul>;
    `;
    const assignedHolder = `
      const count = { value: 1 };
      const a = {};
      a.b = { Row: (item) => <li>{count.value}{item}</li> };
      export const List = ({ items }) => <ul>{items.map(a.b.Row)}</ul>;
    `;

    expect(compile(nested, "auto")).not.toContain("finally");
    expect(compile(assignedHolder, "auto")).not.toContain("finally");

    // `all` mode still wraps `List` itself, which is an ordinary component; what
    // must not happen is `Row` getting a second boundary of its own.
    const all = compile(nested, "all");
    expect(all.match(/finally/g)).toHaveLength(1);
    expect(all).toContain("Row: item => <li>{count.value}{item}</li>");
  });

  it("still transforms a nested namespace component nothing iterates over", () => {
    // The chain walk only disqualifies a slot that is actually handed to an
    // iteration method; a genuine nested compound component keeps its boundary.
    const output = compile(`
      const count = { value: 1 };
      export const a = { b: { Row: () => <li>{count.value}</li> } };
      export function List() { return <ul><a.b.Row /></ul>; }
    `, "auto");

    expect(output.match(/finally/g)).toHaveLength(1);
    expect(output).toMatch(/Row: \(\) => \{\s+(?:"use no memo";\s+)?const _signals/);
  });

  it("leaves a this-rooted assignment in a class component alone", () => {
    // `this.Row = ...` is as often a per-item row renderer reached through
    // `this.props.items.map(this.Row)` as it is a component, and `this` is not a
    // binding -- so the reference walk that disqualifies every other keyed slot
    // cannot see those uses, and a boundary given here could never be taken
    // back. The ambiguous case resolves the way this file always resolves one.
    const source = `
      const count = { value: 1 };
      export class Legacy extends React.Component {
        constructor(props) {
          super(props);
          this.Row = (item) => <li>{count.value}{item}</li>;
        }
        render() { return <ul>{this.props.items.map(this.Row)}</ul>; }
      }
    `;

    expect(compile(source, "auto")).toBe(source);
    expect(compile(source, "all")).toBe(source);
  });

  it("leaves object and class methods out of the keyed-slot widening", () => {
    // A method is far likelier to be called as one (`config.Header()`) than
    // rendered as a component, and no name shape separates the two -- so the
    // widening deliberately stops at properties and fields holding a function.
    const source = `
      const count = { value: 1 };
      export const ns = { Home() { return <p>{count.value}</p>; } };
      export class Holder { Row() { return <p>{count.value}</p>; } }
    `;

    expect(compile(source, "all")).toBe(source);
  });

  it("still leaves a re-assigned plain binding alone", () => {
    // Only a *member* target is named from its key: the declaration is the
    // binding, and routing a re-assignment through the keyed path would give it
    // the same authority as a declaration.
    const source = `
      const count = { value: 1 };
      let Row;
      Row = (props) => <p>{count.value}</p>;
      export { Row };
    `;

    expect(compile(source, "auto")).toBe(source);
    expect(compile(source, "all")).toBe(source);
  });
});

describe("components defined inline as a call argument", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("transforms a named function expression handed to a third-party HOC", () => {
    // The by-reference form (`observer(Row)`) was already eligible; this is the
    // same registration written in one expression, and it used to go both
    // untransformed and unreported.
    const output = compile(`
      const count = { value: 1 };
      function observer(C) { return C; }
      export default observer(function App() { return <p>{count.value}</p>; });
    `, "auto");

    expect(output.match(/finally/g)).toHaveLength(1);
    expect(output).toMatch(/observer\(function App\(\) \{\s+(?:"use no memo";\s+)?const _signals/);
  });

  it("requires the author's own PascalCase name on the function expression", () => {
    // An arrow or an anonymous function expression in a bare call argument has
    // no identity to attach a boundary to, and nothing in the call says what the
    // callee does with it -- so it stays out rather than being guessed at.
    const source = `
      const count = { value: 1 };
      function observer(C) { return C; }
      export default observer((props) => <p>{count.value}</p>);
    `;

    expect(compile(source, "auto")).toBe(source);
    expect(compile(source, "all")).toBe(source);
  });

  it("excludes an IIFE, a deferred hook callback, and a render callback", () => {
    // Each of these runs somewhere a hook call is invalid: module scope, a
    // memoized callback, and once per item inside the owner's render.
    const output = compile(`
      import { useMemo } from "react";
      const count = { value: 1 };
      const items = [1];
      export const eager = (function App() { return <p>{count.value}</p>; })();
      export function Panel() {
        const rows = useMemo(function Rows() { return <p>{count.value}</p>; }, []);
        return <div>{rows}</div>;
      }
      export function List() {
        return <ul>{items.map(function Row(item) { return <li>{count.value}{item}</li>; })}</ul>;
      }
    `, "auto");

    // Only `List` is transformed, and only because the render callback's read is
    // folded into it -- none of `App`, `Rows` or `Row` gets a boundary.
    expect(output.match(/finally/g)).toHaveLength(1);
    expect(output).toMatch(/function List\(\) \{\s+(?:"use no memo";\s+)?const _signals/);
    expect(output).toMatch(/function App\(\) \{\s+return <p>/);
    expect(output).toMatch(/function Rows\(\) \{\s+return <p>/);
    expect(output).toMatch(/function Row\(item\) \{\s+return <li>/);
  });
});

describe("@useSignals annotations that attach to nothing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports an annotation on a JSX-rendering function in any position", () => {
    // The warning used to be gated on candidacy, so it fired only in a subset of
    // the positions an annotation could legitimately appear in and do nothing --
    // a bare call argument was silent, which is exactly where an opt-in most
    // needs to be heard.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    compile(`
      const count = { value: 1 };
      function register(fn) { return fn; }
      register(/** @useSignals */ () => <p>{count.value}</p>);
    `);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("@useSignals annotation is ignored");
  });

  it("reports an annotation on a resolvable but lowercase JSX function", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    compile(`
      const count = { value: 1 };
      /** @useSignals */
      export const helper = () => <p>{count.value}</p>;
    `);

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("stays quiet for annotations that are doing their job", () => {
    // A function that renders nothing was never a component candidate, so an
    // annotation on it is the documented lowercase no-op; an annotated factory
    // renders nothing itself while the component it returns honors the very same
    // annotation; and a nested arrow reads its enclosing component's annotation
    // as its own through the comment climb, which must not report it twice.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    compile(`
      const count = { value: 1 };
      const items = [1];
      /** @useSignals */
      export function callback() { return count.value; }
      /** @useSignals */
      export const withCount = (Base) => (props) => <Base n={count.value} />;
      /** @useSignals */
      export const WithCount = (Base) => (props) => <Base n={count.value} />;
      /** @useSignals */
      export const App = () => <div>{items.map((i) => <li>{count.value}{i}</li>)}</div>;
    `);

    expect(warn).not.toHaveBeenCalled();
  });

  it("no longer needs to report an annotation on a keyed component", () => {
    // Widening the candidate positions made this case moot rather than merely
    // audible: the annotation now resolves and the component is transformed.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const output = compile(`
      const count = { value: 1 };
      export const ns = { /** @useSignals */ Home: () => <p>{count.value}</p> };
    `);

    expect(output.match(/finally/g)).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("parse failures", () => {
  it("attributes an unparseable file to the plugin, the file and the parser config", () => {
    // Fatal on purpose: returning null would hand the bundler the untransformed
    // source, which is the silent stale-UI failure this transform exists to
    // prevent -- and here it would also hide a real syntax error.
    const options = {
      importSource: "react-fine-grained-signals",
      mode: "auto" as const,
      transform: "managed" as const,
      reactCompiler: "auto" as const,
      reactImportSource: "react",
    };

    let thrown: unknown;
    try {
      transformReactFineGrainedSignals(
        "const count = { value: 1 }; export function App( { return <p/>; }",
        "/project/src/App.tsx?t=1730000000",
        options,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    // The attribution names the plugin, the file without the bundler's query
    // string, and the exact parser configuration the parse ran under -- none of
    // which the raw Babel error carries.
    expect(message).toMatch(
      /^unplugin-react-fine-grained-signals could not parse \/project\/src\/App\.tsx \(Babel parser plugins: jsx, typescript, decorators-legacy, decoratorAutoAccessors\):/,
    );
    // The original Babel error, and its code frame, stay reachable.
    expect(message).toContain("Unexpected token");
    expect((thrown as Error).cause).toBeInstanceOf(Error);
  });
});
