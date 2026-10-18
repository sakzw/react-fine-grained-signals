import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { rollup } from "rollup";
import esbuildAdapter from "../src/esbuild.js";
import loader from "../src/loader.js";
import rollupAdapter from "../src/rollup.js";
import viteAdapter from "../src/vite.js";
import { build as viteBuild } from "vite";
import {
  DIAGNOSTIC_IDS,
  isDiagnosticId,
  type DiagnosticId,
} from "../src/internal/diagnostics.js";
import { REACT_FINE_GRAINED_SIGNALS_DIAGNOSTIC_IDS } from "../src/unplugin.js";

type Warning = Error & { code?: string; diagnosticId?: string; loc?: { file?: string; line: number; column: number } };

/** Rollup/Vite-style context: `warn` collects, `error` throws, as `this.error` does there. */
function rollupContext(warnings: Warning[]) {
  return {
    warn(warning: Warning) {
      warnings.push(warning);
    },
    error(error: Warning) {
      throw Object.assign(new Error(error.message), error);
    },
  };
}

/** esbuild-style context: `error` records and returns, which is how esbuild's onLoad collects them. */
function esbuildContext(warnings: Warning[], errors: Warning[]) {
  return {
    warn(warning: Warning) {
      warnings.push(warning);
    },
    error(error: Warning) {
      errors.push(error);
    },
  };
}

type Transform = (this: unknown, code: string, id: string) => { code: string } | null;

function rollupTransform(options: Parameters<typeof rollupAdapter>[0]): Transform {
  return (rollupAdapter(options) as unknown as { transform: Transform }).transform;
}

/** One minimal module per diagnostic ID, each triggering exactly that category. */
const FIXTURES: Record<DiagnosticId, { id: string; code: string }> = {
  RFGS001: {
    id: "Panel.tsx",
    code: `import { useContext } from "react";
import { signal } from "react-fine-grained-signals";
const state = signal({ profile: 1 });
export function Panel() {
  const el = <p {...(useContext(Ctx), state.value.profile)} />;
  return el;
}
`,
  },
  RFGS002: {
    id: "App.tsx",
    code: `import { useState } from "react";
import { signal } from "react-fine-grained-signals";
const count = signal(0);
function renderTitle() { useState(0); return count.value; }
export function App() { const title = renderTitle(); return <p>{title}{count.value}</p>; }
`,
  },
  RFGS003: {
    id: "App.tsx",
    code: `import { signal } from "react-fine-grained-signals";
const count = signal(0);
export function App() {
  return <List itemContent={() => count.value} />;
}
`,
  },
  RFGS004: {
    id: "D.tsx",
    code: `import { signal } from "react-fine-grained-signals";
const count = signal(1);
export function D(v = count.value) { var v; return <p>{v}</p>; }
`,
  },
  RFGS005: {
    id: "Counter.tsx",
    code: `import { useSignalTracking } from "./signals.js";
export function Counter({ count }) {
  useSignalTracking();
  return <button>{count.value}</button>;
}
`,
  },
  RFGS006: {
    id: "Register.tsx",
    code: `const count = { value: 1 };
function register(fn) { return fn; }
register(/** @signalTracking */ () => <p>{count.value}</p>);
`,
  },
  RFGS007: {
    id: "123.tsx",
    code: `const count = { value: 1 };
export default (props) => <p>{count.value}</p>;
`,
  },
  RFGS008: {
    id: "Outer.tsx",
    code: `const count = { value: 1 };
function Title() { return <h1>{count.value}</h1>; }
export function Outer() { return <div><Title />{Title()}</div>; }
`,
  },
  RFGS009: {
    id: "ServerBadge.tsx",
    code: `"use server";
import { signal } from "react-fine-grained-signals";
const count = signal(0);
export function ServerBadge() { return <output>{count.value}</output>; }
`,
  },
};

function collect(id: string, code: string): Warning[] {
  const warnings: Warning[] = [];
  rollupTransform({ mode: "auto" }).call(rollupContext(warnings), code, id);
  return warnings;
}

describe("diagnostic IDs", () => {
  it("assigns one stable ID to each of the nine warning categories", () => {
    expect(DIAGNOSTIC_IDS).toEqual([
      "RFGS001", "RFGS002", "RFGS003", "RFGS004", "RFGS005",
      "RFGS006", "RFGS007", "RFGS008", "RFGS009",
    ]);
    expect(REACT_FINE_GRAINED_SIGNALS_DIAGNOSTIC_IDS).toBe(DIAGNOSTIC_IDS);
    expect(Object.keys(FIXTURES)).toHaveLength(DIAGNOSTIC_IDS.length);
    expect(Object.keys(FIXTURES)).toEqual(expect.arrayContaining([...DIAGNOSTIC_IDS]));
  });

  it.each(DIAGNOSTIC_IDS)("%s is recognised by isDiagnosticId", (id) => {
    expect(isDiagnosticId(id)).toBe(true);
  });

  it.each(["RFGS000", "RFGS010", "rfgs001", "RFGS", "", 1, null])("rejects %j", (value) => {
    expect(isDiagnosticId(value)).toBe(false);
  });

  it.each(DIAGNOSTIC_IDS)("%s is reported with its ID, location and code frame", (id) => {
    const fixture = FIXTURES[id];
    const warnings = collect(fixture.id, fixture.code).filter((warning) => warning.diagnosticId === id);

    expect(warnings).toHaveLength(1);
    const [warning] = warnings;
    expect(warning?.code).toBe("RFGS");
    expect(warning?.message).toMatch(new RegExp(`^\\[react-fine-grained-signals\\] ${id}: `));
    expect(warning?.message).toMatch(/> \d+ \|/);
    expect(warning?.loc).toEqual(expect.objectContaining({ line: expect.any(Number), column: expect.any(Number) }));
  });
});

describe("diagnostics.errorOn", () => {
  const warnOnly = FIXTURES.RFGS007.code;
  // Named apart from `warnOnly`'s `count`, so the two can share one module.
  const renderProp = `const label = { value: 1 };
export function List() { return <Grid renderItem={() => label.value} />; }
`;

  it("keeps every diagnostic a warning when errorOn is not set", () => {
    const warnings: Warning[] = [];
    const result = rollupTransform({ mode: "auto" }).call(rollupContext(warnings), warnOnly, "123.tsx");

    expect(result).toBeNull();
    expect(warnings.map((warning) => warning.diagnosticId)).toEqual(["RFGS007"]);
  });

  it("promotes only the listed ID and leaves other diagnostics as warnings", () => {
    const source = `${warnOnly}${renderProp}`;
    const warnings: Warning[] = [];

    // Promoting RFGS003 fails the build on the render prop; RFGS007 stays a warning.
    expect(() => rollupTransform({ mode: "auto", diagnostics: { errorOn: ["RFGS003"] } })
      .call(rollupContext(warnings), source, "123.tsx")).toThrow(/RFGS003/);
    expect(warnings.map((warning) => warning.diagnosticId)).toEqual(["RFGS007"]);
  });

  it("promotes a diagnostic to a build error in a standalone Rollup build", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rfsg-rollup-diagnostic-"));
    const input = join(directory, "123.tsx");
    writeFileSync(input, warnOnly);

    try {
      await expect(rollup({
        input,
        plugins: [rollupAdapter({ mode: "auto", diagnostics: { errorOn: ["RFGS007"] } }) as never],
        onwarn(warning) {
          throw new Error(`Unexpected Rollup warning: ${warning.message}`);
        },
      })).rejects.toMatchObject({
        code: "PLUGIN_ERROR",
        pluginCode: "RFGS",
        diagnosticId: "RFGS007",
        loc: expect.objectContaining({ line: expect.any(Number), column: expect.any(Number) }),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails on the promoted diagnostic and keeps its message, code frame and location", () => {
    const failure = (() => {
      try {
        rollupTransform({ mode: "auto", diagnostics: { errorOn: ["RFGS007"] } })
          .call(rollupContext([]), warnOnly, "/project/src/123.tsx");
      } catch (error) {
        return error as Warning;
      }
      return undefined;
    })();

    expect(failure?.message).toContain("[react-fine-grained-signals] RFGS007: ");
    expect(failure?.message).toMatch(/> \d+ \|/);
    expect(failure?.code).toBe("RFGS");
    expect(failure?.diagnosticId).toBe("RFGS007");
    expect(failure?.loc).toEqual({ file: "/project/src/123.tsx", line: 2, column: 15 });
  });

  it("reports every promoted diagnostic when the bundler context does not throw", () => {
    const errors: Warning[] = [];
    const warnings: Warning[] = [];
    const source = `${warnOnly}${renderProp}`;

    const result = rollupTransform({
      mode: "auto",
      diagnostics: { errorOn: ["RFGS003", "RFGS007"] },
    }).call(esbuildContext(warnings, errors), source, "123.tsx");

    expect(warnings).toEqual([]);
    expect(errors.map((error) => error.diagnosticId)).toHaveLength(2);
    expect(errors.map((error) => error.diagnosticId)).toEqual(expect.arrayContaining(["RFGS003", "RFGS007"]));
    // Nothing transformed, so the output is what a warning-only run returns.
    expect(result).toBeNull();
  });

  it("leaves the transform output unchanged, whatever errorOn names", () => {
    // A transformed component next to a warned one, so the output is non-trivial.
    const source = `import { signal } from "react-fine-grained-signals";
const count = signal(0);
export function Counter() { return <button>{count.value}</button>; }
${renderProp}`;
    const plain = rollupTransform({ mode: "auto" }).call(esbuildContext([], []), source, "Module.tsx");
    const promoted = rollupTransform({
      mode: "auto",
      diagnostics: { errorOn: ["RFGS003"] },
    }).call(esbuildContext([], []), source, "Module.tsx");

    expect(plain?.code).toContain("_signals");
    expect(promoted).toEqual(plain);
  });

  it("does not change a module with no diagnostics", () => {
    const clean = `import { signal } from "react-fine-grained-signals";
const count = signal(0);
export function Counter() { return <button>{count.value}</button>; }
`;
    const warnings: Warning[] = [];
    const baseline = rollupTransform({ mode: "auto" }).call(rollupContext(warnings), clean, "Counter.tsx");
    const withPolicy = rollupTransform({
      mode: "auto",
      diagnostics: { errorOn: DIAGNOSTIC_IDS },
    }).call(rollupContext(warnings), clean, "Counter.tsx");

    expect(warnings).toEqual([]);
    expect(withPolicy).toEqual(baseline);
    expect(baseline).not.toBeNull();
  });

  it("rejects an unknown ID when the plugin is created, not silently at build time", () => {
    expect(() => rollupAdapter({
      diagnostics: { errorOn: ["RFGS042" as DiagnosticId] },
    })).toThrow(/unknown diagnostic ID: RFGS042/);
  });

  it("does not report a duplicate for a site reached more than once", () => {
    const warnings: Warning[] = [];
    rollupTransform({ mode: "auto" }).call(rollupContext(warnings), FIXTURES.RFGS003.code, "App.tsx");

    expect(warnings.filter((warning) => warning.diagnosticId === "RFGS003")).toHaveLength(1);
  });

  it("promotes the same diagnostic through the Vite adapter", () => {
    const plugin = viteAdapter({ diagnostics: { errorOn: ["RFGS007"] } }) as unknown as {
      transform: { handler: Transform };
    };

    expect(() => plugin.transform.handler.call(rollupContext([]), warnOnly, "/project/src/123.tsx"))
      .toThrow(/RFGS007/);
  });

  it("promotes the same diagnostic through the webpack/rspack loader", async () => {
    const plugin = rollupAdapter({ diagnostics: { errorOn: ["RFGS007"] } });
    const run = await new Promise<{ error: Warning | null }>((resolve) => {
      const context = {
        async: () => (error: Warning | null) => resolve({ error }),
        query: { plugin },
        resource: "/project/src/123.tsx",
        emitWarning() {
          throw new Error("a promoted diagnostic must not be emitted as a warning");
        },
      };
      loader.call(context as never, warnOnly, undefined);
    });

    expect(run.error?.message).toContain("RFGS007");
    expect(run.error?.diagnosticId).toBe("RFGS007");
    expect(run.error?.code).toBe("RFGS");
  });

  it.each([
    ["without an incoming source map", undefined],
    ["with an incoming source map", {
      version: 3,
      sources: ["/project/src/123.tsx"],
      names: [],
      mappings: "AAAA",
    }],
  ])("keeps promoted diagnostics as loader errors %s without duplicating other warnings", async (_label, map) => {
    const source = `${warnOnly}${renderProp}`;
    const plugin = rollupAdapter({ mode: "auto", diagnostics: { errorOn: ["RFGS003"] } });
    const warnings: Warning[] = [];
    const run = await new Promise<{ error: Warning | null }>((resolve) => {
      const context = {
        async: () => (error: Warning | null) => resolve({ error }),
        query: { plugin },
        resource: "/project/src/123.tsx",
        emitWarning(warning: Warning) {
          warnings.push(warning);
        },
      };
      loader.call(context as never, source, map);
    });

    expect(run.error?.message).toContain("[react-fine-grained-signals] RFGS003: ");
    expect(run.error?.message).toMatch(/> \d+ \|/);
    expect(run.error?.code).toBe("RFGS");
    expect(run.error?.diagnosticId).toBe("RFGS003");
    expect(run.error?.loc).toEqual(expect.objectContaining({
      file: "/project/src/123.tsx",
      line: expect.any(Number),
      column: expect.any(Number),
    }));
    expect(warnings.map((warning) => warning.diagnosticId)).toEqual(["RFGS007"]);
  });
});

describe("real bundler builds", () => {
  const dir = mkdtempSync(join(tmpdir(), "rfgs-diagnostics-"));
  const entry = join(dir, "123.tsx");
  // The JSX runtime the transformed module imports, stubbed so Vite can finish the build.
  const jsxRuntime = join(dir, "jsx-runtime-stub.js");
  writeFileSync(entry, FIXTURES.RFGS007.code);
  writeFileSync(jsxRuntime, "export const jsx = () => null;\nexport const jsxs = jsx;\nexport const jsxDEV = jsx;\nexport const Fragment = null;\n");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const viteConfig = (errorOn: DiagnosticId[]) => ({
    configFile: false as const,
    root: dir,
    logLevel: "silent" as const,
    resolve: { alias: [{ find: /^react\/jsx-(dev-)?runtime$/, replacement: jsxRuntime }] },
    plugins: [viteAdapter({ diagnostics: { errorOn } })],
    build: { write: false, rollupOptions: { input: entry } },
  });

  it("esbuild: warns with the ID and its location by default", async () => {
    const esbuild = await import("esbuild");
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      logLevel: "silent",
      plugins: [esbuildAdapter({})],
    });

    const warning = result.warnings.find((item) => item.text.includes("RFGS007"));
    expect(warning?.location?.line).toBe(2);
  }, 60_000);

  it("esbuild: a promoted ID fails the build and names the ID", async () => {
    const esbuild = await import("esbuild");
    await expect(esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      logLevel: "silent",
      plugins: [esbuildAdapter({ diagnostics: { errorOn: ["RFGS007"] } })],
    })).rejects.toThrow(/RFGS007/);
  }, 60_000);

  it("vite: a promoted ID fails vite.build and names the ID", async () => {
    await expect(viteBuild(viteConfig(["RFGS007"]))).rejects.toThrow(/RFGS007/);
  }, 60_000);

  it("vite: other IDs stay warnings, so the same build succeeds", async () => {
    await expect(viteBuild(viteConfig(["RFGS003"]))).resolves.toBeDefined();
  }, 60_000);
});
