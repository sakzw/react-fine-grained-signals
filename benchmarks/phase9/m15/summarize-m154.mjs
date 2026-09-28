import { readFileSync, writeFileSync } from "node:fs";

const input = new URL("./results/m154-m153-direct-results.json", import.meta.url);
const output = new URL("./results/m154-m153-direct-summary.json", import.meta.url);
const raw = JSON.parse(readFileSync(input, "utf8"));
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const quantile = (values, fraction) => {
  const sorted = values.toSorted((a, b) => a - b);
  const at = (sorted.length - 1) * fraction;
  const low = Math.floor(at);
  return sorted[low] + (sorted[Math.ceil(at)] - sorted[low]) * (at - low);
};
const rows = [];
for (const item of raw.cases) {
  const measurements = raw.measurements.filter((entry) => entry.caseId === item.caseId);
  const paired = measurements.map((entry) => Object.fromEntries(
    Object.entries(entry.perRuntime).map(([runtime, durations]) => [runtime, median(durations)]),
  ));
  const c3 = paired.map((entry) => entry["m154-c3"]);
  const baseline = paired.map((entry) => entry["rfsg-m153"]);
  const ratios = paired.map((entry) => entry["m154-c3"] / entry["rfsg-m153"]);
  const comparison = {
    pairedRounds: ratios.length,
    median: median(ratios),
    q1: quantile(ratios, 0.25),
    q3: quantile(ratios, 0.75),
    min: Math.min(...ratios),
    max: Math.max(...ratios),
    candidateFasterRounds: ratios.filter((ratio) => ratio < 1).length,
    candidateSlowerRounds: ratios.filter((ratio) => ratio > 1).length,
  };
  const v011Ratios = paired.map((entry) => entry["m154-c3"] / entry["rfsg-v0.1.1"]);
  rows.push({
    caseId: item.caseId,
    iterations: item.iterations,
    rounds: measurements.length,
    c3MedianDurationNs: median(c3),
    m153MedianDurationNs: median(baseline),
    c3OverM153: comparison,
    c3OverV011Context: { median: median(v011Ratios), q1: quantile(v011Ratios, 0.25), q3: quantile(v011Ratios, 0.75) },
  });
}
const summary = {
  purpose: raw.purpose,
  gitHead: raw.gitHead,
  node: raw.node,
  warmups: raw.warmups,
  samples: raw.samples,
  frozenIterationsSha256: raw.frozenIterationsSha256,
  runtimeIdentities: raw.runtimeIdentities,
  rows,
};
writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
