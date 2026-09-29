import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, arch, platform } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hashCurrentRuntimeArtifact, hashCurrentRuntimeInputs } from "../runtime-identity.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const phase = process.argv[2];
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const outputArg = option("--output", undefined);
const warmups = 3;
const samplesPerProcess = 7;
const pairOrder = ["AB", "BA", "BA", "AB", "AB", "BA", "AB", "BA", "BA", "AB", "BA", "AB", "AB", "BA", "BA", "AB", "AB", "BA", "AB", "BA", "BA", "AB", "BA", "AB"];
const frozenBytes = await readFile(resolve(repoRoot, "benchmarks/phase9/m1b-iterations.json"));
const frozen = JSON.parse(frozenBytes.toString("utf8"));
const phaseCases = {
  "write-current": {
    baseline: "rfsg-W0", candidate: "rfsg-current", primary: ["source/unobserved-write", "source/write-read"],
    cases: [
      ["source/unobserved-write", "source-unobserved-write", 1],
      ["source/write-read", "source-write-read", 1],
      ["effect/observed-write", "effect-observed-write", 1],
      ["effect/fanout", "effect-fanout", 16], ["effect/fanout", "effect-fanout", 64],
      ["computed/dirty-read", "computed-dirty-read", 1],
      ["computed/equality-suppression", "computed-equality", 1],
      ["batch/two-writes-one-reaction", "batch-two-writes", 1],
      ["rfsg/deepSignal-watched-leaf-write", "rfsg/deepSignal-watched-leaf-write", 1],
      ["deepSignal/many-watched-leaves", "many-watched-leaves", 64, 20_000],
      ["deepSignal/many-watched-leaves", "many-watched-leaves", 1_000, 20_000],
    ],
  },
  "write-v011": {
    baseline: "rfsg-v0.1.1", candidate: "rfsg-current", primary: ["source/unobserved-write", "source/write-read"],
    cases: [["source/unobserved-write", "source-unobserved-write", 1], ["source/write-read", "source-write-read", 1]],
  },
  "write-deep-leaves": {
    baseline: "rfsg-W0", candidate: "rfsg-current", primary: [],
    cases: [["deepSignal/many-watched-leaves", "deepSignal/many-watched-leaves", 64, 20_000], ["deepSignal/many-watched-leaves", "deepSignal/many-watched-leaves", 1_000, 20_000]],
  },
  "read-p1-current": {
    baseline: "rfsg-P0", candidate: "rfsg-P1", primary: ["source/read"],
    cases: [
      ["source/read", "source-read", 1], ["source/write-read", "source-write-read", 1],
      ["computed/dirty-read", "computed-dirty-read", 1], ["computed/equality-suppression", "computed-equality", 1],
      ["effect/observed-write", "effect-observed-write", 1],
    ],
  },
  "read-p2-current": {
    baseline: "rfsg-P1", candidate: "rfsg-P2", primary: ["source/read"],
    cases: [
      ["source/read", "source-read", 1], ["source/write-read", "source-write-read", 1],
      ["computed/dirty-read", "computed-dirty-read", 1], ["computed/equality-suppression", "computed-equality", 1],
      ["effect/observed-write", "effect-observed-write", 1],
    ],
  },
  "read-v011": {
    baseline: "rfsg-v0.1.1", candidate: "rfsg-current", primary: ["source/read"],
    cases: [["source/read", "source-read", 1], ["source/write-read", "source-write-read", 1]],
  },
};
const config = phaseCases[phase];
if (config === undefined) throw new Error(`Usage: node recovery-runner.mjs <${Object.keys(phaseCases).join("|")}> [--output path]`);

const cases = config.cases.map(([id, kind, size, customIterations]) => {
  const key = `${id}@${size}`;
  const iterations = customIterations ?? frozen[key];
  if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error(`Missing frozen iteration count ${key}.`);
  return { id, kind, size, iterations, customIterations: customIterations !== undefined };
});
const date = new Date().toISOString().slice(0, 10);
const runId = `${date}-${phase}-${process.pid}`;
const outputDir = outputArg === undefined
  ? resolve(here, `results/recovery-${date}/${phase}-${process.pid}`)
  : (isAbsolute(outputArg) ? outputArg : resolve(repoRoot, outputArg));
const git = promisify(execFile);
async function gitText(...args) {
  const { stdout } = await git("git", args, { cwd: repoRoot, windowsHide: true });
  return stdout.trim();
}
const startedAt = new Date().toISOString();
const [head, status, inputsSha256, artifact, referenceCommit] = await Promise.all([
  gitText("rev-parse", "HEAD"), gitText("status", "--porcelain"), hashCurrentRuntimeInputs(),
  hashCurrentRuntimeArtifact(), gitText("rev-parse", "v0.1.1^{commit}"),
]);
if (config.baseline === "rfsg-v0.1.1" && referenceCommit !== "0e12bbf46ab098fbb2388704ab85c3c406189cbb") {
  throw new Error(`v0.1.1 reference tag resolved to unexpected commit ${referenceCommit}.`);
}
const manifest = {
  schemaVersion: 1,
  runId,
  phase,
  status: "running",
  preRunStateCapturedAt: startedAt,
  currentHead: head,
  worktreeDirty: status.length > 0,
  dirtyPaths: status === "" ? [] : status.split(/\r?\n/),
  baseline: config.baseline,
  candidate: config.candidate,
  v011Commit: referenceCommit,
  environment: { node: process.version, nodeExecutable: process.execPath, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? "unknown" },
  protocol: { pairsPerWorkloadSession: 24, primarySessions: 3, controlSessions: 1, warmups, samples: samplesPerProcess, gc: "global.gc() immediately before each warmup and measured execution", iterationFile: "benchmarks/phase9/m1b-iterations.json", iterationSha256: createHash("sha256").update(frozenBytes).digest("hex"), pairOrder },
  sourceInputsSha256: inputsSha256,
  candidateArtifact: artifact,
  workloadCounts: Object.fromEntries(cases.map((item) => [`${item.id}@${item.size}`, { iterations: item.iterations, frozen: !item.customIterations }])),
  sessions: {},
  startedAt,
};

// Record start state first. The run's output must not contaminate the manifest.
await mkdir(dirname(outputDir), { recursive: true });
await mkdir(outputDir, { recursive: false });
for (const name of ["samples.jsonl", "pairs.jsonl", "failures.jsonl"]) await writeFile(resolve(outputDir, name), "", "utf8");
const manifestPath = resolve(outputDir, "manifest.json");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const workerStandard = resolve(here, "worker.mjs");
const workerDeep = resolve(repoRoot, "benchmarks/phase9/deep-signal-ab-worker.mjs");
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};
const quantile = (values, p) => {
  const sorted = values.toSorted((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index), hi = Math.ceil(index);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
};

async function runChild(runtimeId, item) {
  const deep = item.id.includes("deepSignal") || item.kind.startsWith("deepSignal/");
  const script = deep ? workerDeep : workerStandard;
  const payload = deep
    ? { runtimeId, workload: item.kind, iterations: item.iterations, size: item.size, warmups, samples: samplesPerProcess }
    : { runtimeId, kind: item.kind, iterations: item.iterations, size: item.size, warmups, samples: samplesPerProcess };
  const startAt = new Date().toISOString();
  const start = performance.now();
  const child = spawn(process.execPath, ["--expose-gc", script, JSON.stringify(payload)], { cwd: repoRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exit = await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => { child.kill(); rejectPromise(new Error(`Timed out: ${runtimeId} ${item.id}@${item.size}`)); }, 600_000);
    child.once("error", (error) => { clearTimeout(timeout); rejectPromise(error); });
    child.once("close", (code, signal) => { clearTimeout(timeout); resolvePromise({ code, signal }); });
  });
  const endAt = new Date().toISOString();
  let output;
  try { output = JSON.parse(stdout); }
  catch { throw new Error(`Invalid JSON from ${runtimeId} ${item.id}@${item.size} (exit=${exit.code}); ${stderr}; ${stdout.slice(0, 400)}`); }
  if (exit.code !== 0 || output.status !== "ok") throw new Error(`Worker failed ${runtimeId} ${item.id}@${item.size}: ${stderr}`);
  const measured = output.measured;
  if (measured.length !== samplesPerProcess) throw new Error(`Expected seven samples from ${runtimeId} ${item.id}@${item.size}.`);
  return { runtimeId, output, measured, startAt, endAt, processDurationMs: Math.round((performance.now() - start) * 100) / 100, pid: child.pid };
}

async function append(file, row) { await appendFile(resolve(outputDir, file), `${JSON.stringify(row)}\n`, "utf8"); }
const summaries = [];
try {
  for (const item of cases) {
    const sessions = config.primary.includes(item.id) ? [1, 2, 3] : [1];
    for (const session of sessions) {
      const label = `session-${session}`;
      const ratios = [];
      for (let pair = 1; pair <= 24; pair += 1) {
        const order = pairOrder[pair - 1];
        const resultBySide = {};
        for (const side of order) {
          const runtimeId = side === "A" ? config.baseline : config.candidate;
          const result = await runChild(runtimeId, item);
          resultBySide[side] = result;
          const durations = result.measured.map((sample) => sample.durationNs);
          const processMedianDurationNs = median(durations);
          for (let index = 0; index < result.measured.length; index += 1) {
            await append("samples.jsonl", {
              session: label, pair, order, side, runtimeId, workload: item.id, kind: item.kind, size: item.size,
              iterations: item.iterations, warmups, sample: index + 1, durationNs: result.measured[index].durationNs,
              processMedianDurationNs, startedAt: result.startAt, endedAt: result.endAt,
              processDurationMs: result.processDurationMs, pid: result.pid, node: process.version,
              cpu: manifest.environment.cpu, gcExposed: true, preflight: "passed",
            });
          }
        }
        const baselineMedian = median(resultBySide.A.measured.map((sample) => sample.durationNs));
        const candidateMedian = median(resultBySide.B.measured.map((sample) => sample.durationNs));
        const ratio = baselineMedian / candidateMedian;
        ratios.push(ratio);
        await append("pairs.jsonl", {
          session: label, pair, order, workload: item.id, kind: item.kind, size: item.size, iterations: item.iterations,
          baseline: config.baseline, candidate: config.candidate, baselineMedianDurationNs: baselineMedian,
          candidateMedianDurationNs: candidateMedian, throughputRatioCandidateOverBaseline: ratio,
          candidateFaster: ratio > 1, baselineFaster: ratio < 1,
        });
        process.stdout.write(`${phase} ${label} ${item.id}@${item.size} pair ${pair}/24 ${order}\n`);
      }
      const q1 = quantile(ratios, 0.25), q3 = quantile(ratios, 0.75);
      summaries.push({ session: label, workload: item.id, size: item.size, iterations: item.iterations, pairs: ratios.length,
        median: median(ratios), q1, q3, iqr: q3 - q1, min: Math.min(...ratios), max: Math.max(...ratios),
        candidateFasterPairs: ratios.filter((value) => value > 1).length,
        baselineFasterPairs: ratios.filter((value) => value < 1).length });
      manifest.sessions[`${item.id}@${item.size}/${label}`] = { status: "completed", pairs: 24, summary: summaries.at(-1) };
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    }
  }
  await writeFile(resolve(outputDir, "summary.json"), `${JSON.stringify(summaries, null, 2)}\n`, "utf8");
  manifest.status = "completed";
} catch (error) {
  await append("failures.jsonl", { at: new Date().toISOString(), error: error?.stack ?? String(error) });
  manifest.status = "failed";
  throw error;
} finally {
  manifest.finishedAt = new Date().toISOString();
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
process.stdout.write(`Completed ${phase}: ${outputDir}\n`);
