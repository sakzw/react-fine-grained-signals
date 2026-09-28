import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rounds = 8;
const warmups = 3;
const samples = 7;
const iterationsByCase = JSON.parse(readFileSync(new URL("../m1b-iterations.json", import.meta.url), "utf8"));
const schedule = [
  ["rfsg-v0.1.1", "m15-alien-derived", "rfsg-current", "alien-signals"],
  ["m15-alien-derived", "alien-signals", "rfsg-v0.1.1", "rfsg-current"],
  ["alien-signals", "rfsg-current", "m15-alien-derived", "rfsg-v0.1.1"],
  ["rfsg-current", "rfsg-v0.1.1", "alien-signals", "m15-alien-derived"],
];
const workerPath = fileURLToPath(new URL("./screen-worker.mjs", import.meta.url));
const cases = [
  { kind: "source-read", caseId: "source/read@1" },
  { kind: "source-write-read", caseId: "source/write-read@1" },
];
const results = [];

for (const { kind, caseId } of cases) {
  const iterations = iterationsByCase[caseId];
  if (!Number.isSafeInteger(iterations) || iterations <= 0) throw new Error(`Invalid frozen count for ${caseId}`);
  for (let round = 0; round < rounds; round += 1) {
    const order = schedule[round % schedule.length];
    const perRuntime = {};
    for (const runtimeId of order) {
      const child = spawnSync(process.execPath, ["--expose-gc", workerPath, JSON.stringify({ runtimeId, kind, iterations, warmups, samples })], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (child.status !== 0) throw new Error(`${runtimeId} ${caseId} round ${round + 1} failed: ${child.stderr || child.stdout}`);
      perRuntime[runtimeId] = JSON.parse(child.stdout);
    }
    results.push({ caseId, round: round + 1, order, perRuntime });
    process.stderr.write(`completed ${caseId} round ${round + 1}/${rounds}\n`);
  }
}

process.stdout.write(`${JSON.stringify({ purpose: "early_screening_only_not_authoritative_measurement", rounds, warmups, samples, results }, null, 2)}\n`);
