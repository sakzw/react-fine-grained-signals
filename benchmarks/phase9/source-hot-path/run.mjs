import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { cpus, arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const resultsRoot = join(here, "results", "diagnostic-2026-09-29");
const cli = process.argv.slice(2);
const option = (name, fallback) => cli.includes(name) ? cli[cli.indexOf(name) + 1] : fallback;
const mode = cli[0] ?? "screen";
const session = Number(option("--session", "0"));
const readCandidate = option("--read-candidate", "");
const writeCandidate = option("--write-candidate", "");
const frozen = JSON.parse(await readFile(join(repoRoot, "benchmarks/phase9/m1b-iterations.json"), "utf8"));
const frozenBytes = await readFile(join(repoRoot, "benchmarks/phase9/m1b-iterations.json"));
const pairOrders = ["AB", "BA", "BA", "AB", "AB", "BA", "AB", "BA", "BA", "AB", "BA", "AB", "AB", "BA", "BA", "AB", "AB", "BA", "AB", "BA", "BA", "AB", "BA", "AB"];
const samplesPerProcess = 7;
const warmups = 3;

const screening = [];
for (const candidate of ["R1", "R2", "R3", "R4", "R5"]) {
  screening.push(...["source-read", "source-write-read"].map((kind) => ({ candidate: `rfsg-${candidate}`, kind, iterations: frozen[`source/${kind === "source-read" ? "read" : "write-read"}@1`] })));
}
for (const candidate of ["W1", "W2", "W3", "W4"]) {
  screening.push(...[
    ["source-unobserved-write", "source/unobserved-write"],
    ["source-write-read", "source/write-read"],
    ["effect-observed-write", "effect/observed-write"],
    ["computed-dirty-read", "computed/dirty-read"],
    ["batch-two-writes", "batch/two-writes-one-reaction"],
  ].map(([kind, key]) => ({ candidate: `rfsg-${candidate}`, kind, iterations: frozen[`${key}@1`] })));
}

function hashBytes(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function walk(dir) {
  const out = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).toSorted((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    else out.push(path);
  }
  return out;
}
async function treeHash(paths) {
  const h = createHash("sha256");
  for (const path of paths.toSorted()) {
    const bytes = await readFile(path);
    h.update(path.slice(repoRoot.length).replaceAll("\\", "/"));
    h.update("\0"); h.update(bytes); h.update("\0");
  }
  return h.digest("hex");
}
const inputFiles = [
  ...await walk(join(repoRoot, "src")),
  ...["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "tsdown.config.ts", "scripts/strip-dts-sourcemap-comments.mjs"].map((p) => join(repoRoot, p)),
];
const controlFiles = await walk(join(repoRoot, "dist")).then((paths) => paths.filter((p) => p.endsWith(".js")));
const runtimeInputsSha256 = await treeHash(inputFiles);
const controlArtifactSha256 = await treeHash(controlFiles);
const currentHead = option("--head", "unrecorded");
const frozenSha256 = hashBytes(frozenBytes);
const environment = { node: process.version, nodeExecutable: process.execPath, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? "unknown" };
const manifestPath = join(resultsRoot, "manifest.json");
let manifest;
try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
catch {
  await mkdir(resultsRoot, { recursive: true });
  manifest = {
    schemaVersion: 1,
    sourceHead: currentHead,
    verifiedStartingHead: "a6afcbc1e79573272b25740a5066d8429d32e1f5",
    v011TagCommit: "0e12bbf46ab098fbb2388704ab85c3c406189cbb",
    status: "running",
    sourceRuntime: { inputsSha256: runtimeInputsSha256, controlArtifactSha256, files: controlFiles.map((p) => p.slice(repoRoot.length + 1).replaceAll("\\", "/")) },
    frozenIterations: { path: "benchmarks/phase9/m1b-iterations.json", sha256: frozenSha256, counts: frozen },
    environment,
    protocol: { screeningPairs: 12, confirmationPairsPerSession: 24, sessions: 3, warmups, samples: samplesPerProcess, forcedGc: "global.gc() before each warmup and sample", pairOrders: pairOrders.slice(0, 24), workloadIterationCounts: frozen },
    variantBuild: JSON.parse(await readFile(join(here, "variant-manifest.json"), "utf8")),
    screenStatus: "pending",
    sessions: {},
  };
  await writeFile(join(resultsRoot, "samples.jsonl"), "", "utf8");
  await writeFile(join(resultsRoot, "pairs.jsonl"), "", "utf8");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
if (manifest.sourceHead !== currentHead || manifest.sourceRuntime.inputsSha256 !== runtimeInputsSha256 || manifest.sourceRuntime.controlArtifactSha256 !== controlArtifactSha256 || manifest.frozenIterations.sha256 !== frozenSha256) throw new Error("Source, control artifact, or frozen iteration identity changed between diagnostic invocations.");

async function assertIdentity() {
  if (await treeHash(inputFiles) !== runtimeInputsSha256) throw new Error("ABORT: production source/runtime input hash changed during diagnostic run.");
  if (await treeHash(controlFiles) !== controlArtifactSha256) throw new Error("ABORT: production control artifact hash changed during diagnostic run.");
  if (hashBytes(await readFile(join(repoRoot, "benchmarks/phase9/m1b-iterations.json"))) !== frozenSha256) throw new Error("ABORT: frozen iteration file changed during diagnostic run.");
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function quantile(sorted, p) {
  const index = (sorted.length - 1) * p; const lower = Math.floor(index); const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}
async function runWorker(runtimeId, item) {
  const payload = { runtimeId, kind: item.kind, iterations: item.iterations, size: 1, warmups, samples: samplesPerProcess };
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const child = spawn(process.execPath, ["--expose-gc", join(here, "worker.mjs"), JSON.stringify(payload)], { cwd: here, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (part) => { stdout += part; });
  child.stderr.setEncoding("utf8").on("data", (part) => { stderr += part; });
  const exitCode = await new Promise((ok, bad) => {
    const timeout = setTimeout(() => { child.kill(); bad(new Error(`Timeout: ${runtimeId} ${item.kind}`)); }, 180_000);
    child.once("error", (error) => { clearTimeout(timeout); bad(error); });
    child.once("close", (code) => { clearTimeout(timeout); ok(code); });
  });
  let result;
  try { result = JSON.parse(stdout); } catch { throw new Error(`Invalid worker JSON ${runtimeId}/${item.kind}: ${stderr} ${stdout.slice(0, 500)}`); }
  if (exitCode !== 0 || result.status !== "ok") throw new Error(`Worker failed ${runtimeId}/${item.kind}: ${stderr}`);
  return { startedAt, endedAt: new Date().toISOString(), pid: child.pid, processDurationMs: Math.round((performance.now() - started) * 100) / 100, result };
}
async function pair(item, pairNo, label, pairCount, candidate, currentId = "rfsg-current") {
  await assertIdentity();
  const order = pairOrders[(pairNo - 1) % pairOrders.length];
  const byId = {};
  for (const slot of order) {
    const runtimeId = slot === "A" ? candidate : currentId;
    process.stdout.write(`[${label}] ${pairNo}/${pairCount} ${order} ${item.kind} ${runtimeId}\n`);
    const record = await runWorker(runtimeId, item);
    byId[slot] = record;
    const medianDurationNs = median(record.result.measured.map((sample) => sample.durationNs));
    for (let i = 0; i < record.result.measured.length; i += 1) await appendFile(join(resultsRoot, "samples.jsonl"), `${JSON.stringify({ label, pair: pairNo, order, candidate, runtimeId, workload: item.kind, iterations: item.iterations, sample: i + 1, durationNs: record.result.measured[i].durationNs, medianDurationNs, startedAt: record.startedAt, endedAt: record.endedAt, pid: record.pid, processDurationMs: record.processDurationMs, ...environment })}\n`);
  }
  const candidateKey = candidate === byId.A.result.runtimeId ? "A" : "B";
  const cand = byId[candidateKey]; const ctrl = byId[candidateKey === "A" ? "B" : "A"];
  const candidateMedianNs = median(cand.result.measured.map((sample) => sample.durationNs));
  const controlMedianNs = median(ctrl.result.measured.map((sample) => sample.durationNs));
  const ratio = controlMedianNs / candidateMedianNs;
  const row = { label, pair: pairNo, order, candidate, control: currentId, workload: item.kind, iterations: item.iterations, candidateMedianNs, controlMedianNs, candidateOverControlThroughput: ratio, candidateFaster: ratio > 1, candidatePid: cand.pid, controlPid: ctrl.pid };
  await appendFile(join(resultsRoot, "pairs.jsonl"), `${JSON.stringify(row)}\n`);
  await assertIdentity();
  return row;
}
async function summarize(label, rows) {
  const ratios = rows.map((r) => r.candidateOverControlThroughput).toSorted((a, b) => a - b);
  return { label, pairs: rows.length, median: median(ratios), q1: quantile(ratios, 0.25), q3: quantile(ratios, 0.75), min: ratios[0], max: ratios.at(-1), candidateFasterPairs: rows.filter((r) => r.candidateFaster).length, controlFasterPairs: rows.filter((r) => !r.candidateFaster).length };
}

if (mode === "screen") {
  const summaries = manifest.screenSummaries ?? [];
  for (const item of screening) {
    const label = `screen/${item.candidate}/${item.kind}`;
    if (summaries.some((summary) => summary.label === label)) continue;
    if (item.candidate === "rfsg-R5" && item.kind === "source-write-read") {
      summaries.push({ label, status: "not-applicable", reason: "R5 intentionally skips graph settling, so it cannot satisfy write/read semantics." });
      manifest.screenSummaries = summaries;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      continue;
    }
    const rows = [];
    for (let i = 1; i <= 12; i += 1) rows.push(await pair(item, i, label, 12, item.candidate));
    summaries.push(await summarize(label, rows));
    manifest.screenStatus = "running";
    manifest.screenSummaries = summaries;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  manifest.screenStatus = "completed";
  manifest.screenSummaries = summaries;
} else if (mode === "confirm") {
  if (![1, 2, 3].includes(session) || !/^R[1-5]$/.test(readCandidate) || !/^W[1-4]$/.test(writeCandidate)) throw new Error("confirm requires --session 1|2|3 --read-candidate Rn --write-candidate Wn");
  const cases = [
    { candidate: `rfsg-${readCandidate}`, kinds: ["source-read", "source-write-read"] },
    { candidate: `rfsg-${writeCandidate}`, kinds: ["source-unobserved-write", "source-write-read"] },
  ];
  const summaries = [];
  for (const group of cases) for (const kind of group.kinds) {
    const item = { kind, iterations: frozen[`${kind === "source-read" ? "source/read" : kind === "source-write-read" ? "source/write-read" : "source/unobserved-write"}@1`] };
    const rows = [];
    for (let i = 1; i <= 24; i += 1) rows.push(await pair(item, i, `confirm/${session}/${group.candidate}/${kind}`, 24, group.candidate));
    summaries.push(await summarize(`confirm/${session}/${group.candidate}/${kind}`, rows));
  }
  manifest.sessions[String(session)] = { status: "completed", summaries };
} else if (mode === "compare") {
  if (!/^R[1-5]$/.test(readCandidate) || !/^W[1-4]$/.test(writeCandidate)) throw new Error("compare requires --read-candidate Rn --write-candidate Wn");
  const groups = [
    { candidate: `rfsg-${readCandidate}`, kinds: ["source-read", "source-write-read"], pairs: 24 },
    { candidate: `rfsg-${writeCandidate}`, kinds: ["source-unobserved-write", "source-write-read"], pairs: 24 },
  ];
  const comparisons = [];
  for (const control of ["rfsg-v0.1.1", "alien-signals"]) for (const group of groups) for (const kind of group.kinds) {
    const item = { kind, iterations: frozen[`${kind === "source-read" ? "source/read" : kind === "source-write-read" ? "source/write-read" : "source/unobserved-write"}@1`] };
    const label = `compare/${group.candidate}/${kind}/against-${control}`;
    const rows = [];
    const pairs = control === "alien-signals" ? 12 : group.pairs;
    for (let i = 1; i <= pairs; i += 1) rows.push(await pair(item, i, label, pairs, group.candidate, control));
    comparisons.push(await summarize(label, rows));
  }
  manifest.comparisons = { status: "completed", summaries: comparisons };
} else if (mode === "compare-control") {
  const groups = [
    { candidate: "rfsg-current", kinds: ["source-read", "source-unobserved-write", "source-write-read"] },
  ];
  const comparisons = [];
  for (const control of ["rfsg-v0.1.1", "alien-signals"]) for (const group of groups) for (const kind of group.kinds) {
    const item = { kind, iterations: frozen[`${kind === "source-read" ? "source/read" : kind === "source-write-read" ? "source/write-read" : "source/unobserved-write"}@1`] };
    const label = `compare/${group.candidate}/${kind}/against-${control}`;
    const rows = [];
    const pairs = control === "alien-signals" ? 12 : 24;
    for (let i = 1; i <= pairs; i += 1) rows.push(await pair(item, i, label, pairs, group.candidate, control));
    comparisons.push(await summarize(label, rows));
  }
  manifest.currentBaselines = { status: "completed", summaries: comparisons };
} else {
  throw new Error("Usage: node run.mjs screen | confirm --session N --read-candidate Rn --write-candidate Wn | compare --read-candidate Rn --write-candidate Wn | compare-control");
}
manifest.status = manifest.screenStatus === "completed"
  && Object.keys(manifest.sessions).length === 3
  && Object.values(manifest.sessions).every((entry) => entry.status === "completed")
  && manifest.comparisons?.status === "completed"
  ? "completed"
  : "running";
manifest.updatedAt = new Date().toISOString();
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const finalSummaries = mode === "screen" ? manifest.screenSummaries : mode === "confirm" ? manifest.sessions[String(session)].summaries : mode === "compare" ? manifest.comparisons.summaries : manifest.currentBaselines.summaries;
process.stdout.write(`${JSON.stringify(finalSummaries, null, 2)}\n`);

