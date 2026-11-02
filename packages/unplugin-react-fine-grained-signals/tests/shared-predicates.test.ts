import { parseSync } from "@babel/core";
import { describe, expect, it } from "vitest";
import { transformReactFineGrainedSignals, type ReactFineGrainedSignalsTransform } from "../src/internal/transform.js";

// Regression tests for logic that used to be written out by hand in several
// places and had drifted apart: each `describe` pins one shared helper by the
// behaviour its former copies disagreed on.

interface Run {
  code: string | undefined;
  diagnostics: string[];
}

function run(
  source: string,
  {
    filename = "Fixture.tsx",
    mode = "auto",
    transform = "managed",
  }: { filename?: string; mode?: "manual" | "auto" | "all"; transform?: ReactFineGrainedSignalsTransform } = {},
): Run {
  const diagnostics: string[] = [];
  const result = transformReactFineGrainedSignals(source, filename, {
    importSource: "react-fine-grained-signals",
    mode,
    transform,
    reactCompiler: "opt-out",
    reactImportSource: "react",
    warn: (warning) => diagnostics.push((warning as Error & { diagnosticId: string }).diagnosticId),
  });
  return { code: result?.code, diagnostics };
}

/** The output must still be valid TypeScript: a bundler parses it again. */
function reparse(code: string, filename: string): void {
  parseSync(code, {
    babelrc: false,
    configFile: false,
    filename,
    parserOpts: { plugins: filename.endsWith(".tsx") ? ["jsx", "typescript"] : ["typescript"] },
  });
}

const header = `import { signal } from "react-fine-grained-signals";\nconst s = signal(0);\n`;

describe("TypeScript wrappers around an assignment or update target", () => {
  it("treats a satisfies-wrapped assignment target as a write", () => {
    const { code } = run(`${header}export function A() { (s.value satisfies number) = 3; return <p>{s.value}</p>; }`);
    expect(code).toContain("(s.value satisfies number) = 3;");
    reparse(code!, "A.tsx");
  });

  it.each([
    ["as", "(s.value as number)++"],
    ["satisfies", "(s.value satisfies number)++"],
    ["non-null", "s.value!++"],
  ])("captures a %s-wrapped update as a whole operation, like a bare one", (_kind, update) => {
    const { code } = run(`${header}export function B() { ${update}; return <p>{s.value}</p>; }`);
    expect(code).toContain(`_signals.capture(() => ${update})`);
    reparse(code!, "B.tsx");
  });

  it("captures an angle-bracket-asserted update and treats its assignment as a write", () => {
    const update = run(`${header}export function useE() { (<number>s.value)++; return s.value; }`, {
      filename: "useE.ts",
    });
    expect(update.code).toContain("_signals.capture(() => (<number> s.value)++)");
    reparse(update.code!, "useE.ts");
    // Babel prints this untouched statement without its parentheses, which is
    // a printer limitation of its own; what matters here is that the target
    // is not captured.
    const write = run(`${header}export function useE() { (<number>s.value) = 2; return s.value; }`, {
      filename: "useE.ts",
    });
    expect(write.code).not.toContain("capture(() => s.value) = 2");
    expect(write.code).toMatch(/^\s*<number> s\.value = 2;$/m);
  });

  it.each([
    ["an update", "f((s.value as number)++)"],
    ["a compound assignment", "f((s.value satisfies number) += 1)"],
    ["an update in a template", "f(`${(s.value as number)++}`)"],
  ])("keeps the parentheses of a wrapped target nested in %s it captures", (_kind, statement) => {
    const { code } = run(`${header}declare function f(value: unknown): void;
export function N() { ${statement}; return <p>{s.value}</p>; }`);
    expect(code).toContain("_signals.capture(");
    reparse(code!, "N.tsx");
  });

  it("captures a wrapped compound assignment as a whole operation, like a bare one", () => {
    const { code } = run(
      `${header}export function D() { s.value += 1; (s.value as number) += 1; (s.value satisfies number) += 1; return <p>{s.value}</p>; }`,
    );
    expect(code).toContain("_signals.capture(() => s.value += 1)");
    expect(code).toContain("_signals.capture(() => (s.value as number) += 1)");
    expect(code).toContain("_signals.capture(() => (s.value satisfies number) += 1)");
    reparse(code!, "D.tsx");
  });

  it("sees an angle-bracket assertion around an inline callback", () => {
    const { code } = run(
      `${header}export function useF(items: number[]) { return items.filter(<(n: number) => boolean>((n) => n > s.value)); }`,
      { filename: "useF.ts" },
    );
    expect(code).toContain("_signals.capture(() => items.filter(");
  });
});

describe("RFSG control-flow ownership of a Match callback", () => {
  const controlFlow = `import { Match, Switch, Show } from "react-fine-grained-signals/utils";\n${header}`;

  it("follows the runtime through a fragment between Switch and Match", () => {
    const { diagnostics } = run(
      `${controlFlow}export function A() { return <Switch><><Match when={s}>{(v) => v + s.value}</Match></></Switch>; }`,
    );
    expect(diagnostics).not.toContain("RFGS003");
  });

  it("follows the runtime through React's Fragment element", () => {
    const { diagnostics } = run(
      `import { Fragment } from "react";\n${controlFlow}export function A() { return <Switch><Fragment><Match when={s}>{() => s.value}</Match></Fragment></Switch>; }`,
    );
    expect(diagnostics).not.toContain("RFGS003");
  });

  it("requires an enclosing Switch for the children-attribute form too", () => {
    const owned = run(
      `${controlFlow}export function A() { return <Switch><Match when={s} children={() => s.value} /></Switch>; }`,
    );
    const orphan = run(
      `${controlFlow}export function A() { return <div><Match when={s} children={() => s.value} /></div>; }`,
    );
    expect(owned.diagnostics).not.toContain("RFGS003");
    expect(orphan.diagnostics).toContain("RFGS003");
  });

  it("follows the runtime through a conditional child and an array", () => {
    const { diagnostics } = run(
      `${controlFlow}export function A({ flag }) { return <Switch>{flag && <Match when={s}>{() => s.value}</Match>}{[<Match key="b" when={s}>{() => s.value}</Match>]}</Switch>; }`,
    );
    expect(diagnostics).not.toContain("RFGS003");
  });

  it.each([
    ["the left of ||", "{<Match when={s}>{() => s.value}</Match> || null}"],
    ["the left of ??", "{<Match when={s}>{() => s.value}</Match> ?? null}"],
  ])("follows the runtime through %s, whose operand is the result", (_where, child) => {
    const { diagnostics } = run(`${controlFlow}export function A() { return <Switch>${child}</Switch>; }`);
    expect(diagnostics).not.toContain("RFGS003");
  });

  it("does not follow the left of &&, which is never the rendered result", () => {
    const { diagnostics } = run(
      `${controlFlow}export function A({ flag }) { return <Switch>{<Match when={s}>{() => s.value}</Match> && flag}</Switch>; }`,
    );
    expect(diagnostics).toContain("RFGS003");
  });

  it("collects a Match passed as the Switch's children attribute", () => {
    const { diagnostics } = run(
      `${controlFlow}export function A() { return <Switch children={<Match when={s}>{() => s.value}</Match>} />; }`,
    );
    expect(diagnostics).not.toContain("RFGS003");
  });

  it("does not treat a Match in a Switch attribute as a branch", () => {
    const { diagnostics } = run(
      `${controlFlow}export function A() { return <Switch fallback={<Match when={s}>{() => s.value}</Match>} />; }`,
    );
    expect(diagnostics).toContain("RFGS003");
  });

  it("does not let an unrelated element between Switch and Match pass as a fragment", () => {
    const { diagnostics } = run(
      `${controlFlow}export function A() { return <Switch><div><Match when={s}>{() => s.value}</Match></div></Switch>; }`,
    );
    expect(diagnostics).toContain("RFGS003");
  });

  it("resolves a control-flow component read through a computed string key", () => {
    const { diagnostics } = run(
      `import * as U from "react-fine-grained-signals/utils";\n${header}const S = U["Show"];\nexport function A() { return <S when={s}>{() => s.value}</S>; }`,
    );
    expect(diagnostics).not.toContain("RFGS003");
  });

  it("resolves a string-named import specifier", () => {
    const { diagnostics } = run(
      `import { "Show" as When } from "react-fine-grained-signals/utils";\n${header}export function A() { return <When when={s}>{() => s.value}</When>; }`,
    );
    expect(diagnostics).not.toContain("RFGS003");
  });

  it("keeps rejecting a Show from another module", () => {
    const { diagnostics } = run(
      `import { Show } from "some-ui/utils";\n${header}export function A() { return <Show when={s}>{() => s.value}</Show>; }`,
    );
    expect(diagnostics).toContain("RFGS003");
  });
});

describe("reads inside a Hook's callback", () => {
  it.each(["managed", "inject"] as const)(
    "does not select a component whose only read is in a custom Hook's callback (%s)",
    (transform) => {
      const { code } = run(
        `import { useSignalEffect } from "react-fine-grained-signals";\n${header}export function A() { useSignalEffect(() => { console.log(s.value); }); return <p />; }`,
        { transform },
      );
      expect(code).toBeUndefined();
    },
  );

  it("does not select a component whose only read is in a later Hook argument", () => {
    const { code } = run(
      `import { useSyncExternalStore } from "react";\n${header}export function A() { const v = useSyncExternalStore(subscribe, () => s.value); return <p>{v}</p>; }`,
    );
    expect(code).toBeUndefined();
  });

  it("still selects a component that also reads in its own render", () => {
    const { code } = run(
      `import { useSignalEffect } from "react-fine-grained-signals";\n${header}export function A() { useSignalEffect(() => s.value); return <p>{s.value}</p>; }`,
    );
    expect(code).toContain("_signals.capture(() => s.value)");
    expect(code).toContain("useSignalEffect(() => s.value)");
  });
});

// Selection never counts a read in an async function (isDeferredReadContext),
// and the boundary design makes such reads an explicit non-goal; capture must
// not subscribe to them either just because another read selected the
// component.
describe("reads in async functions", () => {
  const withOther = `${header}const o = signal(0);\n`;

  it.each([
    ["an inline async callback", "items.forEach(async (i) => { log(s.value); });"],
    ["a named async callback", "async function each() { log(s.value); }\n  items.forEach(each);"],
    ["an async IIFE", "(async () => { log(s.value); })();"],
    ["a named async function called in place", "async function load() { log(s.value); }\n  load();"],
    ["a const async arrow called in place", "const load = async () => { log(s.value); };\n  load();"],
    ["an async render callback", "const pending = items.map(async (i) => s.value);"],
    [
      "a Promise executor that starts an async function",
      "new Promise((resolve) => { (async () => resolve(s.value))(); });",
    ],
  ])("does not select or capture %s", (_shape, statement) => {
    const alone = run(`${header}export function A({ items }) {\n  ${statement}\n  return <p />;\n}`);
    expect(alone.code).toBeUndefined();
    const selected = run(`${withOther}export function A({ items }) {\n  ${statement}\n  return <p>{o.value}</p>;\n}`);
    expect(selected.code).toContain("_signals.capture(() => o.value)");
    expect(selected.code).not.toMatch(/capture\(\(\) => (items|\(async|load|new Promise)/);
  });

  it("still captures the same callback when it is synchronous", () => {
    const { code } = run(
      `${withOther}export function A({ items }) { items.forEach((i) => { log(s.value); }); return <p>{o.value}</p>; }`,
    );
    expect(code).toContain("_signals.capture(() => items.forEach(");
  });
});

describe("string import names", () => {
  it("follows the runtime through Fragment imported by its string name", () => {
    const { diagnostics } = run(
      `import { "Fragment" as F } from "react";\nimport { Match, Switch } from "react-fine-grained-signals/utils";\n${header}export function A() { return <Switch><F><Match when={s}>{() => s.value}</Match></F></Switch>; }`,
    );
    expect(diagnostics).not.toContain("RFGS003");
  });

  it("treats memo imported by its string name as a component wrapper", () => {
    const { code } = run(`import { "memo" as m } from "react";\n${header}export const C = m(() => <p>{s.value}</p>);`);
    expect(code).toContain("_useSignalCapture()");
    expect(code).toContain("_signals.capture(() => s.value)");
  });
});

// A type-only import is erased, so at run time its name is not the imported
// module's export: a call through it is as unproven as any unknown name.
// Namespace, default and named value imports all resolve to their source.
describe("which bindings count as imports", () => {
  it.each([
    ["a type-only declaration", 'import type { helper } from "react";', "helper()"],
    ["a type-only specifier", 'import { type helper } from "react";', "helper()"],
    ["a type-only namespace", 'import type * as R from "react";', "R.helper()"],
    ["a type-only tag", 'import { type helper } from "react";', "helper`x`"],
  ])("captures a call through %s", (_kind, declaration, call) => {
    const { code } = run(`${declaration}\n${header}export function A() { return <p>{${call}}{s.value}</p>; }`);
    expect(code).toContain(`_signals.capture(() => ${call})`);
  });

  it.each([
    ["a namespace", 'import * as R from "react";', "R.helper()"],
    ["a default", 'import R from "react";', "R.helper()"],
    ["a named", 'import { helper } from "react";', "helper()"],
    ["a tag through a named", 'import { helper } from "react";', "helper`x`"],
  ])("trusts a call through %s React import", (_kind, declaration, call) => {
    const { code } = run(`${declaration}\n${header}export function A() { return <p>{${call}}{s.value}</p>; }`);
    expect(code).not.toContain(`_signals.capture(() => ${call})`);
  });

  it.each([
    ["a named", 'import { load } from "./ext";', "load()"],
    ["a default", 'import load from "./ext";', "load()"],
    ["a namespace member", 'import * as ext from "./ext";', "ext.load()"],
  ])("captures a call through %s foreign import", (_kind, declaration, call) => {
    const { code } = run(`${declaration}\n${header}export function A() { return <p>{${call}}{s.value}</p>; }`);
    expect(code).toContain(`_signals.capture(() => ${call})`);
  });
});

describe("Hook calls inside a helper", () => {
  it("never folds a helper that calls use() into a capture closure", () => {
    const { code } = run(
      `import { use } from "react";\n${header}function title() { use(Ctx); return s.value; }\nexport function A() { return <p>{title()}{s.value}</p>; }`,
    );
    expect(code).not.toContain("capture(() => title())");
    expect(code).toContain("{title()}");
  });

  it("sees a Hook call that is a concise arrow's whole body", () => {
    const { code } = run(
      `${header}const read = () => useLabel(s.value);
export function A() { return <p>{read()}{s.value}</p>; }`,
    );
    expect(code).not.toContain("capture(() => read())");
    expect(code).toContain("{read()}");
  });
});

describe("RFGS004 and parameter-default reads", () => {
  it("does not report a ref's .current.value read in a parameter default", () => {
    const { code, diagnostics } = run(
      `${header}export function A({ ref, v = ref.current.value }) { return <p>{v}{s.value}</p>; }`,
    );
    expect(code).toContain("_signals.capture(() => s.value)");
    expect(diagnostics).not.toContain("RFGS004");
  });

  it("still reports a signal read the relocation had to leave in place", () => {
    const { diagnostics } = run(`${header}export function A({ v = s.value }) { const s = 1; return <p>{v}{s}</p>; }`, {
      mode: "all",
    });
    expect(diagnostics).toContain("RFGS004");
  });

  // Selection folds a same-module helper's reads into the component, so the
  // default that calls it has to move behind the boundary as well.
  it.each(["managed", "inject"] as const)(
    "relocates a default that reads through a same-module helper (%s)",
    (transform) => {
      const { code, diagnostics } = run(
        `${header}const read = () => s.value;\nexport function C({ label = read() }) { return <p>{label}</p>; }`,
        { transform },
      );
      expect(code).toContain("export function C(_param)");
      expect(code).toContain(transform === "managed" ? "label = _signals.capture(() => read())" : "label = read()");
      expect(diagnostics).not.toContain("RFGS004");
    },
  );

  it("relocates a default whose inline callback reads", () => {
    const { code } = run(
      `${header}export function C({ items, n = items.filter((i) => i > s.value).length }) { return <p>{n}</p>; }`,
      {
        mode: "all",
      },
    );
    expect(code).toContain("export function C(_param)");
  });

  it("reports a helper-reading default the relocation had to leave in place", () => {
    const { code, diagnostics } = run(
      `${header}const read = () => s.value;\nexport function C({ label = read() }) { var label; return <p>{label}</p>; }`,
    );
    expect(code).toContain("label = read()");
    expect(diagnostics).toContain("RFGS004");
  });

  it("leaves a default with no possible read in the parameter list", () => {
    const { code } = run(
      `${header}const id = (x) => x;\nexport function C({ label = id(1) }) { return <p>{label}{s.value}</p>; }`,
    );
    expect(code).toContain("label = id(1)\n}) {");
  });
});

describe("RFGS003 callback targets", () => {
  it("sees a render prop through a TypeScript wrapper", () => {
    const { diagnostics } = run(`${header}export function A() { return <List render={(() => s.value) as Fn} />; }`);
    expect(diagnostics).toContain("RFGS003");
  });

  it("sees a children callback through a TypeScript wrapper", () => {
    const { diagnostics } = run(`${header}export function A() { return <List>{(() => s.value) as Fn}</List>; }`);
    expect(diagnostics).toContain("RFGS003");
  });

  it("holds async callbacks in both slots to the same read test", () => {
    const reading = run(
      `${header}export function A() { return <><List>{async () => s.value}</List><List render={async () => s.value} /></>; }`,
      { mode: "all" },
    );
    expect(reading.diagnostics.filter((id) => id === "RFGS003")).toHaveLength(2);
    const action = run(
      `${header}export function A() { return <form action={async (data) => { await save(data); }}>{s.value}</form>; }`,
    );
    expect(action.diagnostics).not.toContain("RFGS003");
  });

  it("leaves an event handler alone", () => {
    const { diagnostics } = run(
      `${header}export function A() { return <button onClick={(() => s.value) as Fn}>{s.value}</button>; }`,
    );
    expect(diagnostics).not.toContain("RFGS003");
  });

  // A capture clones the callback that holds the JSX, and the clone is
  // inspected again; a diagnostic is reported once per source location.
  it.each([
    ["an arrow", "() => s.value"],
    ["a function expression", "function () { return s.value; }"],
  ])("reports a render prop in %s inside a captured map callback once", (_kind, callback) => {
    const { diagnostics } = run(
      `${header}const o = signal(1);\nconst items = [1];\nexport function A() { return <p>{o.value}{items.map((i) => <List key={i} render={${callback}} />)}</p>; }`,
    );
    expect(diagnostics.filter((id) => id === "RFGS003")).toHaveLength(1);
  });
});

describe("React state reached through a namespace import", () => {
  it.each([
    ['import { useState } from "react";', "useState"],
    ['import * as React from "react";', "React.useState"],
    ['import React from "react";', "React.useState"],
  ])("treats %s state as owned data", (reactImport, hook) => {
    const { code } = run(
      `${reactImport}\n${header}export function A() { const [rows] = ${hook}([]); return <ul>{s.value}{rows.map((r) => <li>{r.name.trim()}</li>)}</ul>; }`,
    );
    expect(code).toContain("{rows.map(r => <li>{r.name.trim()}</li>)}");
  });

  it("does not trust a same-named method of an arbitrary object", () => {
    const { code } = run(
      `${header}export function A({ store }) { const [rows] = store.useState([]); return <ul>{s.value}{rows.map((r) => <li>{r}</li>)}</ul>; }`,
    );
    expect(code).toContain("_signals.capture(() => rows.map(");
  });
});

describe("message prefix", () => {
  it("starts diagnostics and parse failures with the plugin's own name", () => {
    const messages: string[] = [];
    transformReactFineGrainedSignals(
      `${header}export function A({ v = s.value }) { const s = 1; return <p>{v}{s}</p>; }`,
      "A.tsx",
      {
        importSource: "react-fine-grained-signals",
        mode: "all",
        transform: "managed",
        reactCompiler: "opt-out",
        reactImportSource: "react",
        warn: (warning) => messages.push(warning.message),
      },
    );
    expect(messages[0]).toMatch(/^[^\n]*\[unplugin-react-fine-grained-signals\] RFGS004: /);
    expect(() => run("const value = <p>{</p>;", { filename: "Broken.tsx" })).toThrow(
      /^\[unplugin-react-fine-grained-signals\] could not parse Broken\.tsx /,
    );
  });
});

describe("Hook calls anywhere in a destructuring declaration", () => {
  // The same `expressionCallsHook` check over the whole declarator that an
  // assignment gets: a Hook in a pattern default must not move into the
  // capture that evaluates the pattern.
  it.each([
    ["an array pattern default", "const [a = useX()] = list.value;"],
    ["an object pattern default", "const { a = useX() } = st.value;"],
    ["a computed key", "const { [useX()]: a } = st.value;"],
  ])("keeps a Hook in %s out of the capture and reports RFGS001", (_kind, declaration) => {
    const { code, diagnostics } = run(
      `import { useX } from "./x";\n${header}const list = signal([1]);\nconst st = signal({ a: 1 });\nexport function A() { ${declaration} return <p>{a}</p>; }`,
    );
    expect(code).not.toMatch(/capture\(\(\) => \{[^}]*useX\(\)/);
    expect(code).toContain("useX()");
    expect(diagnostics).toContain("RFGS001");
    reparse(code!, "A.tsx");
  });
});

describe("Hook names", () => {
  // React's own rule (eslint-plugin-react-hooks, babel-plugin-react-compiler's
  // `isHookName`): `use` followed by an uppercase letter or a digit.
  it("never moves a call named use + digit into a capture", () => {
    const { code } = run(
      `import { use3D } from "./x";\n${header}function join(a: unknown, b: unknown) { return String(a) + String(b); }\nexport function A() { const n = join(use3D(), s.value); return <p>{n}</p>; }`,
    );
    expect(code).not.toMatch(/capture\(\(\) => [^;]*use3D\(\)/);
    expect(code).toContain("join(use3D(), _signals.capture(() => s.value))");
  });

  it("gives a function named use + digit a Hook's identity", () => {
    const { code } = run(`${header}export function use3D() { return s.value; }`);
    expect(code).toMatch(/function use3D\(\) \{\s+(?:"use no memo";\s+)?const _signals = _useSignalCapture\(\);/);
  });

  it.each(["user", "useless", "use_x"])("treats %s() as an ordinary call", (name) => {
    const { code } = run(
      `import { ${name} } from "./x";\n${header}export function A() { const n = ${name}(); return <p>{n}{s.value}</p>; }`,
    );
    expect(code).toContain(`_signals.capture(() => ${name}())`);
  });
});

describe("captures given up for a Hook", () => {
  // README.md, "Hook calls in a read expression": "Other Hook-containing read
  // expressions are left uncaptured with a warning". Every path that gives a
  // capture up for a Hook reports RFGS001 through one helper.
  const prelude = `import { useX } from "./x";\n${header}const st = signal({ a: 1 });\nconst list = signal([1]);\nclass Reader { v: number; constructor(_: unknown) { this.v = s.value; } }\n`;
  it.each([
    ["a constructor call", "const r = new Reader(useX()).v;"],
    ["an object spread", "const r = { ...st.value, h: useX() };"],
    ["an array spread", "const r = [...list.value, useX()];"],
    ["an in check", "const r = useX() in st.value;"],
    ["a binary coercion", "const r = s.value + useX();"],
    ["a template literal", "const r = `${s.value}${useX()}`;"],
    ["a compound assignment", "let r = ''; r += st.value.a + useX();"],
    ["an update", "let r = 0; st.value[useX()]++;"],
  ])("reports %s", (_kind, statement) => {
    // `{s.value}` selects the component on its own: a constructor call is a
    // precaution, which does not (README.md, "auto" selection).
    const { code, diagnostics } = run(
      `${prelude}export function A() { ${statement} return <p>{String(r)}{s.value}</p>; }`,
    );
    expect(code).not.toMatch(/capture\(\(\) => [^)]*useX\(\)/);
    expect(diagnostics).toContain("RFGS001");
  });
});

describe("a read on a Hook's result", () => {
  // `hookBaseOf`/`splitHookBase`: the member read and the `for...of` paths
  // find the Hook at the chain's base the same way, through TypeScript
  // wrappers.
  it.each([
    ["a bare", "useStore().value.name", "_hookResult.value.name"],
    ["an as-wrapped", "(useStore() as any).value.name", "(_hookResult as any).value.name"],
    ["a non-null", "useStore()!.value.name", "_hookResult!.value.name"],
  ])("calls %s Hook in place and captures the read after it", (_kind, read, captured) => {
    const { code, diagnostics } = run(
      `import { useStore } from "./x";\n${header}export function A() { const n = ${read}; return <p>{n}</p>; }`,
    );
    expect(code).toContain(`_signals.capture(() => ${captured})`);
    expect(code).toMatch(/\)\(useStore\(\)\)/);
    expect(diagnostics).not.toContain("RFGS001");
    reparse(code!, "A.tsx");
  });
});

const deepHeader = `import { deepSignal, signal } from "react-fine-grained-signals";\nconst state = deepSignal({ user: { name: "Ada" }, items: [{ title: "a", meta: { tag: "x" } }] });\nconst o = signal(0);\n`;

describe("a member read on an expression that carries an alias", () => {
  // `hasTrackedReadInMemberChain` followed only member objects and calls, so
  // `(flag ? user : d).name` read `.name` of the deep proxy outside a capture.
  it.each([
    ["a conditional", "(props.f ? user : d).name"],
    ["a logical expression", "(user ?? d).name"],
    ["an array literal", "[user][0]!.name"],
    ["a sequence", "(log(), user).name"],
  ])("captures the whole read through %s", (_kind, read) => {
    const { code } = run(
      `${deepHeader}function log() {}\nconst d = { name: "-" };\nexport function A(props: { f?: boolean }) { const user = state.value.user; const x = ${read}; return <p>{x}{o.value}</p>; }`,
    );
    expect(code).toContain(`const x = _signals.capture(() => ${read});`);
  });

  it("captures a read on a spread copy of an alias container", () => {
    const { code } = run(
      `${deepHeader}export function A() { const box = new Set<{ name: string }>(); box.add(state.value.user); const x = [...box][0]!.name; return <p>{x}</p>; }`,
    );
    expect(code).toContain("const x = _signals.capture(() => [...box][0]!.name);");
  });
});

describe("aliases bound by an assignment pattern", () => {
  it.each([
    ["an object pattern", "let user: { name: string }; ({ user } = state.value);", "user.name"],
    ["an array pattern", "let first: { title: string }; [first] = state.value.items;", "first.title"],
    ["a nested pattern", "let meta: { tag: string }; ({ items: [{ meta }] } = state.value);", "meta.tag"],
  ])("makes the names %s binds aliases, as a declaration does", (_kind, statement, read) => {
    const { code } = run(`${deepHeader}export function A() { ${statement} const x = ${read}; return <p>{x}</p>; }`);
    expect(code).toContain(`const x = _signals.capture(() => ${read});`);
  });
});

describe("aliases bound by an assignment-form loop head", () => {
  it.each([
    ["an object pattern", "let meta: { tag: string };", "for ({ meta } of state.value.items)", "meta.tag"],
    [
      "an array pattern",
      "let pair: { tag: string };",
      "for ([pair] of state.value.items.map((i) => [i.meta]))",
      "pair.tag",
    ],
    ["an existing binding", "let item: { title: string };", "for (item of state.value.items)", "item.title"],
  ])("makes the loop variables of %s aliases, as the declaration form does", (_kind, declaration, head, read) => {
    const { code } = run(
      `${deepHeader}export function A() { ${declaration} let x = ""; ${head} { x += ${read}; } return <p>{x}</p>; }`,
    );
    expect(code).toContain(`_signals.capture(() => x += ${read})`);
  });
});
