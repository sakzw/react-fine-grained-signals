// @vitest-environment jsdom
/// <reference lib="dom" />

/**
 * Compares the plugin with the runtime. `selection-capture-consistency.test.ts`
 * checks that the plugin agrees with itself; this test checks, for the same
 * read shapes (`read-shapes.ts`), that a compiled component re-renders when
 * the runtime's own tracking says it should.
 *
 * - Oracle: the untransformed module, with a hand-written first-statement
 *   `useSignalTracking()` in the function under test. The runtime then tracks
 *   every signal read made synchronously while that render runs.
 * - Candidates: the same module without that call, compiled in `auto` mode
 *   with `transform: "managed"` and with `"inject"`, each alone and with an
 *   unrelated render read (`o.value`) added.
 *
 * Each version is mounted with a render counter, the case's signal is written
 * (`s.value = 5` by default), and the update is flushed. A candidate must
 * re-render exactly when the oracle does, and show the same text then. A write
 * to a signal nothing reads (`u`) must re-render neither. A case may differ
 * from the oracle only in the way its `run.exception` (documented design, with
 * the citation) or `run.knownLimitation` states.
 */

import * as React from "react";
import { act, createElement, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, onTestFailed } from "vitest";
import { loadModule } from "./execution-harness.js";
import { cases, component, hook, hookCases, marker, type Case, type Outcome } from "./read-shapes.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const call = (value: unknown): unknown => (typeof value === "function" ? (value as () => unknown)() : value);
/** What `./ext` stands for: an imported helper that calls whatever function it is handed. */
function ext(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(call).join();
  if (typeof input === "object" && input !== null && "cb" in input) return call(input.cb);
  return call(input);
}
const extStore = { map: (callback: () => unknown) => callback() };

interface Probe {
  renders: number;
  write?: () => void;
  unrelated?: () => void;
}

/** One mounted version of a case: the oracle, a candidate, or (as a control) the plain source. */
interface Observation {
  /** Whether the write re-rendered the function under test. */
  rerendered: boolean;
  /** The text before and after the write. */
  before: string;
  after: string;
  /** Whether the unrelated write re-rendered it. */
  unrelated: boolean;
  source: string;
}

const mounted: { root: Root; container: HTMLElement }[] = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

const kinds = {
  component: { build: component, exportName: (testCase: Case) => (testCase.shape === "default" ? "default" : "C") },
  hook: { build: hook, exportName: () => "useX" },
} as const;
type Kind = keyof typeof kinds;

/** The source of the oracle: the case with a hand-written first-statement `useSignalTracking()`. */
function oracleSource(testCase: Case, kind: Kind, companion: boolean): string {
  const source = kinds[kind].build({ ...testCase, ...testCase.run?.oracle }, companion);
  const tracked = source.replace(`\n${marker}\n`, `\n__track();\n${marker}\n`);
  if (tracked === source) throw new Error("no marker to place the oracle's boundary at");
  return `import { useSignalTracking as __track } from "react-fine-grained-signals";\n${tracked}`;
}

async function run(
  testCase: Case,
  kind: Kind,
  version: "oracle" | "managed" | "inject" | "plain",
  companion: boolean,
): Promise<Observation> {
  const probe: Probe = { renders: 0 };
  const write = testCase.run?.write ?? "s.value = 5;";
  let source = "";
  const module = await loadModule(
    version === "oracle" ? oracleSource(testCase, kind, companion) : kinds[kind].build(testCase, companion),
    {
      transform: version === "managed" || version === "inject",
      mode: "auto",
      codegen: version === "inject" ? "inject" : "managed",
      typescript: true,
      modules: { react: React, "./ext": { ext, extStore } },
      scope: { __probe: probe },
      warn: () => {},
      // Count renders and reach the module's signals without changing what
      // the transform sees: both are added to its output.
      rewrite(code) {
        const counted = code.replace(marker, `${marker} __probe.renders++;`);
        if (counted === code) throw new Error("the transform dropped the marker");
        source = `${counted}\n__probe.write = () => { ${write} };\n__probe.unrelated = () => { u.value = 4; };\n`;
        return source;
      },
    },
  );
  const target = module[kinds[kind].exportName(testCase)] as FunctionComponent;
  const props = testCase.run?.props ?? {};
  const rendered =
    kind === "component"
      ? createElement(target, props)
      : createElement(function Host() {
          return createElement("p", null, String((target as (props: object) => unknown)(props)));
        });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => root.render(rendered));
  const before = container.textContent ?? "";
  let renders = probe.renders;
  act(() => probe.write!());
  const rerendered = probe.renders > renders;
  const after = container.textContent ?? "";
  renders = probe.renders;
  act(() => probe.unrelated!());
  return { rerendered, before, after, unrelated: probe.renders > renders, source };
}

interface Observed {
  oracle: { alone: boolean; companion: boolean };
  rerenders: Record<Outcome, boolean>;
}

async function differential(testCase: Case, kind: Kind): Promise<void> {
  const runs: Record<string, Observation> = {};
  for (const companion of [false, true]) {
    const variant = companion ? "companion" : "alone";
    for (const version of ["oracle", "managed", "inject"] as const) {
      runs[`${version} ${variant}`] = await run(testCase, kind, version, companion);
    }
  }
  onTestFailed(() => {
    for (const [name, { source }] of Object.entries(runs)) console.error(`--- ${name}\n${source}`);
  });

  const observed: Observed = {
    oracle: { alone: runs["oracle alone"]!.rerendered, companion: runs["oracle companion"]!.rerendered },
    rerenders: {
      "managed alone": runs["managed alone"]!.rerendered,
      "managed companion": runs["managed companion"]!.rerendered,
      "inject alone": runs["inject alone"]!.rerendered,
      "inject companion": runs["inject companion"]!.rerendered,
    },
  };
  const { exception, knownLimitation } = testCase.run ?? {};
  const expected: Record<Outcome, boolean> = { ...observed.rerenders };
  // An exception records a disagreement with the oracle; one that no longer
  // disagrees is stale and must go.
  const staleExceptions: Outcome[] = [];
  for (const outcome of Object.keys(expected) as Outcome[]) {
    const oracle = observed.oracle[outcome.endsWith("alone") ? "alone" : "companion"];
    expected[outcome] = exception?.rerenders[outcome] ?? knownLimitation?.rerenders[outcome] ?? oracle;
    if (exception?.rerenders[outcome] === oracle) staleExceptions.push(outcome);
  }
  expect(staleExceptions, "exceptions that no longer differ from the oracle").toEqual([]);
  expect(observed.rerenders).toEqual(expected);

  for (const variant of ["alone", "companion"] as const) {
    const oracle = runs[`oracle ${variant}`]!;
    for (const candidate of ["managed", "inject"] as const) {
      const outcome: Outcome = `${candidate} ${variant}`;
      const ran = runs[outcome]!;
      expect(ran.before, `${outcome}: text on mount`).toBe(oracle.before);
      const deviation = [exception, knownLimitation].find((entry) => entry?.rerenders[outcome] !== undefined);
      expect(ran.after, `${outcome}: text after the write`).toBe(deviation?.stale ? ran.before : oracle.after);
    }
  }
  for (const [name, { unrelated }] of Object.entries(runs)) {
    expect(unrelated, `${name}: re-rendered on an unrelated write`).toBe(false);
  }
}

const runnable = (list: readonly Case[]): Case[] => list.filter((testCase) => testCase.run?.skip === undefined);

describe("compiled components re-render when the runtime's own tracking does", () => {
  it.each(runnable(cases))("$name", async (testCase) => {
    await expect(differential(testCase, "component")).resolves.toBeUndefined();
  });
});

describe("the same holds for a custom Hook", () => {
  it.each(runnable(hookCases))("$name", async (testCase) => {
    await expect(differential(testCase, "hook")).resolves.toBeUndefined();
  });
});

describe("cases that cannot run", () => {
  // Each reason is the case's `run.skip` in `read-shapes.ts`; pinning the
  // names keeps a new skip from going unnoticed.
  it("are only these", () => {
    expect(cases.filter((testCase) => testCase.run?.skip !== undefined).map(({ name }) => name)).toEqual([
      "a useComputed getter",
      "use()",
      "an async component",
      "a decorator argument of a class method",
    ]);
  });
});

describe("the harness", () => {
  it("sees that an untransformed component without a boundary does not re-render", async () => {
    const testCase = cases.find(({ name }) => name === "a JSX child")!;
    const oracle = await run(testCase, "component", "oracle", false);
    const plain = await run(testCase, "component", "plain", false);
    expect({ oracle: oracle.rerendered, plain: plain.rerendered }).toEqual({ oracle: true, plain: false });
    expect({ oracle: oracle.after, plain: plain.after }).toEqual({ oracle: "5", plain: "1" });
  });
});
