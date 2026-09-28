import { readFileSync, writeFileSync } from "node:fs";

const candidateName = process.env.M154_FOCUSED === "1" ? "m154-source-fastpath-candidate" : "m154-symbol-protocol-candidate";
const input = new URL(`./results/${candidateName}-results.json`, import.meta.url);
const output = new URL(`./results/${candidateName}-summary.json`, import.meta.url);
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
  const candidate = paired.map((entry) => entry["rfsg-current"]);
  const comparisons = {};
  for (const runtime of ["m151-integrated", "rfsg-v0.1.1", "rfsg-pre-m15"]) {
    const ratios = paired.map((entry) => entry["rfsg-current"] / entry[runtime]);
    comparisons[runtime] = {
      pairedRounds: ratios.length,
      median: median(ratios),
      q1: quantile(ratios, 0.25),
      q3: quantile(ratios, 0.75),
      candidateFasterRounds: ratios.filter((ratio) => ratio < 1).length,
      candidateSlowerRounds: ratios.filter((ratio) => ratio > 1).length,
    };
  }
  rows.push({ caseId: item.caseId, iterations: item.iterations, rounds: measurements.length,
    currentMedianNs: median(candidate), comparisons });
}
const summary = {
  purpose: raw.purpose,
  gitHead: raw.gitHead,
  node: raw.node,
  warmups: raw.warmups,
  samples: raw.samples,
  frozenIterationsSha256: raw.frozenIterationsSha256,
  rows,
};
writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
