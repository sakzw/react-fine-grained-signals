import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ALIEN_VERSION,
  CURRENT_PACKAGE_VERSION,
  RELEASED_COMMIT,
  RELEASED_TAG,
  RUNTIME_BASELINE_SHA,
  VUE_CORE_COMMIT,
  VUE_PACKAGE_VERSION,
  allocationWorkloadIds,
  commonCases,
  rfsgCases,
  runtimes,
  runtimeOrderForRound,
  smokeCases,
} from "./config.mjs";
import { verifiedPins } from "./verify-pins.mjs";
import { hashCurrentRuntimeArtifact, verifyCurrentRuntimeIdentity } from "./runtime-identity.mjs";

const execFileAsync = promisify(execFile);
const harnessDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(harnessDir, "../..");
const workerPath = resolve(harnessDir, "worker.mjs");
const reactWorkerPath = resolve(harnessDir, "react-worker.mjs");
const cli = process.argv.slice(2);
const modeIndex = cli.indexOf("--mode");
const requestedMode = modeIndex === -1 ? undefined : cli[modeIndex + 1];
const smoke = cli.includes("--smoke") || requestedMode === "smoke_validation";
const getOption = (name, fallback) => {
  const index = cli.indexOf(name);
  return index === -1 ? fallback : cli[index + 1];
};
const positiveInt = (name, fallback) => {
  const value = Number(getOption(name, fallback));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
};

const mode = smoke ? "smoke_validation" : (requestedMode ?? "measure");
if (!["measure", "smoke_validation", "calibration"].includes(mode)) throw new Error(`Unsupported mode: ${mode}`);
const calibration = mode === "calibration";
const preflightOnly = cli.includes("--preflight-only");
const rounds = smoke ? 1 : positiveInt("--rounds", calibration ? 1 : 8);
const warmups = smoke ? 1 : positiveInt("--warmups", calibration ? 1 : 3);
const samples = smoke ? 1 : positiveInt("--samples", calibration ? 3 : 7);
const iterationOverride = smoke ? 12 : (cli.includes("--iterations") ? positiveInt("--iterations", 1) : undefined);
const iterationsFileOption = getOption("--iterations-file", undefined);
const runtimeInputsSha256Option = getOption("--runtime-inputs-sha256", undefined);
if (mode === "measure" && iterationsFileOption === undefined) {
  throw new Error("M1b measurement requires --iterations-file with a frozen calibration result. Run calibration first; no benchmark workers were started.");
}
if (iterationOverride !== undefined && iterationsFileOption !== undefined) {
  throw new Error("Use either --iterations or --iterations-file, not both.");
}
const graphCount = smoke ? 12 : positiveInt("--graph-count", 1_000);
const sizeOverride = smoke ? [4] : (cli.includes("--sizes")
  ? getOption("--sizes", "").split(",").map((part) => Number(part))
  : undefined);
if (sizeOverride?.some((value) => !Number.isSafeInteger(value) || value < 1)) {
  throw new Error("--sizes must be comma-separated positive integers.");
}

const timestamp = new Date().toISOString();
const runId = `${timestamp.replaceAll(/[:.]/g, "-")}-${process.pid}`;
const outputOption = getOption("--output", undefined);
const outputDir = outputOption === undefined
  ? (smoke
    ? resolve(tmpdir(), `rfsg-phase9-${runId}`)
    : resolve(harnessDir, calibration ? "calibration" : "results", runId))
  : resolve(repoRoot, outputOption);
if (runtimeInputsSha256Option !== undefined && mode !== "measure") {
  throw new Error("--runtime-inputs-sha256 is only valid for an explicitly identified measure run.");
}
const runtimeIdentity = mode === "smoke_validation" ? null : await verifyCurrentRuntimeIdentity({
  expectedRuntimeInputsSha256: runtimeInputsSha256Option,
});
const currentRuntimeArtifact = runtimeIdentity?.artifact ?? await hashCurrentRuntimeArtifact();
const samplesPath = resolve(outputDir, "samples.jsonl");
const failuresPath = resolve(outputDir, "failures.jsonl");
const allocationPath = resolve(outputDir, "allocations.jsonl");

async function gitOutput(args) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: repoRoot, windowsHide: true });
    return stdout.trim();
  } catch {
    return "unavailable";
  }
}

// Capture the repository state before this run creates any output files.
const gitHead = await gitOutput(["rev-parse", "HEAD"]);
const dirtyPathsText = await gitOutput(["status", "--porcelain"]);
const dirtyPaths = dirtyPathsText === "" ? [] : dirtyPathsText.split(/\r?\n/);

async function sha256File(path) {
  try { return createHash("sha256").update(await readFile(path)).digest("hex"); }
  catch { return null; }
}

async function harnessHash() {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["node_modules", "results", "calibration"].includes(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push(path);
    }
  }
  await visit(harnessDir);
  files.sort();
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(relative(harnessDir, path).split(sep).join("/"));
    hash.update(await readFile(path));
  }
  return hash.digest("hex");
}

const cpu = (await import("node:os")).cpus()[0]?.model ?? "unknown";
const manifest = {
  schemaVersion: 1,
  mode,
  createdAt: timestamp,
  runId,
  gitHead,
  worktreeDirty: dirtyPaths.length > 0,
  dirtyPaths,
  phase9RuntimeBaselineSha: RUNTIME_BASELINE_SHA,
  v0_1_1: { tag: RELEASED_TAG, commit: RELEASED_COMMIT, packageVersion: "0.1.1", alienSignals: ALIEN_VERSION },
  currentRfsg: { packageVersion: CURRENT_PACKAGE_VERSION, runtimeBaselineSha: RUNTIME_BASELINE_SHA },
  alienSignals: { packageVersion: ALIEN_VERSION },
  vue: { packageVersion: VUE_PACKAGE_VERSION, vueCoreCommit: VUE_CORE_COMMIT },
  verifiedPins,
  harnessHead: gitHead,
  node: process.version,
  packageManagerUserAgent: process.env.npm_config_user_agent ?? "unknown",
  platform: process.platform,
  arch: process.arch,
  cpu,
  configurations: { rounds, warmups, samples, iterationOverride: iterationOverride ?? null, sizeOverride: sizeOverride ?? null, graphCount },
  gc: { workerFlag: "--expose-gc", requestedBeforeWarmupsAndSamples: true },
  deterministicOrder: "frozen balanced four-round runtime schedule; serial child execution",
  packageLockSha256: await sha256File(resolve(harnessDir, "pnpm-lock.yaml")),
  harnessSha256: await harnessHash(),
  outputDir,
  status: "running",
  completedTasks: 0,
  plannedTasks: 0,
};

const selectedCases = [...commonCases, ...rfsgCases].filter((definition) => !smoke || smokeCases.has(definition.id));
let expandedCases = selectedCases.flatMap((definition) => {
  const sizes = definition.sizes ? (sizeOverride ?? definition.sizes) : [definition.size ?? 1];
  return sizes.map((size) => ({ ...definition, size }));
});
let frozenIterationCounts = null;
let iterationsFileSha256 = null;
if (iterationsFileOption !== undefined) {
  if (smoke) throw new Error("--iterations-file is not used by smoke validation.");
  const iterationsFilePath = resolve(repoRoot, iterationsFileOption);
  const iterationsContent = await readFile(iterationsFilePath);
  const parsedIterationCounts = JSON.parse(iterationsContent.toString("utf8"));
  if (!parsedIterationCounts || Array.isArray(parsedIterationCounts) || typeof parsedIterationCounts !== "object") {
    throw new Error("The iterations file must be a JSON object keyed by '<caseId>@<size>'.");
  }
  const expectedIterationKeys = expandedCases.map(({ id, size }) => `${id}@${size}`);
  const suppliedIterationKeys = Object.keys(parsedIterationCounts);
  const missingKeys = expectedIterationKeys.filter((key) => !(key in parsedIterationCounts));
  const unexpectedKeys = suppliedIterationKeys.filter((key) => !expectedIterationKeys.includes(key));
  if (missingKeys.length > 0 || unexpectedKeys.length > 0) {
    throw new Error(`Iteration file coverage mismatch. Missing: ${missingKeys.join(", ") || "none"}; unexpected: ${unexpectedKeys.join(", ") || "none"}.`);
  }
  for (const [key, value] of Object.entries(parsedIterationCounts)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Iteration count for ${key} must be a positive integer.`);
  }
  frozenIterationCounts = parsedIterationCounts;
  iterationsFileSha256 = createHash("sha256").update(iterationsContent).digest("hex");
}
expandedCases = expandedCases.map((definition) => ({
  ...definition,
  iterations: frozenIterationCounts?.[`${definition.id}@${definition.size}`]
    ?? iterationOverride
    ?? (smoke ? 12 : definition.iterations),
}));
if (mode === "measure" && frozenIterationCounts === null) {
  throw new Error("M1b measurement requires a complete frozen iterations file; no benchmark workers were started.");
}
const includeAllocations = smoke || cli.includes("--allocations");
const allocationRounds = smoke ? 1 : (includeAllocations ? positiveInt("--allocation-rounds", 3) : 0);
const includeDeepAllocation = includeAllocations;
manifest.configurations.includeAllocations = includeAllocations;
manifest.configurations.allocationRounds = allocationRounds;
manifest.configurations.includeDeepAllocation = includeDeepAllocation;
manifest.configurations.iterationsFile = iterationsFileOption === undefined ? null : {
  path: iterationsFileOption,
  sha256: iterationsFileSha256,
  counts: frozenIterationCounts,
};
manifest.currentRuntimeArtifact = {
  ...currentRuntimeArtifact,
  identityGuard: runtimeIdentity?.identityGuard ?? "not-run-for-smoke",
  runtimeInputsSha256: runtimeIdentity?.runtimeInputsSha256 ?? null,
  guardedBaselineSha: RUNTIME_BASELINE_SHA,
};
const allocationTasksPerRound = allocationWorkloadIds.reduce((total, kind) => total + (
  kind === "deep-watched-leaves"
    ? runtimes.filter((runtime) => runtime.id.startsWith("rfsg-")).length
    : runtimes.length
), 0);
manifest.plannedTasks = expandedCases.length * runtimes.length * rounds
  + (includeAllocations ? allocationTasksPerRound * allocationRounds : 0);
if (preflightOnly) {
  process.stdout.write(`Preflight passed for mode=${mode}; no output directory was created and no benchmark workers were started.\n`);
  process.exit(0);
}
await mkdir(dirname(outputDir), { recursive: true });
await mkdir(outputDir, { recursive: false });
await writeFile(samplesPath, "", "utf8");
await writeFile(failuresPath, "", "utf8");
await writeFile(allocationPath, "", "utf8");
await writeFile(resolve(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

async function executeChild(payload, script = workerPath) {
  return await new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["--expose-gc", script, JSON.stringify(payload)], {
      cwd: harnessDir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = smoke ? 60_000 : 180_000;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolvePromise({ ok: false, exitCode: null, stdout, stderr: `${stderr}\nTimed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise({ ok: false, exitCode: null, stdout, stderr: `${stderr}\n${error.stack ?? error}` });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise({ ok: exitCode === 0, exitCode, stdout, stderr });
    });
  });
}

async function runAllocation(kind, runtime, round, orderPosition) {
  const rowBase = {
    schemaVersion: 1,
    mode,
    runId,
    caseId: `allocation/${kind}`,
    runtime: runtime.id,
    runtimeVersion: runtime.version,
    package: runtime.package,
    phase9RuntimeBaselineSha: RUNTIME_BASELINE_SHA,
    round,
    orderPosition,
    graphSize: graphCount,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu,
    diagnosticOnly: true,
  };
  manifest.completedTasks += 1;
  process.stdout.write(`[${manifest.completedTasks}/${manifest.plannedTasks}] allocation ${kind} ${runtime.id} n=${graphCount} round=${round}\n`);
  const result = await executeChild({ runtimeId: runtime.id, count: graphCount, kind }, resolve(harnessDir, "allocation-worker.mjs"));
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch { parsed = { status: "invalid_output" }; }
  const expectedGraphShape = kind === "signal-computed-effect-graph"
    ? { sourceSignals: graphCount, computedSignals: graphCount, effects: graphCount, deepSignalRoots: 0, watchedLeaves: 0, subscribersToSingleSource: 0 }
    : kind === "one-source-many-effects"
      ? { sourceSignals: 1, computedSignals: 0, effects: graphCount, deepSignalRoots: 0, watchedLeaves: 0, subscribersToSingleSource: graphCount }
      : { sourceSignals: 0, computedSignals: 0, effects: graphCount, deepSignalRoots: 1, watchedLeaves: graphCount, subscribersToSingleSource: 0 };
  const shapeMatches = JSON.stringify(parsed.graphShape) === JSON.stringify(expectedGraphShape);
  if (!result.ok || parsed.status !== "ok" || parsed.kind !== kind || !shapeMatches || parsed.disposedEffectsStopped !== true) {
    failed = true;
    await appendFile(failuresPath, `${JSON.stringify({
      ...rowBase,
      status: "failed",
      exitCode: result.exitCode,
      stderr: result.stderr,
      stdout: result.stdout,
      reason: `Allocation result did not prove the expected ${kind} graph shape.`,
      expectedGraphShape,
      actualGraphShape: parsed.graphShape ?? null,
    })}\n`);
    return;
  }
  await appendFile(allocationPath, `${JSON.stringify({ ...rowBase, ...parsed, shapeVerified: true })}\n`);
}

let failed = false;
try {
  for (let round = 0; round < rounds && !failed; round += 1) {
    const runtimeOrder = runtimeOrderForRound(round + 1);
    manifest[`round${round + 1}RuntimeOrder`] = runtimeOrder.map((runtime) => runtime.id);
    for (const definition of expandedCases) {
      for (let orderPosition = 0; orderPosition < runtimeOrder.length; orderPosition += 1) {
        const runtime = runtimeOrder[orderPosition];
        const rowBase = {
          schemaVersion: 1,
          mode,
          runId,
          caseId: definition.id,
          workload: definition.kind,
          runtime: runtime.id,
          runtimeVersion: runtime.version,
          package: runtime.package,
          phase9RuntimeBaselineSha: RUNTIME_BASELINE_SHA,
          round: round + 1,
          orderPosition: orderPosition + 1,
          iterations: definition.iterations,
          graphSize: definition.size,
          warmups,
          configuredSamples: samples,
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          cpu,
          gcExposed: true,
        };
        manifest.completedTasks += 1;
        if (definition.runtimes && !definition.runtimes.includes(runtime.id)) {
          await appendFile(samplesPath, `${JSON.stringify({
            ...rowBase,
            status: "na",
            reason: definition.react ? "React/RFSG integration workload; Alien and Vue have no comparable RFSG render boundary." : "RFSG-specific API; Alien and Vue do not expose deepSignal.",
          })}\n`);
          continue;
        }
        if (definition.kind === "batch-two-writes" && runtime.id === "vue-reactivity") {
          await appendFile(samplesPath, `${JSON.stringify({ ...rowBase, status: "na", reason: "No public multi-write transaction API." })}\n`);
          continue;
        }
        process.stdout.write(`[${manifest.completedTasks}/${manifest.plannedTasks}] ${runtime.id} ${definition.id} n=${definition.size} round=${round + 1}\n`);
        const childResult = await executeChild({
          runtimeId: runtime.id,
          kind: definition.kind,
          iterations: definition.iterations,
          size: definition.size,
          warmups,
          samples,
        }, definition.react ? reactWorkerPath : workerPath);
        let result;
        try { result = JSON.parse(childResult.stdout); }
        catch {
          result = { status: "invalid_output", message: "Worker did not emit a JSON result." };
        }
        if (!childResult.ok || result.status === "invalid_output") {
          failed = true;
          const failure = {
            ...rowBase,
            status: "failed",
            exitCode: childResult.exitCode,
            stderr: childResult.stderr,
            stdout: childResult.stdout,
            reason: result.message ?? "Worker exited unsuccessfully or a semantic assertion failed.",
          };
          await appendFile(failuresPath, `${JSON.stringify(failure)}\n`);
          await appendFile(samplesPath, `${JSON.stringify(failure)}\n`);
          process.stderr.write(`Failed: ${runtime.id} ${definition.id}; see ${failuresPath}\n`);
          break;
        }
        if (result.status === "na") {
          await appendFile(samplesPath, `${JSON.stringify({ ...rowBase, status: "na", reason: result.reason })}\n`);
          continue;
        }
        if (definition.kind === "adapter-read-diagnostic") {
          for (const sample of result.samples) {
            for (const [variant, durationNs] of [
              ["direct-native-call", sample.directDurationNs],
              ["normalized-adapter-call", sample.adapterDurationNs],
            ]) {
              await appendFile(samplesPath, `${JSON.stringify({
                ...rowBase,
                adapterVariant: variant,
                sample: sample.sample + 1,
                durationNs,
                operationsPerSecond: definition.iterations / (durationNs / 1e9),
                semanticAssertions: result.preflight,
                gcExposed: result.gcExposed,
                diagnosticOnly: true,
                status: "ok",
              })}\n`);
            }
          }
          continue;
        }
        for (const sample of result.samples) {
          await appendFile(samplesPath, `${JSON.stringify({
            ...rowBase,
            ...(definition.react ? { renders: sample.renders, domValue: sample.domValue, workloadGroup: "rfsg-react-directional" } : {}),
            sample: sample.sample + 1,
            durationNs: sample.durationNs,
            operationsPerSecond: definition.iterations / (sample.durationNs / 1e9),
            semanticAssertions: result.preflight,
            gcExposed: result.gcExposed,
            status: "ok",
          })}\n`);
        }
      }
      if (failed) break;
    }
  }
  for (let round = 0; round < allocationRounds && !failed; round += 1) {
    const runtimeOrder = runtimeOrderForRound(round + 1);
    manifest[`allocationRound${round + 1}RuntimeOrder`] = runtimeOrder.map((runtime) => runtime.id);
    for (let orderPosition = 0; orderPosition < runtimeOrder.length; orderPosition += 1) {
      const runtime = runtimeOrder[orderPosition];
      for (const kind of allocationWorkloadIds) {
        if (kind === "deep-watched-leaves" && !runtime.id.startsWith("rfsg-")) continue;
        await runAllocation(kind, runtime, round + 1, orderPosition + 1);
        if (failed) break;
      }
      if (failed) break;
    }
  }
} catch (error) {
  failed = true;
  await appendFile(failuresPath, `${JSON.stringify({ status: "orchestrator_failed", error: error?.stack ?? String(error) })}\n`);
} finally {
  manifest.status = failed ? "failed" : "completed";
  manifest.completedTasks = Math.min(manifest.completedTasks, manifest.plannedTasks);
  manifest.finishedAt = new Date().toISOString();
  await writeFile(resolve(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

const modeLabel = mode === "smoke_validation" ? "SMOKE / HARNESS VALIDATION ONLY" : (calibration ? "CALIBRATION PILOT / NOT AUTHORITATIVE" : "measurement requested");
process.stdout.write(`Run status: ${manifest.status}\nMode: ${modeLabel}\nResults: ${outputDir}\n`);
if (failed) process.exitCode = 1;
