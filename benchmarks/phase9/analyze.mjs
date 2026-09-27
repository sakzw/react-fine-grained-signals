import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALIEN_VERSION,
  RUNTIME_BASELINE_SHA,
  VUE_PACKAGE_VERSION,
  allocationWorkloadIds,
  commonCases,
  rfsgCases,
  runtimes,
  runtimeOrderForRound,
} from "./config.mjs";
import { hashCurrentRuntimeArtifact, hashCurrentRuntimeInputs } from "./runtime-identity.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const resultArgument = process.argv[2];
if (!resultArgument || process.argv.length !== 3) {
  throw new Error("Usage: node benchmarks/phase9/analyze.mjs <authoritative-result-directory>");
}

const resultDir = resolve(process.cwd(), resultArgument);
const readJson = async (name) => JSON.parse(await readFile(resolve(resultDir, name), "utf8"));
const readJsonl = async (name) => {
  const contents = await readFile(resolve(resultDir, name), "utf8");
  return contents.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
};

const manifest = await readJson("manifest.json");
const samples = await readJsonl("samples.jsonl");
const allocations = await readJsonl("allocations.jsonl");
const failures = await readJsonl("failures.jsonl");
assert.equal(manifest.mode, "measure", "Only measure runs are authoritative.");
assert.equal(manifest.status, "completed", "The run must have completed.");
assert.equal(manifest.completedTasks, manifest.plannedTasks, "The run must have completed every planned task.");
assert.equal(manifest.phase9RuntimeBaselineSha, RUNTIME_BASELINE_SHA);
assert.equal(manifest.configurations.rounds, 8, "Authoritative M1b uses eight paired rounds.");
assert.equal(manifest.configurations.samples, 7);
assert.equal(manifest.configurations.includeAllocations, true);
assert.equal(manifest.configurations.allocationRounds, 3);
assert(["production-inputs-match-baseline", "explicit-runtime-inputs-sha256"].includes(manifest.currentRuntimeArtifact.identityGuard));
assert.equal(manifest.currentRuntimeArtifact.guardedBaselineSha, RUNTIME_BASELINE_SHA);
assert.match(manifest.currentRuntimeArtifact.sha256, /^[a-f0-9]{64}$/);
if (manifest.currentRuntimeArtifact.runtimeInputsSha256 !== undefined) {
  assert.match(manifest.currentRuntimeArtifact.runtimeInputsSha256, /^[a-f0-9]{64}$/);
  assert.equal(await hashCurrentRuntimeInputs(), manifest.currentRuntimeArtifact.runtimeInputsSha256,
    "The current production input tree must match the hash recorded at measurement time.");
} else {
  assert.equal(manifest.currentRuntimeArtifact.identityGuard, "production-inputs-match-baseline",
    "Only historical baseline runs may omit the runtime input hash.");
}
if (manifest.currentRuntimeArtifact.identityGuard === "explicit-runtime-inputs-sha256") {
  assert.match(manifest.currentRuntimeArtifact.runtimeInputsSha256, /^[a-f0-9]{64}$/);
}
assert.equal(manifest.verifiedPins.oldAlien, ALIEN_VERSION);
assert.equal(manifest.verifiedPins.currentAlien, ALIEN_VERSION);
assert.equal(manifest.verifiedPins.vue, VUE_PACKAGE_VERSION);
assert.equal(manifest.verifiedPins.v0_1_1.version, "0.1.1");
assert.equal(failures.length, 0, "Authoritative runs with failures cannot be analyzed.");
if (manifest.currentRuntimeArtifact.identityGuard === "explicit-runtime-inputs-sha256") {
  assert.equal((await hashCurrentRuntimeArtifact()).sha256, manifest.currentRuntimeArtifact.sha256,
    "The built runtime artifact must match the SHA-256 recorded at measurement time.");
}

const iterationFile = manifest.configurations.iterationsFile;
assert(iterationFile?.path && iterationFile.sha256, "The manifest must identify the frozen iterations file.");
const iterationPath = resolve(repoRoot, iterationFile.path);
const iterationBytes = await readFile(iterationPath);
const iterationsSha256 = createHash("sha256").update(iterationBytes).digest("hex");
assert.equal(iterationsSha256, iterationFile.sha256, "The frozen iterations file hash must match the manifest.");
const iterationCounts = JSON.parse(iterationBytes.toString("utf8"));
assert.deepEqual(iterationCounts, iterationFile.counts, "Manifest counts must match the frozen iterations file.");

const selectedCases = [...commonCases, ...rfsgCases].flatMap((definition) => {
  const sizes = definition.sizes
    ? (manifest.configurations.sizeOverride ?? definition.sizes)
    : [definition.size ?? 1];
  return sizes.map((size) => ({ ...definition, size }));
});
const expectedKeys = selectedCases.map(({ id, size }) => `${id}@${size}`).toSorted();
assert.deepEqual(Object.keys(iterationCounts).toSorted(), expectedKeys, "Iteration file coverage must match the selected case/size set.");
for (const [key, count] of Object.entries(iterationCounts)) {
  assert(Number.isSafeInteger(count) && count > 0, `Invalid iteration count for ${key}.`);
}
for (let round = 1; round <= 8; round += 1) {
  assert.deepEqual(
    manifest[`round${round}RuntimeOrder`],
    runtimeOrderForRound(round).map(({ id }) => id),
    `Runtime order mismatch in round ${round}.`,
  );
}
for (let round = 1; round <= 3; round += 1) {
  assert.deepEqual(
    manifest[`allocationRound${round}RuntimeOrder`],
    runtimeOrderForRound(round).map(({ id }) => id),
    `Allocation runtime order mismatch in round ${round}.`,
  );
}

const sampleGroups = new Map();
for (const row of samples) {
  assert.equal(row.phase9RuntimeBaselineSha, RUNTIME_BASELINE_SHA);
  assert(["ok", "na"].includes(row.status), `Unexpected sample status: ${row.status}.`);
  const key = [row.caseId, row.graphSize, row.runtime, row.round].join("|");
  if (!sampleGroups.has(key)) sampleGroups.set(key, []);
  sampleGroups.get(key).push(row);
}
const expectedNA = (definition, runtimeId) => (
  (definition.runtimes && !definition.runtimes.includes(runtimeId))
  || (definition.id === "batch/two-writes-one-reaction" && runtimeId === "vue-reactivity")
);
const roundThroughput = new Map();
for (const definition of selectedCases) {
  const expectedIterations = iterationCounts[`${definition.id}@${definition.size}`];
  for (const runtime of runtimes) {
    for (let round = 1; round <= 8; round += 1) {
      const key = [definition.id, definition.size, runtime.id, round].join("|");
      const rows = sampleGroups.get(key) ?? [];
      if (expectedNA(definition, runtime.id)) {
        assert.equal(rows.length, 1, `Missing N/A row for ${key}.`);
        assert.equal(rows[0].status, "na");
        continue;
      }
      const variants = definition.id === "diagnostic/adapter-read-dispatch"
        ? ["direct-native-call", "normalized-adapter-call"]
        : [null];
      for (const variant of variants) {
        const variantRows = rows.filter((row) => (row.adapterVariant ?? null) === variant);
        assert.equal(variantRows.length, 7, `Incomplete samples for ${key} variant ${variant}.`);
        assert(variantRows.every((row) => row.status === "ok" && row.semanticAssertions === "passed"));
        assert(variantRows.every((row) => row.iterations === expectedIterations));
        assert.deepEqual(
          variantRows.map(({ sample }) => sample).toSorted((a, b) => a - b),
          [1, 2, 3, 4, 5, 6, 7],
          `Sample numbers are incomplete for ${key} variant ${variant}.`,
        );
        const rate = median(variantRows.map(({ operationsPerSecond }) => operationsPerSecond));
        roundThroughput.set([definition.id, definition.size, runtime.id, round, variant ?? ""].join("|"), rate);
      }
    }
  }
}
assert.equal(sampleGroups.size, selectedCases.length * runtimes.length * 8, "Unexpected or duplicate case/size/runtime/round groups.");
assert.equal(samples.filter(({ status }) => status === "na").length, 104);
assert.equal(samples.length, 6096);
assert.equal(manifest.completedTasks, 958);

assert.equal(allocations.length, allocationWorkloadIds.length * 10);
assert(allocations.every((row) => row.status === "ok" && row.shapeVerified === true));
assert(allocations.every((row) => row.disposedEffectsStopped === true && row.graphCount === 1000));
assert.deepEqual([...new Set(allocations.map(({ kind }) => kind))].toSorted(), [...allocationWorkloadIds].toSorted());

const primary = selectedCases
  .filter(({ id, runtimes: allowed }) => id !== "diagnostic/adapter-read-dispatch"
    && (!allowed || (allowed.includes("rfsg-v0.1.1") && allowed.includes("rfsg-current"))))
  .map((definition) => {
    const rounds = Array.from({ length: 8 }, (_, index) => index + 1).map((round) => {
      const oldRate = getRate(roundThroughput, definition, "rfsg-v0.1.1", round);
      const currentRate = getRate(roundThroughput, definition, "rfsg-current", round);
      return currentRate / oldRate;
    });
    return {
      caseId: definition.id,
      size: definition.size,
      rounds: runtimeSummaries(roundThroughput, definition),
      pairedCurrentOverV011: summarize(rounds),
    };
  });

const contextual = selectedCases
  .filter(({ runtimes: allowed, id }) => id !== "diagnostic/adapter-read-dispatch"
    && (!allowed || allowed.includes("alien-signals") || allowed.includes("vue-reactivity")))
  .map((definition) => {
    const comparisons = [];
    for (const baseline of ["alien-signals", "vue-reactivity"]) {
      const oldAvailable = !expectedNA(definition, "rfsg-v0.1.1") && !expectedNA(definition, baseline);
      const currentAvailable = !expectedNA(definition, "rfsg-current") && !expectedNA(definition, baseline);
      if (oldAvailable) comparisons.push({
        ratio: `rfsg-v0.1.1/${baseline}`,
        summary: summarize(Array.from({ length: 8 }, (_, index) => {
          const round = index + 1;
          return getRate(roundThroughput, definition, "rfsg-v0.1.1", round)
            / getRate(roundThroughput, definition, baseline, round);
        })),
      });
      if (currentAvailable) comparisons.push({
        ratio: `rfsg-current/${baseline}`,
        summary: summarize(Array.from({ length: 8 }, (_, index) => {
          const round = index + 1;
          return getRate(roundThroughput, definition, "rfsg-current", round)
            / getRate(roundThroughput, definition, baseline, round);
        })),
      });
    }
    return { caseId: definition.id, size: definition.size, comparisons };
  })
  .filter(({ comparisons }) => comparisons.length > 0);

const adapter = ["rfsg-v0.1.1", "rfsg-current", "alien-signals", "vue-reactivity"].map((runtime) => {
  const definition = selectedCases.find(({ id }) => id === "diagnostic/adapter-read-dispatch");
  const normalizedOverDirect = Array.from({ length: 8 }, (_, index) => {
    const round = index + 1;
    return getRate(roundThroughput, definition, runtime, round, "direct-native-call")
      / getRate(roundThroughput, definition, runtime, round, "normalized-adapter-call");
  });
  return { runtime, directOverNormalizedThroughput: summarize(normalizedOverDirect) };
});

const allocationSummary = allocationWorkloadIds.flatMap((kind) => (
  [...new Set(allocations.map(({ runtime }) => runtime))].map((runtime) => {
    const rows = allocations.filter((row) => row.kind === kind && row.runtime === runtime);
    return {
      kind,
      runtime,
      rounds: rows.map(({ round, liveDeltaBytes, retainedDeltaBytes }) => ({ round, liveDeltaBytes, retainedDeltaBytes })),
      liveMedianBytes: median(rows.map(({ liveDeltaBytes }) => liveDeltaBytes)),
      retainedMedianBytes: median(rows.map(({ retainedDeltaBytes }) => retainedDeltaBytes)),
    };
  })
));

const output = {
  validity: {
    status: manifest.status,
    completedTasks: manifest.completedTasks,
    plannedTasks: manifest.plannedTasks,
    sampleRows: samples.length,
    successfulSamples: samples.filter(({ status }) => status === "ok").length,
    expectedNARows: samples.filter(({ status }) => status === "na").length,
    allocationRows: allocations.length,
    failures: failures.length,
  },
  identity: {
    runId: manifest.runId,
    startingHead: manifest.gitHead,
    runtimeBaselineSha: manifest.phase9RuntimeBaselineSha,
    distSha256: manifest.currentRuntimeArtifact.sha256,
    iterationsSha256,
    node: manifest.node,
    platform: manifest.platform,
    arch: manifest.arch,
    cpu: manifest.cpu.trim(),
    pins: manifest.verifiedPins,
  },
  primary,
  contextual,
  adapter,
  allocations: allocationSummary,
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

function getRate(table, definition, runtime, round, variant = "") {
  const key = [definition.id, definition.size, runtime, round, variant].join("|");
  const value = table.get(key);
  assert(value > 0, `Missing throughput value for ${key}.`);
  return value;
}

function median(values) {
  return quantile(values, 0.5);
}

function quantile(values, probability) {
  const sorted = values.toSorted((a, b) => a - b);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function summarize(values) {
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return {
    median: median(values),
    q1,
    q3,
    iqr: q3 - q1,
    min,
    max,
    slowerRounds: values.filter((value) => value < 1).length,
    fasterRounds: values.filter((value) => value > 1).length,
    ties: values.filter((value) => value === 1).length,
    percentDelta: (median(values) - 1) * 100,
    values,
  };
}

function runtimeSummaries(table, definition) {
  return ["rfsg-v0.1.1", "rfsg-current"].map((runtime) => {
    const rounds = Array.from({ length: 8 }, (_, index) => (
      getRate(table, definition, runtime, index + 1)
    ));
    return { runtime, summary: summarizeAbsolute(rounds) };
  });
}

function summarizeAbsolute(values) {
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  return {
    median: median(values),
    q1,
    q3,
    iqr: q3 - q1,
    min: Math.min(...values),
    max: Math.max(...values),
    values,
  };
}
