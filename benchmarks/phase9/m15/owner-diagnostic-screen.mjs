import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { commonCases } from "../config.mjs";
import { fileURLToPath } from "node:url";

const rounds = 24;
const warmups = 3;
const samples = 7;
const iterationCounts = JSON.parse(readFileSync(new URL("../m1b-iterations.json", import.meta.url), "utf8"));
const targets = [
  ["source/read", 1], ["source/write-read", 1], ["effect/observed-write", 1],
  ["effect/dynamic-dependencies", 1], ["effect/fanout", 16], ["effect/fanout", 64],
  ["computed/dirty-read", 1], ["computed/equality-suppression", 1],
];
const cases = [];
for (const [id, size] of targets) {
  const selected = commonCases.find((entry) => entry.id === id);
  const caseId = `${id}@${size}`;
  const iterations = iterationCounts[caseId];
  if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error(`Missing frozen iterations for ${caseId}`);
  cases.push({ id, caseId, kind: selected.kind, size, iterations });
}
const runtimes = ["m15-core", "m151-integrated", "rfsg-current", "rfsg-v0.1.1"];
// Four-round cyclic schedule balances all positions and every pair's order.
const schedule = [runtimes, [runtimes[1], runtimes[2], runtimes[3], runtimes[0]], [runtimes[2], runtimes[3], runtimes[0], runtimes[1]], [runtimes[3], runtimes[0], runtimes[1], runtimes[2]]];
const workerPath = fileURLToPath(new URL("./owner-diagnostic-worker.mjs", import.meta.url));
const resultPath = new URL("./owner-diagnostic-results.json", import.meta.url);
const result = { purpose: "M1.5.1 paired diagnostics; not authoritative M1b", rounds, warmups, samples, frozenIterationsFile: "../m1b-iterations.json", runtimes, cases, measurements: [] };

function run(payload) {
  const proc = spawnSync(process.execPath, ["--expose-gc", workerPath, JSON.stringify(payload)], { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 });
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
