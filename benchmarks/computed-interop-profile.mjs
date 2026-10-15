import os from "node:os";
import { readdir } from "node:fs/promises";

const iterations = Number.parseInt(process.env.BENCH_ITERATIONS ?? "1000", 10);
const warmups = Number.parseInt(process.env.BENCH_WARMUPS ?? "2", 10);
const samples = Number.parseInt(process.env.BENCH_SAMPLES ?? "7", 10);
if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error("BENCH_ITERATIONS must be a positive integer");

const runtimeFile = (await readdir(new URL("../dist/", import.meta.url)))
  .find((entry) => /^core-runtime-.*\.js$/.test(entry));
if (!runtimeFile) throw new Error("Build the runtime before running computed-interop-profile.mjs");
const runtimeUrl = new URL(`../dist/${runtimeFile}`, import.meta.url).href;
// Import the exact same built runtime as two independent ESM module instances.
// Each copy has its own graph and adapter maps while the public interop Symbol
// and cross-copy owner registry continue to use their shared global keys.
const [moduleA, moduleB] = await Promise.all([
  import(runtimeUrl),
  import(`${runtimeUrl}?m14-copy=2`),
]);
function runtimeFrom(module) {
  return Object.values(module).find((value) =>
    value !== null && typeof value === "object"
      && typeof value.computed === "function" && typeof value.signal === "function"
      && typeof value.effect === "function",
  );
}
const runtimeA = runtimeFrom(moduleA);
const runtimeB = runtimeFrom(moduleB);
if (!runtimeA || !runtimeB || runtimeA === runtimeB) {
  throw new Error("Could not create two distinct RFSG runtime copies");
}

function runCrossCopy(count) {
  const source = runtimeA.signal(0);
  let checksum = 0;
  for (let index = 0; index < count; index += 1) {
    source.value = index;
    const value = runtimeA.computed(() => source.value * 2);
    let observed = -1;
    const dispose = runtimeB.effect(() => { observed = value.value; });
    if (observed !== index * 2) throw new Error(`cross-copy initial value mismatch at ${index}: ${observed}`);
    source.value = index + 1;
    if (observed !== (index + 1) * 2) throw new Error(`cross-copy update mismatch at ${index}: ${observed}`);
    checksum += observed;
    dispose();
  }
  return checksum;
}

const expected = iterations * (iterations + 1);
const quantile = (values, fraction) => {
  const ordered = values.toSorted((a, b) => a - b);
  const index = (ordered.length - 1) * fraction;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return ordered[low] + (ordered[high] - ordered[low]) * (index - low);
};
const timings = [];
for (let index = 0; index < warmups + samples; index += 1) {
  global.gc?.();
  const start = process.hrtime.bigint();
  const checksum = runCrossCopy(iterations);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  if (!Number.isFinite(checksum) || !Object.is(checksum, expected)) {
    throw new Error(`cross-copy checksum mismatch: expected ${expected}, got ${checksum}`);
  }
  if (index >= warmups) timings.push(ms);
}

console.log(`Node ${process.version}; ${os.platform()} ${os.arch()}; ${os.cpus()[0]?.model ?? "unknown CPU"}`);
console.log(`${iterations} cross-copy computed mount/subscribe/update/unsubscribe cycles, ${warmups} warmups, ${samples} samples; --expose-gc=${Boolean(global.gc)}`);
console.log(`median ${quantile(timings, 0.5).toFixed(3)} ms; p25–p75 ${quantile(timings, 0.25).toFixed(3)}–${quantile(timings, 0.75).toFixed(3)} ms`);
