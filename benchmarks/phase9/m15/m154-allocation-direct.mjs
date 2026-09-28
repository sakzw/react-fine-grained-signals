import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const count = 1_000;
const rounds = 4;
const kinds = ["signal-computed-effect-graph", "one-source-many-effects", "deep-watched-leaves"];
const schedule = [
  ["rfsg-m153", "m154-c3"],
  ["m154-c3", "rfsg-m153"],
  ["rfsg-m153", "m154-c3"],
  ["m154-c3", "rfsg-m153"],
];
const workerPath = fileURLToPath(new URL("../allocation-worker.mjs", import.meta.url));
const directResults = JSON.parse(readFileSync(new URL("./results/m154-m153-direct-results.json", import.meta.url), "utf8"));
const resultPath = new URL("./results/m154-m153-allocation-direct-results.json", import.meta.url);
const result = {
  purpose: "M1.5.4 coarse retained-heap comparison; directional only, not allocation rates or a release gate",
  gitHead: directResults.gitHead,
  node: process.version,
  graphCount: count,
  rounds,
  schedule,
  runtimeIdentities: directResults.runtimeIdentities,
  kinds,
  measurements: [],
};

function run(payload) {
  const proc = spawnSync(process.execPath, ["--expose-gc", workerPath, JSON.stringify(payload)], {
    encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024,
  });
  if (proc.status !== 0) throw new Error(`${payload.runtimeId} ${payload.kind}: ${proc.error?.message ?? proc.stderr ?? proc.stdout ?? `exit ${proc.status}`}`);
  const value = JSON.parse(proc.stdout);
  if (value.status !== "ok" || value.gcExposed !== true || value.disposedEffectsStopped !== true) {
    throw new Error(`Allocation sanity failed: ${JSON.stringify(value)}`);
  }
  return value;
}

writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
for (const kind of kinds) for (let round = 0; round < rounds; round += 1) {
  const order = schedule[round];
  for (const runtimeId of order) {
    const measurement = run({ runtimeId, kind, count });
    result.measurements.push({ runtimeId, kind, round: round + 1, ...measurement });
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  }
  process.stderr.write(`${kind} round ${round + 1}/${rounds}\n`);
}
process.stdout.write(`Saved ${result.measurements.length} direct allocation diagnostics to ${resultPath.pathname}\n`);
