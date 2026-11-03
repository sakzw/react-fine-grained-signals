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

describe("RFGS004 for a hand-written boundary", () => {
  // Nothing moves a default behind the author's own Hook call, so it is stale.
  const everywhere = (source: string): string[] =>
    (["auto", "manual", "all"] as const).flatMap((mode) =>
      (["managed", "inject"] as const).flatMap((transform) => run(source, { mode, transform }).diagnostics),
    );
  const tracking = `import { useSignalTracking } from "react-fine-grained-signals";\nimport { ext } from "./ext";\n${header}const read = () => s.value;\n`;
  const app = (params: string, statements = "useSignalTracking();"): string =>
    `${tracking}export function A(${params}) { ${statements} return <p>{String(1)}</p>; }`;

  it.each([
    ["a pattern default", "{ x = s.value }: any"],
    ["a positional default", "x = s.value"],
    ["a nested default", "{ a: { x = s.value } = {} as any }: any"],
    ["a default through a helper", "{ x = read() }: any"],
    ["a call this module cannot see into", "{ x = ext() }: any"],
    ["an inline callback that runs", "{ x = [1].map(() => s.value) }: any"],
  ])("reports %s, in all six combinations", (_kind, params) => {
    expect(everywhere(app(params))).toEqual(Array(6).fill("RFGS004"));
  });

  it("reports a default in front of a late Hook call too", () => {
    expect(everywhere(app("{ x = s.value }: any", "const n = 1; void n; useSignalTracking();"))).toEqual(
      Array(6).fill("RFGS004"),
    );
  });

  it("reports an arrow's default", () => {
    const source = `${tracking}export const A = ({ x = s.value }: any) => { useSignalTracking(); return <p>{x}</p>; };`;
    expect(everywhere(source)).toEqual(Array(6).fill("RFGS004"));
  });

  it.each([
    ["a literal default", "{ x = 1 }: any"],
    ["a ref's value", "{ ref, x = ref.current.value }: any"],
    ["an event target's value", "{ e, x = e.target.value }: any"],
    ["a closure the default only creates", "{ f = () => s.value }: any"],
    ["no default", "{ x }: any"],
    ["a plain parameter", "props: any"],
  ])("stays quiet for %s", (_kind, params) => {
    expect(everywhere(app(params))).toEqual([]);
  });

  it("stays quiet for a read after the boundary", () => {
    expect(everywhere(app("{ x }: any", "useSignalTracking(); const y = x ?? s.value; void y;"))).toEqual([]);
  });

  it("stays quiet for an opted-out function", () => {
    const source = `${tracking}/** @noSignalTracking */ export function A({ x = s.value }: any) { useSignalTracking(); return <p>{x}</p>; }`;
    expect(everywhere(source)).toEqual([]);
  });

  it("leaves the parameter where the author wrote it", () => {
    const { code } = run(app("{ x = s.value }: any"));
    expect(code).toContain("x = s.value");
    expect(code).not.toContain("_param");
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
    expect(() => run("const value = s.value; const x = <p>{</p>;", { filename: "Broken.tsx" })).toThrow(
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

describe("a helper that calls a Hook and reads", () => {
  // Whatever its name: the read runs in the caller's render, and the Hook keeps
  // it out of a capture, so the caller is selected and RFGS002 says so.
  const hook = `import { useX } from "./x";\n${header}`;
  const caller = "export function A() { const n = CALL; return <p>{n}</p>; }";
  const both = (helper: string, call: string): string[] => [
    `${hook}${helper}\n${caller.replace("CALL", call)}`,
    `${hook}${caller.replace("CALL", call)}\n${helper}`,
  ];

  it.each([
    ["a component name", "function Title() { useX(); return s.value; }", "Title()"],
    ["a lowercase name", "function title() { useX(); return s.value; }", "title()"],
    ["a lowercase arrow", "const title = () => { useX(); return s.value; };", "title()"],
    ["a keyed method", "const o = { t() { useX(); return s.value; } };", "o.t()"],
    ["a keyed arrow", "const o = { t: () => { useX(); return s.value; } };", "o.t()"],
    [
      "a read in another helper",
      "function read() { return s.value; }\nfunction title() { useX(); return read(); }",
      "title()",
    ],
  ])("selects the caller and reports RFGS002 for %s", (_kind, helper, call) => {
    for (const source of both(helper, call)) {
      for (const mode of ["auto", "all"] as const) {
        const managed = run(source, { mode });
        expect(managed.code).toContain("_useSignalCapture()");
        expect(managed.code).not.toContain(`capture(() => ${call})`);
        expect(managed.diagnostics).toEqual(["RFGS002"]);
        const injected = run(source, { mode, transform: "inject" });
        expect(injected.code).toMatch(/function A\(\) \{\s+"use no memo";\s+_useSignalTracking\(\);/);
        expect(injected.diagnostics).toEqual([]);
      }
    }
  });

  it("does not report a helper that only calls a Hook", () => {
    for (const source of both("function title() { useX(); return 1; }", "title()")) {
      for (const transform of ["managed", "inject"] as const) {
        expect(run(source, { transform })).toEqual({ code: undefined, diagnostics: [] });
      }
    }
  });

  it("does not report a read the render never runs", () => {
    const source = `${hook}import { useEffect } from "react";
function title() { useX(); useEffect(() => { void s.value; }, []); return 1; }
export function A() { const n = title(); return <p>{n}</p>; }`;
    expect(run(source)).toEqual({ code: undefined, diagnostics: [] });
    const handler = `${hook}function title() { useX(); return s.value; }
export function A() { return <p onClick={() => title()} />; }`;
    expect(run(handler)).toEqual({ code: undefined, diagnostics: [] });
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

describe("aliases bound by a pattern's default", () => {
  it.each([
    ["a parameter", "{ user = state.value.user }: any", ""],
    ["a renamed parameter", "{ u: user = state.value.user }: any", ""],
    ["a nested parameter", "{ a: { user = state.value.user } = {} as any }: any", ""],
    ["a declaration", "p: any", "const { user = state.value.user } = p;"],
    ["a let declaration", "p: any", "let { user = state.value.user } = p;"],
    ["a rest neighbour", "p: any", "const { user = state.value.user, ...rest } = p; void rest;"],
    ["an object assignment", "", "let user: any; ({ user = state.value.user } = {} as any);"],
    ["an array declaration", "", "const [user = state.value.user] = [] as any[];"],
    ["an array assignment", "", "let user: any; [user = state.value.user] = [] as any[];"],
    ["a wrapped assignment target", "", "let user: any; ({ user: (user as any) = state.value.user } = {} as any);"],
    ["a default that is an alias", "p: any", "const fb = state.value.user; const { user = fb } = p;"],
    [
      "a default through an alias chain",
      "p: any",
      "const fb = state.value.user; const { a = fb } = p; const { user = a } = p;",
    ],
  ])("makes the name in %s an alias", (_kind, params, statement) => {
    const { code } = run(
      `${deepHeader}export function A(${params}) { ${statement} const y = user.name; return <p>{y}</p>; }`,
    );
    expect(code).toContain("const y = _signals.capture(() => user.name);");
  });

  it.each([
    ["a declaration", "const { user = state.value.user } of [{}] as any[]"],
    ["an array declaration", "const [user = state.value.user] of [[]] as any[]"],
  ])("makes the name in a loop head's %s an alias", (_kind, head) => {
    const { code } = run(`${deepHeader}export function A() { for (${head}) { void user.name; } return <p />; }`);
    expect(code).toContain("_signals.capture(() => user.name)");
  });

  it("leaves a default that reads nothing alone", () => {
    const { code } = run(
      `${deepHeader}export function A({ user = { name: "n" } }: any) { const y = user.name; return <p>{y}{state.value.user.name}</p>; }`,
    );
    expect(code).toContain("const y = user.name;");
  });

  it("does not take a default from a nested function's own parameter", () => {
    const { code } = run(
      `${deepHeader}export function A({ user = { name: "n" } }: any) { const f = ({ user: u = state.value.user }: any) => u; void f; const y = user.name; return <p>{y}{state.value.user.name}</p>; }`,
    );
    expect(code).toContain("const y = user.name;");
  });
});

describe("aliases through a parameter or a TypeScript wrapper", () => {
  // The same as assigning an identifier: only that the target is a binding of
  // this function matters, not its kind or a wrapper the types add.
  it.each([
    ["a parameter in a pattern", "row", "({ row } = state.value);", "row.name"],
    ["a wrapped array element", "x", "let row: any; [(row as any)] = state.value.items;", "row.title"],
    ["a wrapped object value", "x", "let row: any; ({ user: (row as any) } = state.value);", "row.name"],
    ["a non-null target", "x", "let row: any; [row!] = state.value.items;", "row.title"],
    ["a wrapped identifier target", "x", "let row: any; (row as any) = state.value.user;", "row.name"],
    ["a parameter in an identifier target", "row", "row = state.value.user;", "row.name"],
  ])("makes %s an alias", (_kind, param, statement, read) => {
    const { code } = run(
      `${deepHeader}export function A({ ${param} }: any) { ${statement} const y = ${read}; return <p>{y}</p>; }`,
    );
    expect(code).toContain(`const y = _signals.capture(() => ${read});`);
  });

  it("leaves a name from outside the function alone", () => {
    const { code } = run(
      `${deepHeader}let outer: any;\nexport function A() { ({ user: outer } = state.value); const y = outer.name; return <p>{y}</p>; }`,
    );
    expect(code).toContain("const y = outer.name;");
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

describe("a write through a signal value", () => {
  // README "Managed tracking contract": writing to signal state during render
  // is a side effect, so the object a write target writes to is not counted
  // as a read.
  it.each([
    ["a property", "st.value.a = 2;"],
    ["a computed property", 'st.value["a"] = 2;'],
    ["a nested property", "st.value.b.c = 2;"],
  ])("leaves %s write uncaptured and does not select the component", (_kind, statement) => {
    const { code } = run(
      `${header}const st = signal({ a: 1, b: { c: 1 } });
export function A() { ${statement} return <p>x</p>; }`,
    );
    expect(code).toBeUndefined();
  });
});

describe("a JSX member tag that reads a signal", () => {
  // README "Managed tracking contract": a read in a JSX tag name is not
  // tracked; RFGS010 asks for the component in a variable first.
  const theme = `import { signal } from "react-fine-grained-signals";
const theme = signal({ Icon: () => <b /> });
`;
  it("reports RFGS010 and neither captures the tag nor selects the component", () => {
    const { code, diagnostics } = run(
      `${theme}export function A() { return <p><theme.value.Icon>x</theme.value.Icon></p>; }`,
    );
    expect(code).toBeUndefined();
    expect(diagnostics).toEqual(["RFGS010"]);
  });

  it("leaves the tag as written in a component selected for another read", () => {
    const { code, diagnostics } = run(
      `${theme}const s = signal(0);
export function A() { return <p><theme.value.Icon />{s.value}</p>; }`,
    );
    expect(code).toContain("<theme.value.Icon />");
    expect(diagnostics).toEqual(["RFGS010"]);
  });

  it("reports a tag inside a render callback once", () => {
    const { diagnostics } = run(
      `${theme}const items = [1];
export function A() { return <ul>{items.map((i) => <theme.value.Icon key={i} />)}</ul>; }`,
    );
    expect(diagnostics).toEqual(["RFGS010"]);
  });

  // Only a read that runs in a render nothing else tracks: the same rule read
  // detection applies (`isDeferredFunction`), plus what already tracks it.
  const theming = `import { useEffect, useMemo } from "react";\nimport { useSignalTracking } from "react-fine-grained-signals";\n${theme}`;
  it.each([
    ["an event handler", "return <button onClick={() => <theme.value.Icon />} />;"],
    ["a useEffect callback", "useEffect(() => { void (<theme.value.Icon />); }, []); return <p />;"],
    ["a useMemo callback", "const el = useMemo(() => <theme.value.Icon />, []); return el;"],
    ["a timer", "setTimeout(() => <theme.value.Icon />, 0); return <p />;"],
    ["an async function", "const later = async () => <theme.value.Icon />; void later; return <p />;"],
    ["a function with an ambient first-statement boundary", "useSignalTracking(); return <theme.value.Icon />;"],
    ["a function with a late boundary", "const n = 1; useSignalTracking(); return <theme.value.Icon a={n} />;"],
    [
      "a callback under an ambient boundary",
      "useSignalTracking(); return <ul>{[1].map((i) => <theme.value.Icon key={i} />)}</ul>;",
    ],
  ])("does not report a tag in %s", (_kind, body) => {
    const { diagnostics } = run(`${theming}export function A() { ${body} }`);
    expect(diagnostics.filter((id) => id === "RFGS010")).toEqual([]);
  });

  it.each([
    ["itself", "/** @noSignalTracking */ export function A() { return <theme.value.Icon />; }"],
    [
      "around a callback",
      "/** @noSignalTracking */ export function A() { return <ul>{[1].map((i) => <theme.value.Icon key={i} />)}</ul>; }",
    ],
  ])("does not report a tag in a @noSignalTracking function, %s", (_kind, source) => {
    expect(run(`${theming}${source}`).diagnostics).toEqual([]);
  });

  it("does not report a tag in a function inject tracks, and does in one it does not select", () => {
    const selected = `${theming}const s = signal(0);\nexport function A() { return <p><theme.value.Icon />{s.value}</p>; }`;
    expect(run(selected, { transform: "inject" }).diagnostics).toEqual([]);
    const unselected = `${theming}export function A() { return <theme.value.Icon />; }`;
    expect(run(unselected, { transform: "inject" }).diagnostics).toEqual(["RFGS010"]);
  });

  it("reports in manual mode under an opt-in", () => {
    const source = `${theme}/** @signalTracking */ export function A() { return <theme.value.Icon />; }`;
    expect(run(source, { mode: "manual" }).diagnostics).toEqual(["RFGS010"]);
  });

  // `isNonSignalValueReceiver`: the same rule whatever else the file reads, so
  // the raw-text screen cannot make the diagnostic come and go.
  it.each([
    ["alone", ""],
    ["next to an unrelated read", "const u = signal(0);\nexport const B = () => <p>{u.value}</p>;\n"],
  ])("does not report a DOM or ref field as a tag, %s", (_kind, extra) => {
    for (const tag of ["ref.current.value", "e.target.value", "e.currentTarget.value.Icon"]) {
      const { diagnostics } = run(`${header}${extra}export function A({ ref, e }: any) { return <${tag} />; }`);
      expect(diagnostics).toEqual([]);
    }
  });

  it.each(["current.value", "target.value.Icon", "holder.value.current.value", "ref.current.value.value"])(
    "reports <%s />",
    (tag) => {
      const { diagnostics } = run(
        `${header}export function A({ current, target, holder, ref }: any) { return <${tag} />; }`,
      );
      expect(diagnostics).toEqual(["RFGS010"]);
    },
  );

  it("does not report an ordinary member tag, or in manual mode without an opt-in", () => {
    expect(
      run(`${header}const ui = { Icon: () => <b /> };
export function A() { return <p><ui.Icon />{s.value}</p>; }`).diagnostics,
    ).toEqual([]);
    expect(run(`${theme}export function A() { return <theme.value.Icon />; }`, { mode: "manual" }).diagnostics).toEqual(
      [],
    );
  });
});

describe("class fields", () => {
  // An instance field initializer runs when the class is instantiated, like a
  // method body; a static field or block runs when the class is evaluated,
  // which for a class declared in the body is the render.
  it.each([
    ["a public", "snapshot = s.value;"],
    ["a private", "#snapshot = s.value;"],
    ["an accessor", "accessor snapshot = s.value;"],
  ])("does not select a component for %s instance field read only in an effect", (_kind, field) => {
    const { code } = run(
      `import { useEffect } from "react";\n${header}export function A() { class Model { ${field} } useEffect(() => { void new Model(); }, []); return <p>x</p>; }`,
    );
    expect(code).toBeUndefined();
  });

  it("captures the instantiation, not the field, when the class is instantiated in render", () => {
    const { code } = run(
      `${header}export function A() { class Model { snapshot = s.value; } const x = new Model().snapshot; return <p>{x}{s.value}</p>; }`,
    );
    expect(code).toContain("snapshot = s.value;");
    expect(code).toContain("_signals.capture(() => new Model())");
  });

  it.each([
    ["never instantiated", "function setup() { class Model { x = s.value; } void Model; }", "{setup()}"],
    [
      "instantiated by a helper only in an effect",
      "function setup() { class Model { x = s.value; } setTimeout(() => new Model(), 0); }",
      "{setup()}",
    ],
  ])("does not count a field of a class in a helper, %s", (_kind, helper, jsx) => {
    const { code } = run(`${header}${helper}\nexport function A() { return <p>${jsx}</p>; }`);
    expect(code).toBeUndefined();
  });

  it("counts a field of a class a helper instantiates", () => {
    const { code } = run(
      `${header}function make() { class Model { x = s.value; } return new Model().x; }\nexport function A() { return <p>{make()}</p>; }`,
    );
    expect(code).toContain("_signals.capture(() => make())");
  });

  // Only the initializer waits for `new`. A computed key and a decorator's
  // arguments run when the class is evaluated, which here is the render.
  it.each([
    ["a computed key", "[s.value] = 1;", "[_signals.capture(() => s.value)] = 1;"],
    ["a computed key of an accessor", "accessor [s.value] = 1;", "accessor [_signals.capture(() => s.value)] = 1;"],
    ["a decorator argument", "@dec(s.value) x = 1;", "@_signals.capture(() => dec(s.value))"],
  ])("selects the component and captures %s of an instance field", (_kind, member, output) => {
    const { code } = run(
      `import { dec } from "./x";\n${header}export function A() { class Model { ${member} } void Model; return <p>x</p>; }`,
    );
    expect(code).toContain(output);
  });

  it("leaves the initializer next to a captured key alone", () => {
    const { code } = run(
      `${header}export function A() { class Model { [s.value] = s.value; } void Model; return <p>x</p>; }`,
    );
    expect(code).toContain("[_signals.capture(() => s.value)] = s.value;");
  });

  it.each([
    ["a static field", "static snapshot = s.value;", "static snapshot = _signals.capture(() => s.value);"],
    ["a static block", "static { log(s.value); }", "_signals.capture(() => log(s.value));"],
  ])("captures %s of a class declared in render", (_kind, member, output) => {
    const { code } = run(
      `${header}function log(v: unknown) { void v; }\nexport function A() { class Model { ${member} } void Model; return <p>x</p>; }`,
    );
    expect(code).toContain(output);
  });
});

describe("what a helper reads is answered for the authored code", () => {
  // `Label` is transformed when it is visited: its read moves into a generated
  // capture callback. What `helper` reads must not depend on whether anyone
  // asked before or after that.
  const helper = "function helper() { return Label(); }";
  const label = "/** @signalTracking */ function Label() { return s.value; }";
  const app = "export function App() { return <p>{helper()}</p>; }";
  it.each([
    ["the helper first", [helper, label, app]],
    ["the annotated function first", [label, helper, app]],
    ["the caller first", [app, helper, label]],
  ])("selects the caller with %s", (_order, parts) => {
    const managed = run(`${header}${parts.join("\n")}`).code!;
    expect(managed).toMatch(/_signals\d*\.capture\(\(\) => helper\(\)\)/);
    const injected = run(`${header}${parts.join("\n")}`, { transform: "inject" }).code!;
    expect(injected).toMatch(/function App\(\) \{\s+"use no memo";\s+_useSignalTracking\(\);/);
  });
});

describe("a render prop that names a function", () => {
  // RFGS003 says a read's owner cannot be proven. A function that holds its own
  // boundary, or whose author opted out, is proven, whichever is declared first.
  const both = (a: string, b: string): string[] => [`${header}${a}\n${b}`, `${header}${b}\n${a}`];
  const tracking = `import { useSignalTracking } from "react-fine-grained-signals";\n`;
  const slots = [
    ["component", (name: string) => `<Grid component={${name}} />`],
    ["renderItem", (name: string) => `<Grid renderItem={${name}} />`],
    ["children", (name: string) => `<Grid>{${name}}</Grid>`],
  ] as const;
  const app = (slot: (name: string) => string, name: string): string => `export function A() { return ${slot(name)}; }`;

  describe.each(slots)("%s", (_slot, slot) => {
    it.each([
      ["a selected component", "function Row() { return <b>{s.value}</b>; }"],
      ["a selected arrow", "const Row = () => <b>{s.value}</b>;"],
      ["a component reading a parameter's value", "const Row = (item: any) => <li>{item.value}</li>;"],
      ["an annotated function", "/** @signalTracking */ function Row() { return <b>{s.value}</b>; }"],
      ["an opted-out function", "/** @noSignalTracking */ function Row() { return <b>{s.value}</b>; }"],
    ])("is quiet for %s in auto and all", (_kind, row) => {
      for (const mode of ["auto", "all"] as const) {
        for (const transform of ["managed", "inject"] as const) {
          for (const source of both(app(slot, "Row"), row)) {
            expect(run(source, { mode, transform }).diagnostics).toEqual([]);
          }
        }
      }
    });

    it.each([
      ["its first statement", "function Row() { useSignalTracking(); return <b>{s.value}</b>; }"],
      ["a later statement", "function Row() { const n = 1; useSignalTracking(); return <b>{s.value + n}</b>; }"],
    ])("is quiet for a function with its own Hook call in %s", (_kind, row) => {
      for (const mode of ["auto", "all"] as const) {
        for (const source of both(app(slot, "Row"), row)) {
          expect(run(tracking + source, { mode }).diagnostics).toEqual([]);
        }
      }
    });

    it.each([
      ["a lowercase helper", "row", "function row() { return <b>{s.value}</b>; }"],
      ["a lowercase arrow", "row", "const row = () => <b>{s.value}</b>;"],
      ["a function with no JSX", "Row", "function Row() { return s.value; }"],
      [
        "a mapped function",
        "Row",
        "function Row() { return <b>{s.value}</b>; }\nexport const L = ({ i }: any) => i.map(Row);",
      ],
      ["a plain-called function", "Row", "function Row() { return <b>{s.value}</b>; }\nexport const L = () => Row();"],
      ["an async function", "Row", "async function Row() { return <b>{s.value}</b>; }"],
    ])("reports %s, which has no boundary", (_kind, name, row) => {
      for (const mode of ["auto", "all"] as const) {
        for (const source of both(app(slot, name), row)) {
          expect(run(source, { mode }).diagnostics).toContain("RFGS003");
        }
      }
    });

    it("is quiet for a lowercase function that owns its reads or opted out", () => {
      for (const row of [
        "function row() { useSignalTracking(); return <b>{s.value}</b>; }",
        "/** @noSignalTracking */ function row() { return <b>{s.value}</b>; }",
      ]) {
        for (const source of both(app(slot, "row"), row)) {
          expect(run(tracking + source).diagnostics).toEqual([]);
        }
      }
    });

    it("reports an inline callback, and one named in a manual-mode opt-in that has no boundary", () => {
      const inline = run(`${header}${app(slot, "(() => <b>{s.value}</b>)")}`, { mode: "auto" });
      expect(inline.diagnostics).toContain("RFGS003");
      for (const source of both(
        `/** @signalTracking */ ${app(slot, "Row")}`,
        "function Row() { return <b>{s.value}</b>; }",
      )) {
        expect(run(source, { mode: "manual" }).diagnostics).toEqual(["RFGS003"]);
      }
      for (const source of both(
        `/** @signalTracking */ ${app(slot, "Row")}`,
        "/** @signalTracking */ function Row() { return <b>{s.value}</b>; }",
      )) {
        expect(run(source, { mode: "manual" }).diagnostics).toEqual([]);
      }
    });
  });

  it("answers for the copy a capture makes of a function declared in a callback", () => {
    const list = (name: string): string =>
      `${header}export function A({ i }: any) { return <p>{s.value}{i.map((x: number) => { const ${name} = () => <b>{s.value}</b>; return <Grid key={x} component={${name}} />; })}</p>; }`;
    expect(run(list("Row")).diagnostics).toEqual([]);
    expect(run(list("row")).diagnostics).toEqual(["RFGS003"]);
  });
});

describe("RFGS009 and an explicit annotation", () => {
  it.each(["auto", "all", "manual"] as const)(
    "reports an annotated function without an identity in %s mode",
    (mode) => {
      const { diagnostics } = run('"use server";\n/** @signalTracking */ export const row = () => <p />;', { mode });
      expect(diagnostics).toEqual(["RFGS009"]);
    },
  );

  it("reports once for an annotated function and a callback inside it", () => {
    const { diagnostics } = run(
      '"use server";\n/** @signalTracking */ export const row = () => <ul>{[1].map((i) => <li key={i} />)}</ul>;',
    );
    expect(diagnostics).toEqual(["RFGS009"]);
  });

  it("stays quiet for a server action with no annotation", () => {
    const { diagnostics } = run('"use server";\nexport const row = () => <p />;');
    expect(diagnostics).toEqual([]);
  });
});

describe("a Hook in a loop's iterable", () => {
  // As for a call (`wrapCallChain`): a precaution reports nothing, and a site
  // reports once.
  const prelude = `import { useX } from "./x";\nimport { ext } from "./ext";\n${header}function readS(_: unknown) { return [s.value]; }\nfunction* gen(_: unknown) { yield s.value; }\nconst list = signal([1]);\n`;
  const count = (statement: string): string[] =>
    run(`${prelude}export function A() { let n = 0; ${statement} return <p>{n}{s.value}</p>; }`).diagnostics;
  it.each([
    ["a method of a Hook's result", "for (const v of useX().items()) n += v;"],
    ["a method of an imported object", "for (const v of ext.items(useX())) n += v;"],
  ])("does not report a precaution: %s", (_kind, statement) => {
    expect(count(statement)).toEqual([]);
  });

  it.each([
    ["a helper that reads", "for (const v of readS(useX())) n += v;"],
    ["an imported function, as in a plain call", "for (const v of ext(useX())) n += v;"],
    ["a helper with a tracked argument", "for (const v of readS((useX(), list.value))) n += v;"],
    ["a generator that reads", "for (const v of gen(useX())) n += v;"],
    ["a helper that reads, in for...in", "for (const k in readS(useX())) n += k.length;"],
  ])("reports once: %s", (_kind, statement) => {
    expect(count(statement)).toEqual(["RFGS001"]);
  });
});

describe("a Hook link of an optional chain", () => {
  it.each([
    ["a plain call", "useThing().length"],
    ["an optional call", "useThing?.().length"],
  ])("does not report a Hook as a helper: %s", (_kind, read) => {
    const { diagnostics } = run(
      `import { useState } from "react";\n${header}function useThing() { useState(0); return [s.value]; }\nexport function A() { const n = ${read}; return <p>{n}{s.value}</p>; }`,
    );
    expect(diagnostics).toEqual([]);
  });
});

describe("delete through an optional chain", () => {
  it("captures the whole delete for a call link", () => {
    const { code } = run(
      `import { ext } from "./ext";\n${header}export function A(props: any) { delete props.a?.b().c; delete ext?.(1).d; return <p>{s.value}</p>; }`,
    );
    expect(code).toContain("_signals.capture(() => delete props.a?.b().c)");
    expect(code).toContain("_signals.capture(() => delete ext?.(1).d)");
  });

  it("does not capture one with no call", () => {
    const { code } = run(`${header}export function A(props: any) { delete props.a?.b.c; return <p>{s.value}</p>; }`);
    expect(code).toContain("delete props.a?.b.c;");
    expect(code).not.toContain("capture(() => delete");
  });
});

describe("a Hook's result in an operation", () => {
  // Reads in a Hook's arguments are captured one by one, and a Hook's result
  // is not a signal: nothing the operation does is lost.
  const prelude = `import { useT } from "./t";\n${header}const list = signal([1]);\n`;
  it.each([
    ["a coercion", 'const r = useT(s.value) + "x";'],
    ["a template literal", "const r = `${useT(s.value)}`;"],
    ["a coercion of a member", "const r = useT(s.value).x + 1;"],
    ["an in check", 'const r = "a" in useT(s.value);'],
    ["an object spread", "const r = { ...useT(s.value) };"],
    ["an array spread", "const r = [...useT(list.value)];"],
    ["a compound assignment", 'let r = ""; r += useT(s.value);'],
  ])("does not report %s", (_kind, statement) => {
    const { code, diagnostics } = run(`${prelude}export function A() { ${statement} return <p>{String(r)}</p>; }`);
    expect(diagnostics).toEqual([]);
    expect(code).toMatch(/useT\(_signals\.capture\(\(\) => (s|list)\.value\)\)/);
  });

  it.each([
    ["a read next to a Hook", "const r = s.value + useT(1);"],
    ["a read on a Hook's result", "const r = useT(1).value + 1;"],
    ["an array spread of a read next to a Hook", "const r = [...list.value, useT(1)];"],
  ])("still reports %s", (_kind, statement) => {
    const { diagnostics } = run(`${prelude}export function A() { ${statement} return <p>{String(r)}{s.value}</p>; }`);
    expect(diagnostics).toEqual(["RFGS001"]);
  });
});

describe("a function rewritten before what it calls is visited", () => {
  // Making a concise arrow's block must not change what the references in its
  // expression say: `Row` and `Label` are answered from those references, and
  // the answer is remembered. `all` and an annotation in `manual` have no dry
  // run on the authored code to answer first.
  const label = "function Label() { const x = s.value; return <p>{x}</p>; }";
  const row = "function Row(i: number) { return <p>{s.value}</p>; }";
  const holder = "const ns2 = { Label() { const x = s.value; return <p>{x}</p>; } };";
  const both = (a: string, b: string): string[] => [`${header}${a}\n${b}`, `${header}${b}\n${a}`];
  const routes = [
    ["all", ""],
    ["manual", "/** @signalTracking */ "],
    ["auto", ""],
  ] as const;

  describe.each(routes)("%s %s", (mode, annotation) => {
    it.each([
      ["a concise map", "export const List = ({ items }: any) => items.map(Row);"],
      ["a concise flatMap", "export const List = ({ items }: any) => items.flatMap(Row);"],
      ["a concise optional map", "export const List = ({ items }: any) => items?.map(Row);"],
      ["a concise map through a wrapper", "export const List = ({ items }: any) => items.map(Row as any);"],
      ["a block map", "export const List = ({ items }: any) => { return items.map(Row); };"],
    ])("keeps the callback of %s plain", (_kind, list) => {
      for (const source of both(annotation + list, row)) {
        const { code } = run(source, { mode });
        expect(code!.match(/= _useSignalCapture\(\)/g)).toHaveLength(1);
        expect(code).toMatch(/const _signals = _useSignalCapture\(\);\s+return _signals\.capture\(\(\) => items/);
      }
    });

    it.each([
      ["a concise call", "export const App = () => Label();", "Label()", label],
      ["a block call", "export const App = () => { return Label(); };", "Label()", label],
      ["a concise optional call", "export const App = () => Label?.();", "Label?.()", label],
      ["a concise conditional call", "export const App = ({ f }: any) => f ? Label() : null;", "Label()", label],
      ["a concise keyed call", "export const App = () => ns2.Label();", "ns2.Label()", holder],
    ])("captures %s of a plain-called component", (_kind, app, call, target) => {
      for (const source of both(annotation + app, target)) {
        const { code } = run(source, { mode });
        expect(code).toContain(`_signals.capture(() => ${call})`);
      }
    });
  });

  it.each([
    ["all", ""],
    ["manual", "/** @signalTracking */ "],
  ] as const)("keeps a concise arrow's references in inject too (%s)", (mode, annotation) => {
    for (const source of both(`${annotation}export const List = ({ items }: any) => items.map(Row);`, row)) {
      const { code } = run(source, { mode, transform: "inject" });
      expect(code!.match(/_useSignalTracking\(\);/g)).toHaveLength(1);
      expect(code).toMatch(/_useSignalTracking\(\);\s+return items\.map\(Row\);/);
    }
  });

  it("moves a default in front of a concise arrow's return, in both transforms", () => {
    for (const transform of ["managed", "inject"] as const) {
      const { code } = run(`${header}export const A = ({ x = s.value }: any) => <p>{x}</p>;`, { transform });
      expect(code).toMatch(/\} = _param;\s+return <p>\{x\}<\/p>;/);
    }
  });
});
