import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const copyRoot = await mkdtemp(join(sourceDir, ".owner-copies-"));
const files = [
  "alien-derived-runtime-owner-core.mjs",
  "alien-derived-runtime-foreign-adapter.mjs",
  "alien-derived-runtime-execution-owner.mjs",
  "alien-derived-runtime-interop-context.mjs",
];

try {
  const copies = await Promise.all(["a", "b"].map(async (name) => {
    const destination = join(copyRoot, name);
    await mkdir(destination);
    await Promise.all(files.map((file) => copyFile(join(sourceDir, file), join(destination, file))));
    return import(pathToFileURL(join(destination, files[0])).href);
  }));
  const [copyA, copyB] = copies;
  const foreign = copyB.signalClassBrandHelper(1);
  const seen = [];
  const dispose = copyA.effect(() => { seen.push(foreign.value); });
  foreign.value = 2;
  assert.deepEqual(seen, [1, 2], "copy A graph observes copy B source writes");
  dispose();
  foreign.value = 3;
  assert.deepEqual(seen, [1, 2], "disposing the foreign edge unsubscribes it");

  const source = copyB.signalClassBrandHelper(2);
  const derived = copyB.computedClassBrandHelper(() => source.value * 10);
  const computedValues = [];
  const disposeComputed = copyA.effect(() => { computedValues.push(derived.value); });
  source.value = 3;
  assert.deepEqual(computedValues, [20, 30], "foreign computed chains notify the other graph");
  disposeComputed();

  const untrackedSource = copyB.signalClassBrandHelper("before");
  let untrackedRuns = 0;
  const disposeUntracked = copyA.effect(() => {
    untrackedRuns += 1;
    copyA.untracked(() => untrackedSource.value);
  });
  untrackedSource.value = "after";
  assert.equal(untrackedRuns, 1, "untracked suppresses a nested foreign owner read");
  disposeUntracked();

  const chooseLeft = copyA.signalClassBrandHelper(true);
  const left = copyB.signalClassBrandHelper("left");
  const right = copyB.signalClassBrandHelper("right");
  const dynamicValues = [];
  const disposeDynamic = copyA.effect(() => {
    dynamicValues.push(chooseLeft.value ? left.value : right.value);
  });
  chooseLeft.value = false;
  const afterSwitch = dynamicValues.length;
  left.value = "stale";
  assert.equal(dynamicValues.length, afterSwitch, "dynamic switching releases the old foreign dependency");
  right.value = "current";
  assert.equal(dynamicValues.at(-1), "current", "the new foreign dependency remains live");
  disposeDynamic();

  const batchLeft = copyB.signalClassBrandHelper(1);
  const batchRight = copyB.signalClassBrandHelper(2);
  const batchRuns = [];
  const disposeBatch = copyA.effect(() => { batchRuns.push(batchLeft.value + batchRight.value); });
  copyB.batch(() => { batchLeft.value = 10; batchRight.value = 20; });
  assert.equal(batchRuns.at(-1), 30, "cross-copy batch observes the final combined value");
  disposeBatch();

  console.log(JSON.stringify({ status: "pass", batchEffectRuns: batchRuns.length }));
} finally {
  await rm(copyRoot, { recursive: true, force: true });
}
