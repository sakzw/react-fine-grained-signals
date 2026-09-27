import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [controlArg, variantArg, kind, iterationsArg, sizeArg, name, outputArg] = process.argv.slice(2);
if (!controlArg || !variantArg || !kind || !iterationsArg || !sizeArg || !name || !outputArg) {
  throw new Error("usage: node paired-diagnostics.mjs <control-root> <variant-root> <kind> <iterations> <size> <name> <output.json>");
}
const controlRoot = resolve(controlArg);
const variantRoot = resolve(variantArg);
const iterations = Number(iterationsArg);
const size = Number(sizeArg);
const worker = (root) => resolve(root, "benchmarks/phase9/worker.mjs");

function run(root) {
  const payload = JSON.stringify({ runtimeId: "rfsg-current", kind, iterations, size, warmups: 3, samples: 7 });
  const result = spawnSync(process.execPath, ["--expose-gc", worker(root), payload], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${root} exited ${result.status}: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  if (parsed.status !== "ok" || parsed.preflight !== "passed") throw new Error(`worker did not pass: ${result.stdout}`);
  return parsed.samples.map((sample) => sample.durationNs);
}

const median = (values) => {
  const ordered = values.toSorted((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};
const quantileR7 = (values, probability) => {
  const ordered = values.toSorted((a, b) => a - b);
  const rank = (ordered.length - 1) * probability;
  const lower = Math.floor(rank);
  const fraction = rank - lower;
  return ordered[lower] + fraction * (ordered[Math.min(lower + 1, ordered.length - 1)] - ordered[lower]);
};
const rounds = [];
for (let index = 0; index < 4; index += 1) {
  const order = index % 2 === 0 ? ["control", "variant"] : ["variant", "control"];
  const values = {};
  for (const side of order) values[side] = run(side === "control" ? controlRoot : variantRoot);
  const controlMedianNs = median(values.control);
  const variantMedianNs = median(values.variant);
  rounds.push({
    round: index + 1,
    order,
    controlSamplesNs: values.control,
    variantSamplesNs: values.variant,
    controlMedianNs,
    variantMedianNs,
    variantOverControlThroughput: controlMedianNs / variantMedianNs,
  });
}
const ratios = rounds.map((round) => round.variantOverControlThroughput);
const sortedRatios = ratios.toSorted((a, b) => a - b);
const q1 = quantileR7(ratios, 0.25);
const q3 = quantileR7(ratios, 0.75);
const result = {
  schemaVersion: 1,
  name,
  kind,
  runtimeId: "rfsg-current",
  iterations,
  size,
  warmupsPerProcess: 3,
  samplesPerProcess: 7,
  pairedProcessRounds: 4,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  controlRoot,
  variantRoot,
  rounds,
  summary: {
    medianPairedThroughputRatio: median(ratios),
    min: sortedRatios[0],
    max: sortedRatios.at(-1),
    q1,
    q3,
    iqr: q3 - q1,
    roundsFaster: ratios.filter((ratio) => ratio > 1).length,
    roundsSlower: ratios.filter((ratio) => ratio < 1).length,
    ties: ratios.filter((ratio) => ratio === 1).length,
  },
};
await writeFile(resolve(outputArg), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result.summary)}\n`);
