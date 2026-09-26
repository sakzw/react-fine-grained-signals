import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureEntry = join(repositoryRoot, "tests/phase6/fixtures/candidate-c1-public-entry.ts");
const temporaryRoot = mkdtempSync(join(tmpdir(), "rfgs-phase6-c1-copies-"));

try {
  const copies = [];
  for (const name of ["copy-a", "copy-b", "copy-c"]) {
    const outDir = join(temporaryRoot, name);
    await build({
      configFile: false,
      logLevel: "silent",
      build: {
        outDir,
        emptyOutDir: true,
        minify: true,
        lib: { entry: fixtureEntry, formats: ["es"], fileName: () => "index.js" },
      },
    });
    copies.push(await import(pathToFileURL(join(outDir, "index.js")).href));
  }
  const [copyA, copyB, copyC] = copies;
  const source = copyB.signal(1);
  const brand = Symbol.for("react-fine-grained-signals.signal");
  const interop = Symbol.for("react-fine-grained-signals.readable-interop.v1");
  assert.equal(copyA.isSignal(source), true, "isSignal must recognize a readable from another compiled copy");
  assert.equal(source[brand], 1);
  assert.equal(source[interop]?.version, 1, "foreign readable must expose V1");
  assert.equal(typeof source[interop]?.getRevision, "function");
  assert.equal(typeof source[interop]?.subscribe, "function");

  const doubled = copyA.computed(() => source.value * 2);
  assert.equal(doubled.value, 2);
  source.value = 3;
  assert.equal(doubled.value, 6, "foreign signal updates must invalidate a local computed");

  const remoteComputed = copyC.computed(() => source.value + 4);
  const seen = [];
  const dispose = copyA.effect(() => { seen.push(remoteComputed.value); });
  source.value = 5;
  assert.deepEqual(seen, [7, 9], "foreign computed updates must invalidate a local effect");
  dispose();

  const local = copyA.signal(10);
  const foreignDerived = copyB.computed(() => local.value + 1);
  assert.equal(foreignDerived.value, 11);
  local.value = 12;
  assert.equal(foreignDerived.value, 13, "interop updates must work from copy A into copy B");

  const foreignRuns = [];
  const disposeForeign = copyC.effect(() => { foreignRuns.push(local.value); });
  local.value = 13;
  assert.deepEqual(foreignRuns, [12, 13], "effect notifications must work in the reverse direction");
  disposeForeign();

  console.log("Candidate C1 duplicate-copy smoke passed (3 separately bundled C1 runtimes).");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
