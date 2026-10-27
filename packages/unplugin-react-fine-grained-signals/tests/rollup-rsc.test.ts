import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rollup, type OutputChunk, type Plugin, type RollupLog } from "rollup";
import { transformWithOxc } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import rollupAdapter from "../src/rollup.js";

const fixtureDir = mkdtempSync(join(tmpdir(), "signals-rollup-rsc-"));
const serverEntry = join(fixtureDir, "server.jsx");
const clientEntry = join(fixtureDir, "client.jsx");

writeFileSync(
  serverEntry,
  [
    '"use server";',
    'import { signal } from "react-fine-grained-signals";',
    "const count = signal(0);",
    "export function ServerAction() { return <output>{count.value}</output>; }",
    "",
  ].join("\n"),
);
writeFileSync(
  clientEntry,
  [
    '"use client";',
    'import { signal } from "react-fine-grained-signals";',
    "const count = signal(0);",
    "export function Client() { return <output>{count.value}</output>; }",
    "",
  ].join("\n"),
);

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

// Rollup does not parse JSX itself. Keep the adapter under test first, then
// lower JSX with the same Oxc transform used by the Vite qualification.
const jsxTransform: Plugin = {
  name: "test-jsx-transform",
  async transform(code, id) {
    if (!/\.jsx?$/.test(id)) return null;
    const result = await transformWithOxc(code, id, {
      lang: "jsx",
      jsx: { runtime: "automatic", importSource: "react" },
      sourcemap: true,
    });
    return { code: result.code, map: result.map };
  },
};

describe("Rollup adapter RSC integration", () => {
  it("skips use server, warns at its source, transforms use client, and preserves entry maps", async () => {
    const warnings: RollupLog[] = [];
    const bundle = await rollup({
      input: { server: serverEntry, client: clientEntry },
      external: [/^react-fine-grained-signals(?:\/|$)/, /^react(?:\/|$)/],
      plugins: [rollupAdapter({ mode: "auto" }) as Plugin, jsxTransform],
      onwarn(warning) {
        warnings.push(warning);
      },
    });

    try {
      const { output } = await bundle.generate({ format: "es", sourcemap: true });
      const server = output.find((item): item is OutputChunk => item.type === "chunk" && item.name === "server");
      const client = output.find((item): item is OutputChunk => item.type === "chunk" && item.name === "client");
      const rfgsWarning = warnings.find((warning) => warning.pluginCode === "RFGS");

      expect(rfgsWarning?.message).toContain('top-level "use server" directive');
      expect(rfgsWarning?.message).toContain("> 4 | export function ServerAction()");
      expect(rfgsWarning?.loc).toMatchObject({ file: serverEntry, line: 4 });

      expect(server?.code).not.toContain("useSignalCapture");
      expect(client?.code).toContain("useSignalCapture");
      expect(server?.map?.sources.some((source) => source.endsWith("server.jsx"))).toBe(true);
      expect(client?.map?.sources.some((source) => source.endsWith("client.jsx"))).toBe(true);
    } finally {
      await bundle.close();
    }
  });
});
