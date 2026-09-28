import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rounds = 8;
const warmups = 3;
const samples = 7;
const iterations = JSON.parse(readFileSync(new URL("../m1b-iterations.json", import.meta.url), "utf8"));
const cases = [
  ["rfsg/react-bare-tracking", "bare"],
  ["rfsg/react-managed-tracking", "managed"],
  ["rfsg/react-useSignalValue", "useSignalValue"],
  ["rfsg/react-jsx-direct-binding", "jsx-binding"],
  ["rfsg/react-deep-selector", "deep-selector"],
].map(([caseId, kind]) => ({
  caseId,
  kind,
  iterations: iterations[`${caseId}@1`] ?? iterations["rfsg/react-useSignalValue@1"],
}));
const runtimes = ["rfsg-v0.1.1", "rfsg-current"];
const workerPath = fileURLToPath(new URL("../react-worker.mjs", import.meta.url));
const resultPath = new URL("./results/m153-react-results.json", import.meta.url);
const gitHead = process.env.M153_GIT_HEAD ?? "not-provided";
const dirtyPathsAtStart = (process.env.M153_START_STATUS ?? "").split(/\r?\n/u).filter(Boolean).map((line) => line.slice(3));
const result = {
  purpose: "M1.5.3 React integration paired diagnostics; not an M1b release matrix",
  gitHead, worktreeDirtyAtStart: dirtyPathsAtStart.length > 0, dirtyPathsAtStart,
  rounds, warmups, samples, runtimes, cases, measurements: [],
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
for (const item of cases) for (const runtimeId of runtimes) run({ ...item, runtimeId, warmups: 0, samples: 1 });
writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
for (const item of cases) for (let round = 0; round < rounds; round += 1) {
  const order = round % 2 === 0 ? runtimes : runtimes.toReversed();
  const perRuntime = {};
  for (const runtimeId of order) {
    const value = run({ ...item, runtimeId, warmups, samples });
    perRuntime[runtimeId] = value.samples.map((sample) => sample.durationNs);
  }
  result.measurements.push({ ...item, round: round + 1, order, perRuntime });
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stderr.write(`${item.caseId} round ${round + 1}/${rounds}\n`);
}
process.stdout.write(`Saved ${result.measurements.length} paired React rounds to ${resultPath.pathname}\n`);
