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
});
