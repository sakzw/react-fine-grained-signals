import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const resultDir = resolve(process.cwd(), process.argv[2] ?? "");
if (!process.argv[2] || process.argv.length !== 3) throw new Error("Usage: node benchmarks/phase9/analyze-deep-signal-ab.mjs <result-directory>");
const readJson = async (name) => JSON.parse(await readFile(resolve(resultDir, name), "utf8"));
const readJsonl = async (name) => (await readFile(resolve(resultDir, name), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const manifest = await readJson("manifest.json");
const pairs = await readJsonl("pairs.jsonl");
const samples = await readJsonl("samples.jsonl");
const allocations = await readJsonl("allocations.jsonl");
const failures = await readJsonl("failures.jsonl");

assert.equal(manifest.status, "completed", "All three primary sessions, auxiliary workloads, and allocation comparisons must be complete.");
assert.equal(failures.length, 0, "Failed workers invalidate this run.");
assert.equal(manifest.reference.commit, "0e12bbf46ab098fbb2388704ab85c3c406189cbb");
assert.equal(manifest.environment.node, process.version, "Analyze with the same Node version as the measurement.");
assert.equal(manifest.protocol.primary.pairsPerSession, 24);
assert.equal(manifest.protocol.primary.sessions, 3);
assert.equal(manifest.protocol.primary.warmups, 3);
assert.equal(manifest.protocol.primary.samples, 7);
assert.equal(manifest.protocol.frozenIterationsSha256, "fb549096642e48eda6ba9f50485e67b41079d2178dbd2ba607c6931106d5f056");
const iterationBytes = await readFile(resolve(process.cwd(), manifest.protocol.frozenIterationsFile));
assert.equal(createHash("sha256").update(iterationBytes).digest("hex"), manifest.protocol.frozenIterationsSha256);
const frozenIterations = JSON.parse(iterationBytes.toString("utf8"));
assert.equal(frozenIterations["rfsg/deepSignal-read@1"], manifest.protocol.primaryCounts["rfsg/deepSignal-read@1"]);
assert.equal(frozenIterations["rfsg/deepSignal-watched-leaf-write@1"], manifest.protocol.primaryCounts["rfsg/deepSignal-watched-leaf-write@1"]);
assert.equal(manifest.worktreeDirty, true, "Run-start dirty state should include the focused harness, not run output files.");
assert(!manifest.dirtyPaths.some((path) => path.includes("results/deep-signal-ab-")), "Run output must not appear in pre-run dirty paths.");

function quantile(values, probability) {
  const ordered = values.toSorted((left, right) => left - right);
  const position = (ordered.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

function summary(values) {
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  return {
    count: values.length,
    median: quantile(values, 0.5),
    q1,
    q3,
    iqr: q3 - q1,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function summarizeRatios(rows) {
  const values = rows.map((row) => row.throughputRatioCurrentOverV011);
  return {
    ...summary(values),
    currentFasterPairs: values.filter((value) => value > 1).length,
    v011FasterPairs: values.filter((value) => value < 1).length,
    ties: values.filter((value) => value === 1).length,
    ratios: values,
    v011Throughput: summary(rows.map((row) => row.v011MedianThroughputPerSecond)),
    currentThroughput: summary(rows.map((row) => row.currentMedianThroughputPerSecond)),
  };
}

function forKey(rows, session, workload, size) {
  return rows.filter((row) => row.session === session && row.workload === workload && row.size === size).toSorted((a, b) => a.pair - b.pair);
}

const primaryWorkloads = ["rfsg/deepSignal-read", "rfsg/deepSignal-watched-leaf-write"];
const sessionSummaries = {};
for (const sessionNumber of [1, 2, 3]) {
  const session = `session-${sessionNumber}`;
  assert.equal(manifest.sessions[String(sessionNumber)].status, "completed");
  sessionSummaries[session] = {};
  for (const workload of primaryWorkloads) {
    const rows = forKey(pairs, session, workload, 1);
    assert.equal(rows.length, 24, `${session} ${workload} must contain 24 paired rounds.`);
    assert(rows.every((row, index) => row.order === manifest.protocol.pairOrder[index]), `${session} ${workload} does not match the recorded deterministic schedule.`);
    const ab = rows.filter((row) => row.order === "AB").length;
    const ba = rows.filter((row) => row.order === "BA").length;
    assert.equal(ab, 12);
    assert.equal(ba, 12);
    sessionSummaries[session][workload] = summarizeRatios(rows);
  }
}

const auxiliaryKeys = manifest.protocol.auxiliary.counts;
const auxiliarySummaries = {};
for (const [key, iterations] of Object.entries(auxiliaryKeys)) {
  const divider = key.lastIndexOf("@");
  const workload = key.slice(0, divider);
  const size = Number(key.slice(divider + 1));
  const rows = forKey(pairs, "auxiliary", workload, size);
  assert.equal(rows.length, 12, `${key} must contain 12 paired rounds.`);
  assert(rows.every((row, index) => row.order === manifest.protocol.pairOrder[index]), `${key} does not match the recorded deterministic schedule.`);
  assert.equal(rows.every((row) => row.iterations === iterations), true, `${key} iteration count mismatch.`);
  assert.equal(rows.filter((row) => row.order === "AB").length, 6);
  assert.equal(rows.filter((row) => row.order === "BA").length, 6);
  auxiliarySummaries[key] = summarizeRatios(rows);
}

const combinedPrimary = {};
for (const workload of primaryWorkloads) {
  const allRows = pairs.filter((row) => row.workload === workload && row.session.startsWith("session-"));
  assert.equal(allRows.length, 72);
  combinedPrimary[workload] = summarizeRatios(allRows);
}

const measuredSampleRows = samples.filter((row) => row.type === "sample");
assert.equal(measuredSampleRows.length, 3 * 2 * 24 * 2 * 7 + Object.keys(auxiliaryKeys).length * 12 * 2 * 7,
  "Unexpected total primary/auxiliary sample count.");
for (const row of measuredSampleRows) {
  assert.equal(row.semanticAssertions, "passed");
  assert.equal(row.gcExposed, true);
  assert(row.durationNs > 0);
  assert(row.processDurationMs > 0);
}
const processGroups = new Map();
for (const row of measuredSampleRows) {
  const key = [row.session, row.pair, row.workload, row.size, row.runtimeId].join("|");
  const group = processGroups.get(key) ?? [];
  group.push(row);
  processGroups.set(key, group);
}
assert.equal(processGroups.size, 456, "Unexpected number of fresh runtime executions.");
for (const rows of processGroups.values()) {
  assert.equal(rows.length, 7, "Every runtime execution must retain exactly seven measured samples.");
  assert.deepEqual(rows.map((row) => row.sample).toSorted((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
  assert(rows.every((row) => row.processMedianDurationNs === rows[0].processMedianDurationNs));
}
for (const row of pairs) {
  const expectedRatio = row.currentMedianThroughputPerSecond / row.v011MedianThroughputPerSecond;
  assert(Math.abs(row.throughputRatioCurrentOverV011 - expectedRatio) < Number.EPSILON * 8,
    `Paired ratio calculation mismatch for ${row.session} ${row.workload} pair ${row.pair}.`);
}

const allocationObservations = allocations.filter((row) => row.type === "allocation-observation");
const allocationPairs = allocations.filter((row) => row.type === "allocation-pair");
assert.equal(allocationObservations.length, 24);
assert.equal(allocationPairs.length, 12);
for (const pair of allocationPairs) {
  assert.equal(pair.order, manifest.protocol.pairOrder[pair.pair - 1]);
  assert(allocationObservations.some((row) => row.pair === pair.pair && row.runtimeId === "rfsg-v0.1.1" && row.disposedEffectsStopped));
  assert(allocationObservations.some((row) => row.pair === pair.pair && row.runtimeId === "rfsg-current" && row.disposedEffectsStopped));
}
const allocationSummary = Object.fromEntries(["rfsg-v0.1.1", "rfsg-current"].map((runtimeId) => {
  const rows = allocationObservations.filter((row) => row.runtimeId === runtimeId);
  return [runtimeId, {
    liveHeapDeltaBytes: summary(rows.map((row) => row.liveDeltaBytes)),
    retainedHeapDeltaBytes: summary(rows.map((row) => row.retainedDeltaBytes)),
    shapeVerifiedRows: rows.length,
    disposedEffectsStoppedRows: rows.filter((row) => row.disposedEffectsStopped).length,
  }];
}));
const allocationPairSummary = {
  currentMinusV011LiveHeapBytes: summary(allocationPairs.map((row) => row.currentOverV011LiveBytes)),
  currentMinusV011RetainedHeapBytes: summary(allocationPairs.map((row) => row.currentOverV011RetainedBytes)),
};

const analysis = {
  runId: manifest.runId,
  validity: {
    status: manifest.status,
    primaryPairs: 3 * 2 * 24,
    auxiliaryPairs: Object.keys(auxiliaryKeys).length * 12,
    sampleRows: measuredSampleRows.length,
    allocationObservations: allocationObservations.length,
    allocationPairs: allocationPairs.length,
    failures: failures.length,
  },
  sessionSummaries,
  combinedPrimaryDescriptive: combinedPrimary,
  auxiliaryWorkloads: auxiliarySummaries,
  allocation: allocationSummary,
  allocationPairedDifferences: allocationPairSummary,
};

await writeFile(resolve(resultDir, "session-summaries.json"), `${JSON.stringify({ sessionSummaries, combinedPrimaryDescriptive: combinedPrimary }, null, 2)}\n`, "utf8");
await writeFile(resolve(resultDir, "analysis.json"), `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(analysis, null, 2)}\n`);
