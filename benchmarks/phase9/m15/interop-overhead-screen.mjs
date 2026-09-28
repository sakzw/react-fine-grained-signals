import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const frozenIterations = JSON.parse(readFileSync(new URL("../m1b-iterations.json", import.meta.url), "utf8"));
const warmups = 3;
const samples = 7;
const rounds = 6;
const cases = [
  { id: "source/read@1", kind: "source-read", iterations: frozenIterations["source/read@1"], runtimeIds: ["m15-objectis", "m15-render-helper-call", "m15-render-live"] },
  { id: "effect/observed-write@1", kind: "effect-observed-write", iterations: frozenIterations["effect/observed-write@1"], runtimeIds: ["m15-objectis", "m15-render-helper-call", "m15-render-live"] },
  { id: "foreign/effect-observed-write@1", kind: "effect-observed-write", iterations: frozenIterations["effect/observed-write@1"], runtimeIds: ["m15-render-helper-call", "m15-render-foreign"] },
];
for (const item of cases) if (!Number.isSafeInteger(item.iterations) || item.iterations <= 0) throw new Error(`Invalid frozen iterations for ${item.id}`);
const worker = fileURLToPath(new URL("./interop-overhead-worker.mjs", import.meta.url));
const output = new URL("./interop-overhead-results-balanced.json", import.meta.url);
const orderSchedules = {
  threeRuntimes: [
    ["A", "B", "C"], ["B", "C", "A"], ["C", "A", "B"],
    ["A", "C", "B"], ["C", "B", "A"], ["B", "A", "C"],
  ],
  twoRuntimes: ["forward", "reverse"],
};
const results = [];
const preflights = [];

function runWorker(item, runtimeId, preflightOnly = false) {
  const result = spawnSync(process.execPath, ["--expose-gc", worker, JSON.stringify({ ...item, runtimeId, warmups, samples, preflightOnly })], {
    encoding: "utf8", windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`${runtimeId} ${item.id} failed: ${result.stderr || result.stdout}`);
  const parsed = JSON.parse(result.stdout);
  if (parsed.status !== "ok" || parsed.preflight !== "passed") throw new Error(`Invalid worker output: ${result.stdout}`);
  return parsed.durationsNs;
}

function balancedOrder(ids, roundIndex) {
  if (ids.length === 3) {
    const sixRoundSchedule = [
      [ids[0], ids[1], ids[2]],
      [ids[1], ids[2], ids[0]],
      [ids[2], ids[0], ids[1]],
      [ids[0], ids[2], ids[1]],
      [ids[2], ids[1], ids[0]],
      [ids[1], ids[0], ids[2]],
    ];
    return sixRoundSchedule[roundIndex % sixRoundSchedule.length];
  }
  if (ids.length === 2) return roundIndex % 2 === 0 ? [...ids] : [...ids].reverse();
  return [...ids];
}

writeFileSync(output, `${JSON.stringify({ purpose: "M1.5 render/interop overhead diagnostic only", frozenIterationsFile: "../m1b-iterations.json", rounds, warmups, samples, orderSchedules, preflights, results }, null, 2)}\n`);
for (const item of cases) for (const runtimeId of item.runtimeIds) {
  const actual = runWorker(item, runtimeId, true);
  preflights.push({ caseId: item.id, ...actual });
  writeFileSync(output, `${JSON.stringify({ purpose: "M1.5 render/interop overhead diagnostic only", frozenIterationsFile: "../m1b-iterations.json", rounds, warmups, samples, orderSchedules, preflights, results }, null, 2)}\n`);
}
for (const item of cases) {
  const ids = item.runtimeIds;
  for (let round = 0; round < rounds; round += 1) {
    const order = balancedOrder(ids, round);
    const perRuntime = {};
    for (const runtimeId of order) perRuntime[runtimeId] = runWorker(item, runtimeId);
    results.push({ caseId: item.id, kind: item.kind, iterations: item.iterations, round: round + 1, order, perRuntime });
    writeFileSync(output, `${JSON.stringify({ purpose: "M1.5 render/interop overhead diagnostic only", frozenIterationsFile: "../m1b-iterations.json", rounds, warmups, samples, orderSchedules, preflights, results }, null, 2)}\n`);
    process.stderr.write(`completed ${item.id} round ${round + 1}/${rounds}\n`);
  }
}
process.stdout.write(`completed ${results.length} diagnostic rounds; raw per-process durations: ${output.pathname}\n`);
