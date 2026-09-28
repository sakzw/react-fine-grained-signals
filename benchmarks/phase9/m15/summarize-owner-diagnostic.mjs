import { readFileSync, writeFileSync } from "node:fs";
const path = new URL("./owner-diagnostic-results.json", import.meta.url);
const input = JSON.parse(readFileSync(path, "utf8"));
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const summary = input.cases.map((item) => {
  const rounds = input.measurements.filter((row) => row.caseId === item.caseId);
  const coreMedians = rounds.map((row) => median(row.perRuntime["m15-core"]));
  const ratios = Object.fromEntries(["m151-integrated", "rfsg-current", "rfsg-v0.1.1"].map((runtimeId) => {
    const paired = rounds.map((row) => median(row.perRuntime[runtimeId]) / median(row.perRuntime["m15-core"]));
    return [runtimeId, {
      median: median(paired),
      q1: median(paired.toSorted((a, b) => a - b).slice(0, 12)),
      q3: median(paired.toSorted((a, b) => a - b).slice(12)),
      min: Math.min(...paired),
      max: Math.max(...paired),
    }];
  }));
  return { caseId: item.caseId, rounds: rounds.length, coreMedianNs: median(coreMedians), pairedRatios: ratios };
});
const output = { purpose: input.purpose, roundsPerCase: input.rounds, warmups: input.warmups, samples: input.samples, frozenIterationsFile: input.frozenIterationsFile, summary };
writeFileSync(new URL("./owner-diagnostic-summary.json", import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
