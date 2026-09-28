import { readFileSync, writeFileSync } from "node:fs";
const sourceReadAudit = process.argv.includes("--source-read-audit");
const computedAudit = process.argv.includes("--computed-audit");
const computedFastpathAudit = process.argv.includes("--computed-fastpath-audit");
const effectAudit = process.argv.includes("--effect-audit");
const resultName = sourceReadAudit ? "m152-source-read-audit" : computedAudit ? `m152-computed-audit${computedFastpathAudit ? "-after-fastpath" : ""}` : effectAudit ? "m152-effect-audit" : "m152-production-diagnostic";
const resultUrl = new URL(`./${resultName}-results.json`, import.meta.url);
const outputUrl = new URL(`./${resultName}-summary.json`, import.meta.url);
const input = JSON.parse(readFileSync(resultUrl, "utf8"));
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const summary = input.cases.map((item) => {
  const rounds = input.measurements.filter((row) => row.caseId === item.caseId);
  const coreMedians = rounds.map((row) => median(row.perRuntime["m15-core"]));
  const pairedRatios = Object.fromEntries(["m151-integrated", "rfsg-current", "rfsg-v0.1.1"].map((runtimeId) => {
    const paired = rounds.map((row) => median(row.perRuntime[runtimeId]) / median(row.perRuntime["m15-core"]));
    const sorted = paired.toSorted((a, b) => a - b);
    return [runtimeId, { median: median(paired), q1: median(sorted.slice(0, 12)), q3: median(sorted.slice(12)), min: Math.min(...paired), max: Math.max(...paired), roundsFaster: paired.filter((ratio) => ratio < 1).length }];
  }));
  return { caseId: item.caseId, rounds: rounds.length, coreMedianNs: median(coreMedians), pairedRatios };
});
const output = { purpose: input.purpose, roundsPerCase: input.rounds, warmups: input.warmups, samples: input.samples, frozenIterationsFile: input.frozenIterationsFile, summary };
writeFileSync(outputUrl, `${JSON.stringify(output, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
