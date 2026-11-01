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
