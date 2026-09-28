import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { commonCases } from "../config.mjs";
import { fileURLToPath } from "node:url";

const rounds = 24;
const warmups = 3;
const samples = 7;
const iterationsPath = new URL("../m1b-iterations.json", import.meta.url);
const iterationsBytes = readFileSync(iterationsPath);
const iterations = JSON.parse(iterationsBytes.toString("utf8"));
const gitHead = process.env.M153_GIT_HEAD ?? "not-provided";
const startStatus = process.env.M153_START_STATUS ?? "";
const dirtyPathsAtStart = startStatus.split(/\r?\n/u).filter(Boolean).map((line) => line.slice(3));
const runtimes = ["rfsg-current", "m151-integrated", "rfsg-v0.1.1", "rfsg-pre-m15"];
const schedule = [
  [runtimes[0], runtimes[1], runtimes[3], runtimes[2]],
  [runtimes[1], runtimes[2], runtimes[0], runtimes[3]],
  [runtimes[2], runtimes[3], runtimes[1], runtimes[0]],
  [runtimes[3], runtimes[0], runtimes[2], runtimes[1]],
];
const allTargets = [
  ["source/read", 1], ["source/write-read", 1],
  ["effect/create", 1], ["effect/create-dispose", 1],
  ["effect/observed-write", 1], ["effect/dynamic-dependencies", 1],
  ["effect/fanout", 1], ["effect/fanout", 16], ["effect/fanout", 64],
  ["computed/dirty-read", 1], ["computed/equality-suppression", 1],
  ["batch/two-writes-one-reaction", 1],
];
const sourceFastPathOnly = process.env.M153_SOURCE_FAST_PATH_ONLY === "1";
const targets = sourceFastPathOnly ? allTargets.slice(0, 2) : allTargets;
const cases = targets.map(([id, size]) => {
  const selected = commonCases.find((entry) => entry.id === id);
  const caseId = `${id}@${size}`;
  const count = iterations[caseId];
  if (!Number.isSafeInteger(count) || count < 1 || selected === undefined) throw new Error(`Missing frozen case: ${caseId}`);
  return { id, caseId, kind: selected.kind, size, iterations: count };
});
const workerPath = fileURLToPath(new URL("./owner-diagnostic-worker.mjs", import.meta.url));
const resultPath = new URL(sourceFastPathOnly
  ? "./results/m153-source-fast-path-results.json"
  : "./results/m153-diagnostic-results.json", import.meta.url);
const result = {
  purpose: sourceFastPathOnly
    ? "M1.5.3 source getter fast-path follow-up; fresh-process paired duration diagnostics, not an M1b release matrix"
    : "M1.5.3 pre-freeze diagnostic; fresh-process paired duration measurements, not an M1b release matrix",
  gitHead,
  worktreeDirtyAtStart: dirtyPathsAtStart.length !== 0,
  dirtyPathsAtStart,
  rounds, warmups, samples,
  frozenIterationsFile: "../m1b-iterations.json",
  frozenIterationsSha256: createHash("sha256").update(iterationsBytes).digest("hex"),
  runtimes,
  schedule: schedule.map((row) => [...row]),
  cases,
  measurements: [],
};

function run(payload) {
  const proc = spawnSync(process.execPath, ["--expose-gc", workerPath, JSON.stringify(payload)], {
    encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024,
  });
  if (proc.status !== 0) throw new Error(`${payload.runtimeId} ${payload.caseId}: ${proc.error?.message ?? proc.stderr ?? proc.stdout ?? `exit ${proc.status}`}`);
  const value = JSON.parse(proc.stdout);
  if (value.status !== "ok" || value.preflight !== "passed") throw new Error(`Preflight failed: ${JSON.stringify(value)}`);
  return value;
}

for (const item of cases) for (const runtimeId of runtimes) run({ ...item, runtimeId, preflightOnly: true });
writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
for (const item of cases) {
  for (let round = 0; round < rounds; round += 1) {
    const order = schedule[round % 4];
    const perRuntime = {};
    for (const runtimeId of order) perRuntime[runtimeId] = run({ ...item, runtimeId, warmups, samples }).durationsNs;
    result.measurements.push({ ...item, round: round + 1, order, perRuntime });
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`${item.caseId} round ${round + 1}/${rounds}\n`);
  }
}
process.stdout.write(`Saved ${result.measurements.length} paired rounds to ${resultPath.pathname}\n`);
