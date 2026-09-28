import { readFile, writeFile } from "node:fs/promises";

const directory = new URL("./results/m151-owner-2026-09-28/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8"));
const samples = (await readFile(new URL("samples.jsonl", directory), "utf8"))
  .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const allocations = (await readFile(new URL("allocations.jsonl", directory), "utf8"))
  .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const median = (values) => {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};
const groups = new Map();
for (const row of samples) {
  if (row.status !== "ok" || row.adapterVariant !== undefined) continue;
  const key = `${row.caseId}@${row.graphSize}`;
  const rounds = groups.get(key) ?? new Map();
  const runtimes = rounds.get(row.round) ?? new Map();
  const values = runtimes.get(row.runtime) ?? [];
  values.push(row.durationNs);
  runtimes.set(row.runtime, values);
  rounds.set(row.round, runtimes);
  groups.set(key, rounds);
}

const cases = [];
for (const [caseId, rounds] of groups) {
  const pairedRatios = {};
  for (const comparison of ["rfsg-v0.1.1", "rfsg-current", "alien-signals"]) {
    const ratios = [];
    for (const runtimes of rounds.values()) {
      const candidate = runtimes.get("rfsg-m151-owner");
      const baseline = runtimes.get(comparison);
      if (candidate === undefined || baseline === undefined) continue;
      ratios.push(median(candidate) / median(baseline));
    }
    if (ratios.length === 0) continue;
    pairedRatios[comparison] = {
      pairedRounds: ratios.length,
      median: median(ratios),
      q1: median(ratios.toSorted((left, right) => left - right).slice(0, Math.floor(ratios.length / 2))),
      q3: median(ratios.toSorted((left, right) => left - right).slice(Math.ceil(ratios.length / 2))),
      min: Math.min(...ratios),
      max: Math.max(...ratios),
    };
  }
  cases.push({ caseId, pairedRatios });
}

const allocationSummary = [...new Set(allocations.map((row) => row.kind))].map((kind) => {
  const byRuntime = {};
  for (const runtime of ["rfsg-v0.1.1", "rfsg-current", "rfsg-m151-owner", "alien-signals"]) {
    const rows = allocations.filter((row) => row.kind === kind && row.runtime === runtime);
    if (rows.length === 0) continue;
    byRuntime[runtime] = {
      rounds: rows.length,
      medianLiveDeltaBytes: median(rows.map((row) => row.liveDeltaBytes)),
      medianRetainedDeltaBytes: median(rows.map((row) => row.retainedDeltaBytes)),
    };
  }
  return { kind, byRuntime };
});

const output = {
  purpose: "M1.5.1 frozen-count eight-round candidate matrix; paired medians are descriptive, not a release conclusion",
  runId: manifest.runId,
  gitHead: manifest.gitHead,
  status: manifest.status,
  plannedTasks: manifest.plannedTasks,
  completedTasks: manifest.completedTasks,
  sampleRows: samples.length,
  successfulRows: samples.filter((row) => row.status === "ok").length,
  notApplicableRows: samples.filter((row) => row.status === "na").length,
  failureRows: samples.filter((row) => row.status === "failed").length,
  allocationRows: allocations.length,
  verifiedAllocationRows: allocations.filter((row) => row.status === "ok" && row.shapeVerified).length,
  cases,
  allocationSummary,
};
await writeFile(new URL("./owner-matrix-summary.json", import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
