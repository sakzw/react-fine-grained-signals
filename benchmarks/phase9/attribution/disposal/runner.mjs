import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [workload, pairsArg, outputArg, ...args] = process.argv.slice(2);
const control = args.find((value) => value.startsWith("--control="))?.slice("--control=".length) ?? "current";
const runtimeArgs = args.filter((value) => !value.startsWith("--control="));
if (!workload || !pairsArg || !outputArg || runtimeArgs.length === 0) {
  throw new Error("usage: node runner.mjs <workload> <pairs> <output.json> <variant[:iterations[:size]]...> [--control=runtime]");
}
const pairs = Number(pairsArg);
if (!Number.isSafeInteger(pairs) || pairs <= 0) throw new Error("pairs must be positive integer");
const variants = runtimeArgs.map((value) => value.split(":")).map(([variant, iterationsText, sizeText]) => ({
  variant,
  iterations: Number(iterationsText ?? 5_000),
  size: Number(sizeText ?? 1),
}));
const worker = new URL("./worker.mjs", import.meta.url);
const median = (numbers) => {
  const ordered = numbers.toSorted((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};

function run(runtime, iterations, size) {
  const payload = JSON.stringify({ runtime, workload, iterations, size });
  const result = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(worker), payload], {
    cwd: resolve(import.meta.dirname, "../../../.."),
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${runtime} ${workload} failed: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  if (parsed.status !== "ok" || parsed.preflight !== "passed" || parsed.samples.length !== 7) {
    throw new Error(`${runtime} ${workload} did not pass preflight: ${result.stdout}`);
  }
  return { samples: parsed.samples, medianNs: median(parsed.samples.map((sample) => sample.durationNs)) };
}

const records = [];
for (const { variant, iterations, size } of variants) {
  for (let pair = 0; pair < pairs; pair += 1) {
    const order = pair % 2 === 0 ? [control, variant] : [variant, control];
    const values = {};
    for (const runtime of order) values[runtime] = run(runtime, iterations, size);
    records.push({
      workload, control, variant, iterations, size, pair: pair + 1, order,
      controlMedianNs: values[control].medianNs,
      variantMedianNs: values[variant].medianNs,
      variantOverControlSpeedup: values[control].medianNs / values[variant].medianNs,
      controlSamples: values[control].samples,
      variantSamples: values[variant].samples,
    });
  }
}
const outputPath = resolve(outputArg);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify({
  method: `${pairs} balanced AB/BA paired fresh-process rounds; three warmups and seven samples per process; median duration ratio control / variant`,
  node: process.version,
  workload,
  records,
}, null, 2)}\n`);
const summary = variants.map(({ variant }) => {
  const values = records.filter((record) => record.variant === variant);
  const ratios = values.map((record) => record.variantOverControlSpeedup).toSorted((a, b) => a - b);
  return { variant, pairs: values.length, medianSpeedup: median(ratios), wins: ratios.filter((ratio) => ratio > 1).length };
});
process.stdout.write(`${JSON.stringify(summary)}\n`);
