import assert from "node:assert/strict";
import { readFile, readdir, rm, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const outputRoot = join(repoRoot, "node_modules", ".cache", "phase4-duplicate-smoke");
const fixture = join(repoRoot, "tests", "fixtures", "phase4-duplicate-entry.ts");
const { build } = await import("tsdown");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

try {
  const copies = [];
  for (const name of ["copy-a", "copy-b", "copy-c"]) {
    const outDir = join(outputRoot, name);
    await build({
      config: false,
      entry: { index: fixture },
      outDir,
      format: "esm",
      platform: "neutral",
      dts: false,
      sourcemap: false,
      clean: true,
      deps: { alwaysBundle: [/^alien-signals(?:\/|$)/] },
    });
    copies.push(await import(pathToFileURL(join(outDir, "index.js")).href));
    const jsFiles = (await readdir(outDir, { recursive: true })).filter((file) => file.endsWith(".js"));
    let alienImportFound = false;
    for (const file of jsFiles) {
      const contents = await readFile(join(outDir, file), "utf8");
      alienImportFound ||= /^\s*(?:import|export)\b[^\n]*\bfrom\s*["']alien-signals(?:\/|["'])/m.test(contents);
    }
    assert.equal(alienImportFound, false, `${name} must contain its own alien-signals system`);
  }

  const [copyA, copyB, copyC] = copies;
  assert.notEqual(copyA.createReactiveRuntime, copyB.createReactiveRuntime);
  assert.notEqual(copyB.createReactiveRuntime, copyC.createReactiveRuntime);
  assert.equal(copyA.getSharedInteropContext(), copyB.getSharedInteropContext());
  assert.equal(copyB.getSharedInteropContext(), copyC.getSharedInteropContext());
  assert.equal(copyA.READABLE_INTEROP_V1, copyB.READABLE_INTEROP_V1);

  copyA.withInteropSpeculativeMode(() => {
    copyB.withInteropSpeculativeMode(() => {
      assert.equal(copyC.getSharedInteropContext().speculativeDepth, 2);
      copyC.withoutInteropSpeculativeMode(() => {
        assert.equal(copyA.getSharedInteropContext().speculativeDepth, 0);
      });
      assert.equal(copyB.getSharedInteropContext().speculativeDepth, 2);
    });
  });
  assert.equal(copyC.getSharedInteropContext().speculativeDepth, 0);

  const runtimeA = copyA.createReactiveRuntime();
  const runtimeB = copyB.createReactiveRuntime();
  const runtimeC = copyC.createReactiveRuntime();

  // A live local branch can switch between separately bundled foreign runtimes.
  const chooseB = runtimeA.signal(true);
  const sourceB = runtimeB.signal("B");
  const sourceC = runtimeC.signal("C");
  const selected = runtimeA.computed(() => chooseB.value ? sourceB.value : sourceC.value);
  const seen = [];
  const disposeSelected = runtimeA.effect(() => seen.push(selected.value));
  chooseB.value = false;
  sourceB.value = "stale B";
  sourceC.value = "updated C";
  assert.deepEqual(seen, ["B", "C", "updated C"]);
  disposeSelected();

  // Computed equality and Object.is semantics cross independent package copies.
  const roundedSource = runtimeB.signal(10);
  const rounded = runtimeB.computed(() => Math.floor(roundedSource.value / 10));
  const equalitySeen = [];
  const disposeEquality = runtimeA.effect(() => equalitySeen.push(rounded.value));
  roundedSource.value = 11;
  roundedSource.value = 20;
  assert.deepEqual(equalitySeen, [1, 2]);
  disposeEquality();

  const zeroSource = runtimeB.signal(0);
  const zeroSeen = [];
  const disposeZero = runtimeA.effect(() => zeroSeen.push(zeroSource.value));
  zeroSource.value = -0;
  zeroSource.value = Number.NaN;
  zeroSource.value = Number.NaN;
  assert.equal(zeroSeen.length, 3);
  assert.equal(Object.is(zeroSeen[0], 0), true);
  assert.equal(Object.is(zeroSeen[1], -0), true);
  assert.equal(Number.isNaN(zeroSeen[2]), true);
  disposeZero();

  // A -> B -> C computed links preserve intermediate equality boundaries.
  const transitiveSource = runtimeC.signal(1);
  const middle = runtimeB.computed(() => transitiveSource.value % 2);
  const outer = runtimeA.computed(() => middle.value + 1);
  assert.equal(outer.value, 2);
  transitiveSource.value = 3;
  assert.equal(outer.value, 2);
  transitiveSource.value = 4;
  assert.equal(outer.value, 1);

  // Cold nested foreign computed chains pull fresh values without live observers.
  const coldSource = runtimeC.signal(4);
  const coldMiddle = runtimeB.computed(() => coldSource.value + 1);
  const cold = runtimeA.computed(() => coldMiddle.value * 2);
  assert.equal(cold.value, 10);
  coldSource.value = 9;
  assert.equal(cold.value, 20);

  // Errors recover across independently bundled runtime boundaries.
  const errorSource = runtimeB.signal(1);
  const errorValue = runtimeB.computed(() => {
    if (errorSource.value === 2) throw new Error("foreign failure");
    return errorSource.value;
  });
  const errorValues = [];
  const disposeError = runtimeA.effect(() => {
    try { errorValues.push(errorValue.value); } catch { errorValues.push("error"); }
  });
  errorSource.value = 2;
  errorSource.value = 3;
  assert.deepEqual(errorValues, [1, "error", 3]);
  disposeError();

  // Bounded feedback crosses two- and three-runtime independent systems.
  const cycleA = runtimeA.signal(0);
  const cycleB = runtimeB.signal(0);
  const cycleC = runtimeC.signal(0);
  let runs = 0;
  const disposeA = runtimeA.effect(() => {
    runs += 1;
    if (cycleC.value > cycleA.value) cycleA.value = cycleC.value;
  });
  const disposeB = runtimeB.effect(() => {
    if (cycleA.value > cycleB.value) cycleB.value = cycleA.value;
  });
  const disposeC = runtimeC.effect(() => {
    if (cycleB.value > cycleC.value) cycleC.value = cycleB.value;
  });
  cycleA.value = 1;
  assert.deepEqual([cycleA.value, cycleB.value, cycleC.value], [1, 1, 1]);
  assert.ok(runs < 10);
  disposeA();
  disposeB();
  disposeC();

  console.log("Private ReactiveRuntime duplicate-runtime smoke passed (3 independent Alien systems).");
} finally {
  await rm(outputRoot, { recursive: true, force: true });
}
