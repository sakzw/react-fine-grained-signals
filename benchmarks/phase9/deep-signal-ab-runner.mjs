import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, arch, platform } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hashCurrentRuntimeArtifact, hashCurrentRuntimeInputs } from "./runtime-identity.mjs";
import { RELEASED_COMMIT, RELEASED_TAG } from "./config.mjs";
import { pinnedArtifactIntegrity, verifiedPins } from "./verify-pins.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const git = promisify(execFile);
const pairOrder = ["AB", "BA", "BA", "AB", "AB", "BA", "AB", "BA", "BA", "AB", "BA", "AB", "AB", "BA", "BA", "AB", "AB", "BA", "AB", "BA", "BA", "AB", "BA", "AB"];
const primaryCases = [
  { workload: "rfsg/deepSignal-read", kind: "rfsg/deepSignal-read", size: 1, iterations: 50_000 },
  { workload: "rfsg/deepSignal-watched-leaf-write", kind: "rfsg/deepSignal-watched-leaf-write", size: 1, iterations: 8_657 },
];
const auxiliaryCases = [
  { workload: "deepSignal/create", size: 1, iterations: 2_500 },
  { workload: "deepSignal/nested-tracked-read", size: 1, iterations: 5_000 },
  { workload: "deepSignal/unwatched-sibling-write", size: 1, iterations: 8_657 },
  ...[16, 64, 256, 1_000].map((size) => ({ workload: "deepSignal/many-watched-leaves", size, iterations: 20_000 })),
];
const runtime = { A: "rfsg-v0.1.1", B: "rfsg-current" };
const [mode, ...args] = process.argv.slice(2);
const valueAfter = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const session = Number(valueAfter("--session", "0"));
const outputArgument = valueAfter("--output", "benchmarks/phase9/results/deep-signal-ab-2026-09-29");
const outputDir = isAbsolute(outputArgument) ? outputArgument : resolve(repoRoot, outputArgument);
const warmups = 3;
const samplesPerProcess = 7;
const allocationRounds = 12;
const allocationGraphCount = 1_000;

if (!(["session", "auxiliary", "allocation"].includes(mode))) {
  throw new Error("Usage: node deep-signal-ab-runner.mjs <session|auxiliary|allocation> [--session 1|2|3] [--output path]");
}
if (mode === "session" && ![1, 2, 3].includes(session)) throw new Error("Primary session must be 1, 2, or 3.");

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const writeManifest = async () => writeFile(resolve(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const appendJsonl = async (name, value) => appendFile(resolve(outputDir, name), `${JSON.stringify(value)}\n`, "utf8");
const median = (values) => {
  const ordered = [...values].toSorted((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
};

async function gitText(...gitArgs) {
  const { stdout } = await git("git", gitArgs, { cwd: repoRoot, windowsHide: true });
  return stdout.trim();
}

const existingManifestPath = resolve(outputDir, "manifest.json");
let manifest;
try {
  manifest = await readJson(existingManifestPath);
  if (manifest.status === "failed") throw new Error(`Existing result run is failed: ${outputDir}`);
  const currentHead = await gitText("rev-parse", "HEAD");
  if (currentHead !== manifest.currentHead) throw new Error(`Checkout changed during the A/B run: expected ${manifest.currentHead}, found ${currentHead}.`);
  const artifact = await hashCurrentRuntimeArtifact();
  if (artifact.sha256 !== manifest.currentRuntime.artifactSha256) throw new Error("Current dist changed during the A/B run.");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  if (mode !== "session" || session !== 1) throw new Error("Start session 1 before auxiliary or allocation runs.");

  // Capture dirty state before creating any run outputs. Thus this inventory
  // cannot contain the manifest or JSONL files produced by this harness.
  const preRunStatus = await gitText("status", "--porcelain");
  const currentHead = await gitText("rev-parse", "HEAD");
  const releaseCommit = await gitText("rev-parse", `${RELEASED_TAG}^{commit}`);
  if (releaseCommit !== RELEASED_COMMIT) throw new Error(`Pinned v0.1.1 tag mismatch: expected ${RELEASED_COMMIT}, found ${releaseCommit}.`);
  const iterationBytes = await readFile(resolve(here, "m1b-iterations.json"));
  const currentArtifact = await hashCurrentRuntimeArtifact();
  const currentInputsSha256 = await hashCurrentRuntimeInputs();
  const fixtureManifest = await readJson(resolve(here, "node_modules/react-fine-grained-signals/package.json"));

  manifest = {
    schemaVersion: 1,
    runId: new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-") ,
    status: "running",
    preRunStateCapturedAt: new Date().toISOString(),
    currentHead,
    worktreeDirty: preRunStatus.length > 0,
    dirtyPaths: preRunStatus ? preRunStatus.split(/\r?\n/) : [],
    reference: {
      runtimeId: "rfsg-v0.1.1",
      tag: RELEASED_TAG,
      commit: releaseCommit,
      packageVersion: fixtureManifest.version,
      packageEntry: import.meta.resolve("react-fine-grained-signals"),
      pinnedArtifactIntegrity,
      verifiedPins,
    },
    currentRuntime: {
      runtimeId: "rfsg-current",
      packageVersion: "0.1.1",
      sourceHead: currentHead,
      runtimeInputsSha256: currentInputsSha256,
      artifactSha256: currentArtifact.sha256,
      artifactFileCount: currentArtifact.fileCount,
    },
    environment: {
      node: process.version,
      nodeExecutable: process.execPath,
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model ?? "unknown",
      packageManager: process.env.npm_config_user_agent ?? "unknown",
    },
    protocol: {
      primary: { pairsPerSession: 24, sessions: 3, warmups, samples: samplesPerProcess, gc: "global.gc() immediately before each warmup and measured execution", sameFrozenIterations: true },
      auxiliary: { pairs: 12, warmups, samples: samplesPerProcess, counts: Object.fromEntries(auxiliaryCases.map((item) => [`${item.workload}@${item.size}`, item.iterations])) },
      allocation: { pairs: allocationRounds, graphCount: allocationGraphCount, kind: "deep-watched-leaves", gc: "Phase 9 allocation-worker forced-GC methodology" },
      pairOrder,
      orderEncoding: "AB means fresh v0.1.1 process then fresh current process; BA reverses the order.",
      pauseBetweenChildrenMs: 0,
      frozenIterationsFile: "benchmarks/phase9/m1b-iterations.json",
      frozenIterationsSha256: (await import("node:crypto")).createHash("sha256").update(iterationBytes).digest("hex"),
      primaryCounts: Object.fromEntries(primaryCases.map((item) => [`${item.workload}@${item.size}`, item.iterations])),
    },
    sessions: { "1": { status: "pending" }, "2": { status: "pending" }, "3": { status: "pending" } },
    auxiliaryStatus: "pending",
    allocationStatus: "pending",
    createdAt: new Date().toISOString(),
  };
  await mkdir(outputDir, { recursive: false });
  await Promise.all(["samples.jsonl", "pairs.jsonl", "allocations.jsonl", "failures.jsonl"].map((name) => writeFile(resolve(outputDir, name), "", "utf8")));
  await writeManifest();
}

const childTimeoutMs = 600_000;
const workerPath = resolve(here, "deep-signal-ab-worker.mjs");
const allocationWorkerPath = resolve(here, "allocation-worker.mjs");

async function runChild(script, payload) {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const child = spawn(process.execPath, ["--expose-gc", script, JSON.stringify(payload)], {
    cwd: here,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const result = await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`Child timed out after ${childTimeoutMs} ms: ${payload.runtimeId} ${payload.workload ?? payload.kind}`));
    }, childTimeoutMs);
    child.once("error", (error) => { clearTimeout(timeout); rejectPromise(error); });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolvePromise({ exitCode, signal });
    });
  });
  const endedAt = new Date().toISOString();
  let output;
  try { output = JSON.parse(stdout); }
  catch { throw new Error(`Invalid worker JSON (${result.exitCode}): ${payload.runtimeId} ${payload.workload ?? payload.kind}; stderr=${stderr}; stdout=${stdout.slice(0, 500)}`); }
  if (result.exitCode !== 0 || output.status !== "ok") {
    throw new Error(`Worker failed (${result.exitCode}/${result.signal}): ${payload.runtimeId} ${payload.workload ?? payload.kind}; stderr=${stderr}; stdout=${stdout.slice(0, 1_000)}`);
  }
  return { startedAt, endedAt, processDurationMs: Math.round((performance.now() - start) * 100) / 100, pid: child.pid, output };
}

async function runPairedCase({ label, caseConfig, pairs, rawFile }) {
  process.stdout.write(`Starting ${label} ${caseConfig.workload}@${caseConfig.size}: ${pairs} paired rounds\n`);
  for (let pair = 0; pair < pairs; pair += 1) {
    const order = pairOrder[pair];
    const processRows = {};
    for (const slot of order) {
      const runtimeId = runtime[slot];
      process.stdout.write(`[${label}] pair=${pair + 1}/${pairs} ${order} ${runtimeId} ${caseConfig.workload}@${caseConfig.size}\n`);
      try {
        const result = await runChild(workerPath, {
          runtimeId,
          workload: caseConfig.kind ?? caseConfig.workload,
          iterations: caseConfig.iterations,
          size: caseConfig.size,
          warmups,
          samples: samplesPerProcess,
        });
        processRows[slot] = result;
        const medianDurationNs = median(result.output.measured.map((sample) => sample.durationNs));
        for (const sample of result.output.measured) {
          await appendJsonl(rawFile, {
            type: "sample",
            session: label,
            pair: pair + 1,
            order,
            runtimeId,
            workload: caseConfig.workload,
            size: caseConfig.size,
            iterations: caseConfig.iterations,
            warmups,
            sample: sample.sample,
            durationNs: sample.durationNs,
            processMedianDurationNs: medianDurationNs,
            throughputPerSecond: caseConfig.iterations / (sample.durationNs / 1e9),
            processStartedAt: result.startedAt,
            processEndedAt: result.endedAt,
            processDurationMs: result.processDurationMs,
            pid: result.pid,
            cpu: manifest.environment.cpu,
            node: manifest.environment.node,
            semanticAssertions: result.output.semanticAssertions,
            gcExposed: result.output.gcExposed,
          });
        }
      } catch (error) {
        const failure = { session: label, pair: pair + 1, order, runtimeId, workload: caseConfig.workload, size: caseConfig.size, error: error?.stack ?? String(error), at: new Date().toISOString() };
        await appendJsonl("failures.jsonl", failure);
        manifest.status = "failed";
        manifest.finishedAt = new Date().toISOString();
        await writeManifest();
        throw error;
      }
    }

    const baselineDurationNs = median(processRows.A.output.measured.map((sample) => sample.durationNs));
    const currentDurationNs = median(processRows.B.output.measured.map((sample) => sample.durationNs));
    const baselineThroughput = caseConfig.iterations / (baselineDurationNs / 1e9);
    const currentThroughput = caseConfig.iterations / (currentDurationNs / 1e9);
    await appendJsonl("pairs.jsonl", {
      type: "paired-round",
      session: label,
      pair: pair + 1,
      order,
      workload: caseConfig.workload,
      size: caseConfig.size,
      iterations: caseConfig.iterations,
      v011MedianDurationNs: baselineDurationNs,
      currentMedianDurationNs: currentDurationNs,
      v011MedianThroughputPerSecond: baselineThroughput,
      currentMedianThroughputPerSecond: currentThroughput,
      throughputRatioCurrentOverV011: currentThroughput / baselineThroughput,
      currentFaster: currentThroughput > baselineThroughput,
      v011Faster: baselineThroughput > currentThroughput,
      tie: baselineThroughput === currentThroughput,
      v011StartedAt: processRows.A.startedAt,
      currentStartedAt: processRows.B.startedAt,
      pairFinishedAt: new Date().toISOString(),
    });
  }
}

try {
  if (mode === "session") {
    const label = `session-${session}`;
    if (manifest.sessions[String(session)].status !== "pending") throw new Error(`${label} already has status ${manifest.sessions[String(session)].status}.`);
    manifest.sessions[String(session)] = { status: "running", startedAt: new Date().toISOString(), pairs: 24 };
    await writeManifest();
    for (const caseConfig of primaryCases) await runPairedCase({ label, caseConfig, pairs: 24, rawFile: "samples.jsonl" });
    manifest.sessions[String(session)] = { ...manifest.sessions[String(session)], status: "completed", finishedAt: new Date().toISOString() };
  } else if (mode === "auxiliary") {
    if (manifest.auxiliaryStatus !== "pending") throw new Error(`Auxiliary workloads already have status ${manifest.auxiliaryStatus}.`);
    manifest.auxiliaryStatus = "running";
    manifest.auxiliaryStartedAt = new Date().toISOString();
    await writeManifest();
    for (const caseConfig of auxiliaryCases) await runPairedCase({ label: "auxiliary", caseConfig, pairs: 12, rawFile: "samples.jsonl" });
    manifest.auxiliaryStatus = "completed";
    manifest.auxiliaryFinishedAt = new Date().toISOString();
  } else {
    if (manifest.allocationStatus !== "pending") throw new Error(`Allocation run already has status ${manifest.allocationStatus}.`);
    manifest.allocationStatus = "running";
    manifest.allocationStartedAt = new Date().toISOString();
    await writeManifest();
    for (let pair = 0; pair < allocationRounds; pair += 1) {
      const order = pairOrder[pair];
      const results = {};
      for (const slot of order) {
        const runtimeId = runtime[slot];
        process.stdout.write(`[allocation] pair=${pair + 1}/${allocationRounds} ${order} ${runtimeId} deep-watched-leaves n=${allocationGraphCount}\n`);
        const result = await runChild(allocationWorkerPath, { runtimeId, count: allocationGraphCount, kind: "deep-watched-leaves" });
        const expectedShape = { sourceSignals: 0, computedSignals: 0, effects: allocationGraphCount, deepSignalRoots: 1, watchedLeaves: allocationGraphCount, subscribersToSingleSource: 0 };
        assertShape(result.output.graphShape, expectedShape, runtimeId);
        if (result.output.disposedEffectsStopped !== true) throw new Error(`${runtimeId} allocation disposal assertion did not pass.`);
        results[slot] = result;
        await appendJsonl("allocations.jsonl", {
          type: "allocation-observation",
          pair: pair + 1,
          order,
          runtimeId,
          kind: "deep-watched-leaves",
          graphCount: allocationGraphCount,
          liveDeltaBytes: result.output.liveDeltaBytes,
          retainedDeltaBytes: result.output.retainedDeltaBytes,
          graphShape: result.output.graphShape,
          disposedEffectsStopped: result.output.disposedEffectsStopped,
          startedAt: result.startedAt,
          processDurationMs: result.processDurationMs,
          cpu: manifest.environment.cpu,
          node: manifest.environment.node,
        });
      }
      await appendJsonl("allocations.jsonl", {
        type: "allocation-pair",
        pair: pair + 1,
        order,
        kind: "deep-watched-leaves",
        graphCount: allocationGraphCount,
        currentOverV011LiveBytes: results.B.output.liveDeltaBytes - results.A.output.liveDeltaBytes,
        currentOverV011RetainedBytes: results.B.output.retainedDeltaBytes - results.A.output.retainedDeltaBytes,
      });
    }
    manifest.allocationStatus = "completed";
    manifest.allocationFinishedAt = new Date().toISOString();
  }
  const allSessionsComplete = Object.values(manifest.sessions).every((entry) => entry.status === "completed");
  if (allSessionsComplete && manifest.auxiliaryStatus === "completed" && manifest.allocationStatus === "completed") {
    manifest.status = "completed";
    manifest.finishedAt = new Date().toISOString();
  }
  await writeManifest();
} catch (error) {
  manifest.status = "failed";
  manifest.finishedAt = new Date().toISOString();
  await writeManifest();
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
}

function assertShape(actual, expected, runtimeId) {
  for (const [key, value] of Object.entries(expected)) {
    if (actual?.[key] !== value) throw new Error(`${runtimeId} allocation graph shape mismatch for ${key}: expected ${value}, got ${actual?.[key]}.`);
  }
}

if (process.exitCode !== 1) process.stdout.write(`Mode ${mode}${mode === "session" ? ` ${session}` : ""} completed; run status: ${manifest.status}; output: ${outputDir}\n`);
