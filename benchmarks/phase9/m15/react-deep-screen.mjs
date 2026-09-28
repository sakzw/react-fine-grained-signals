import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const frozen = JSON.parse(readFileSync(new URL("../m1b-iterations.json", import.meta.url), "utf8"));
const runtimes = ["m15-control", "m15-candidate"];
const rounds = 4;
const warmups = 3;
const samples = 7;
const cases = [
  { id: "rfsg/react-useSignalValue@1", kind: "useSignalValue", iterations: frozen["rfsg/react-useSignalValue@1"] },
  { id: "rfsg/react-deep-selector@1", kind: "deep-selector", iterations: frozen["rfsg/react-useSignalValue@1"] },
];
for (const item of cases) if (!Number.isSafeInteger(item.iterations) || item.iterations <= 0) throw new Error(`Missing valid iterations for ${item.id}`);
const worker = fileURLToPath(new URL("./react-deep-worker.mjs", import.meta.url));
const output = new URL("./react-deep-results.json", import.meta.url);
const preflights = [];
const results = [];
const orderSchedule = [runtimes, [...runtimes].reverse()];
const save = () => writeFileSync(output, `${JSON.stringify({ purpose: "M1.5 React/DeepSignal paired diagnostic only", sourceIterations: "m1b-iterations.json rfsg/react-useSignalValue@1", rounds, warmups, samples, orderSchedule, preflights, results }, null, 2)}\n`);
function run(item, runtimeId, preflightOnly = false) {
  const result = spawnSync(process.execPath, ["--expose-gc", worker, JSON.stringify({ ...item, runtimeId, warmups, samples, preflightOnly })], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`${item.id}/${runtimeId}: ${result.stderr || result.stdout}`);
  const parsed = JSON.parse(result.stdout);
  if (parsed.status !== "ok" || parsed.preflight !== "passed") throw new Error(`Invalid worker response: ${result.stdout}`);
  return preflightOnly ? parsed : parsed.durationsNs;
}
save();
for (const item of cases) for (const runtimeId of runtimes) {
  const preflight = run(item, runtimeId, true);
  preflights.push(preflight);
  save();
}
for (const item of cases) for (let round = 0; round < rounds; round += 1) {
  const order = orderSchedule[round % orderSchedule.length];
  const perRuntime = {};
  for (const runtimeId of order) perRuntime[runtimeId] = run(item, runtimeId);
  results.push({ caseId: item.id, kind: item.kind, iterations: item.iterations, round: round + 1, order, perRuntime });
  save();
  process.stderr.write(`completed ${item.id} round ${round + 1}/${rounds}\n`);
}
process.stdout.write(`completed ${results.length} paired diagnostics; raw durations: ${output.pathname}\n`);
