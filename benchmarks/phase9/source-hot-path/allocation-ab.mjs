import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "../../..");
const worker = resolve(repoRoot, "benchmarks/phase9/allocation-worker.mjs");
const runtimes = ["rfsg-W0", "rfsg-current"];
const workloads = [
  "signal-computed-effect-graph",
  "one-source-many-effects",
  "deep-watched-leaves",
];
const results = [];

for (const kind of workloads) {
  for (const runtimeId of runtimes) {
    for (let round = 1; round <= 3; round += 1) {
      const child = spawnSync(process.execPath, ["--expose-gc", worker, JSON.stringify({ runtimeId, kind, count: 1_000 })], {
        cwd: repoRoot,
        encoding: "utf8",
        windowsHide: true,
      });
      if (child.error) throw child.error;
      if (child.status !== 0) throw new Error(`${runtimeId} ${kind} round ${round}: ${child.stderr}`);
      const result = JSON.parse(child.stdout);
      if (result.status !== "ok" || result.disposedEffectsStopped !== true) throw new Error(`Invalid allocation row: ${child.stdout}`);
      results.push({ round, ...result });
      process.stdout.write(`${runtimeId} ${kind} round ${round}: live=${result.liveDeltaBytes} retained=${result.retainedDeltaBytes}\n`);
    }
  }
}

process.stdout.write(`${JSON.stringify(results)}\n`);
