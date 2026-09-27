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
  commonCases,
  rfsgCases,
  runtimes,
  smokeCases,
} from "./config.mjs";
import { verifiedPins } from "./verify-pins.mjs";

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
if (mode !== "measure" && mode !== "smoke_validation") throw new Error(`Unsupported mode: ${mode}`);
const rounds = smoke ? 1 : positiveInt("--rounds", 8);
const warmups = smoke ? 1 : positiveInt("--warmups", 3);
const samples = smoke ? 1 : positiveInt("--samples", 7);
const iterationOverride = smoke ? 12 : (cli.includes("--iterations") ? positiveInt("--iterations", 1) : undefined);
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
  ? (smoke ? resolve(tmpdir(), `rfsg-phase9-${runId}`) : resolve(harnessDir, "results", runId))
  : resolve(repoRoot, outputOption);
await mkdir(dirname(outputDir), { recursive: true });
await mkdir(outputDir, { recursive: false });
const samplesPath = resolve(outputDir, "samples.jsonl");
const failuresPath = resolve(outputDir, "failures.jsonl");
const allocationPath = resolve(outputDir, "allocations.jsonl");
await writeFile(samplesPath, "", "utf8");
await writeFile(failuresPath, "", "utf8");
await writeFile(allocationPath, "", "utf8");

async function gitOutput(args) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: repoRoot, windowsHide: true });
    return stdout.trim();
  } catch {
    return "unavailable";
  }
}

async function sha256File(path) {
  try { return createHash("sha256").update(await readFile(path)).digest("hex"); }
  catch { return null; }
}

async function harnessHash() {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "results") continue;
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
const gitHead = await gitOutput(["rev-parse", "HEAD"]);
const dirtyPathsText = await gitOutput(["status", "--porcelain"]);
const dirtyPaths = dirtyPathsText === "" ? [] : dirtyPathsText.split(/\r?\n/);
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
  deterministicOrder: "runtime index rotated by round number; serial child execution",
  packageLockSha256: await sha256File(resolve(harnessDir, "pnpm-lock.yaml")),
  harnessSha256: await harnessHash(),
  outputDir,
  status: "running",
  completedTasks: 0,
  plannedTasks: 0,
};

const selectedCases = [...commonCases, ...rfsgCases].filter((definition) => !smoke || smokeCases.has(definition.id));
const expandedCases = selectedCases.flatMap((definition) => {
  const sizes = definition.sizes ? (sizeOverride ?? definition.sizes) : [definition.size ?? 1];
  return sizes.map((size) => ({ ...definition, size, iterations: iterationOverride ?? (smoke ? 12 : definition.iterations) }));
});
const includeAllocations = smoke || cli.includes("--allocations");
const allocationRounds = smoke ? 1 : (includeAllocations ? positiveInt("--allocation-rounds", 3) : 0);
const includeDeepAllocation = includeAllocations;
manifest.configurations.includeAllocations = includeAllocations;
manifest.configurations.allocationRounds = allocationRounds;
manifest.configurations.includeDeepAllocation = includeDeepAllocation;
manifest.plannedTasks = expandedCases.length * runtimes.length * rounds
  + (includeAllocations ? runtimes.length * allocationRounds * 2 : 0)
  + (includeDeepAllocation ? 2 * allocationRounds : 0);
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
  if (!result.ok || parsed.status === "invalid_output") {
    failed = true;
    await appendFile(failuresPath, `${JSON.stringify({ ...rowBase, status: "failed", exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout })}\n`);
    return;
  }
  await appendFile(allocationPath, `${JSON.stringify({ ...rowBase, ...parsed })}\n`);
}

let failed = false;
try {
  for (let round = 0; round < rounds && !failed; round += 1) {
    const rotation = round % runtimes.length;
    const runtimeOrder = runtimes.map((_, index) => runtimes[(index + rotation) % runtimes.length]);
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
    const rotation = round % runtimes.length;
    const runtimeOrder = runtimes.map((_, index) => runtimes[(index + rotation) % runtimes.length]);
    for (let orderPosition = 0; orderPosition < runtimeOrder.length; orderPosition += 1) {
      const runtime = runtimeOrder[orderPosition];
      await runAllocation("signal-computed-effect-graph", runtime, round + 1, orderPosition + 1);
      if (failed) break;
      await runAllocation("one-source-many-effects", runtime, round + 1, orderPosition + 1);
      if (failed) break;
    }
  }
  if (includeDeepAllocation && !failed) {
    const deepRuntimeOrder = runtimes.filter((runtime) => runtime.id.startsWith("rfsg-"));
    for (let round = 0; round < allocationRounds && !failed; round += 1) {
      for (let orderPosition = 0; orderPosition < deepRuntimeOrder.length; orderPosition += 1) {
        await runAllocation("deep-watched-leaves", deepRuntimeOrder[orderPosition], round + 1, orderPosition + 1);
        if (failed) break;
      }
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

process.stdout.write(`Run status: ${manifest.status}\nMode: ${mode === "smoke_validation" ? "SMOKE / HARNESS VALIDATION ONLY" : "measurement requested"}\nResults: ${outputDir}\n`);
if (failed) process.exitCode = 1;
