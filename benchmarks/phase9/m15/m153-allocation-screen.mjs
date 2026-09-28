import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rounds = 3;
const count = 1_000;
const runtimes = ["rfsg-current", "rfsg-m151-owner", "rfsg-v0.1.1", "rfsg-pre-m15"];
const kinds = ["signal-computed-effect-graph", "one-source-many-effects", "deep-watched-leaves"];
const workerPath = fileURLToPath(new URL("../allocation-worker.mjs", import.meta.url));
const resultPath = new URL("./results/m153-allocation-results.json", import.meta.url);
const gitHead = process.env.M153_GIT_HEAD ?? "not-provided";
const dirtyPathsAtStart = (process.env.M153_START_STATUS ?? "").split(/\r?\n/u).filter(Boolean).map((line) => line.slice(3));
const result = {
  purpose: "M1.5.3 coarse retained-heap diagnostics (not allocation rates or a release gate)",
  gitHead, worktreeDirtyAtStart: dirtyPathsAtStart.length > 0, dirtyPathsAtStart,
  rounds, graphCount: count, runtimes, kinds, measurements: [],
};
function run(payload) {
  const proc = spawnSync(process.execPath, ["--expose-gc", workerPath, JSON.stringify(payload)], {
    encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024,
  });
  if (proc.status !== 0) throw new Error(`${payload.runtimeId} ${payload.kind}: ${proc.error?.message ?? proc.stderr ?? proc.stdout ?? `exit ${proc.status}`}`);
  const value = JSON.parse(proc.stdout);
  if (value.status !== "ok" || value.gcExposed !== true || value.disposedEffectsStopped !== true) throw new Error(`Allocation sanity failed: ${JSON.stringify(value)}`);
  return value;
}
for (const kind of kinds) for (const runtimeId of runtimes) for (let round = 0; round < rounds; round += 1) {
  const measurement = run({ runtimeId, kind, count });
  result.measurements.push({ runtimeId, kind, round: round + 1, ...measurement });
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
}
process.stdout.write(`Saved ${result.measurements.length} allocation diagnostics to ${resultPath.pathname}\n`);
