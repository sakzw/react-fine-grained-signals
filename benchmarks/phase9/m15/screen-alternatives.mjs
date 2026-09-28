import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rounds = 8;
const warmups = 3;
const samples = 7;
const iterationsByCase = JSON.parse(readFileSync(new URL("../m1b-iterations.json", import.meta.url), "utf8"));
const baseOrder = [
  "rfsg-v0.1.1",
  "m15-helper-object",
  "m15-class-helper",
  "m15-class-inline",
  "m15-bound",
  "m15-bundle-class-helper",
  "m15-bundle-class-inline",
  "m15-bundle-bound",
  "rfsg-current",
  "alien-signals",
];
const rotate = (items, count) => [...items.slice(count), ...items.slice(0, count)];
const schedule = [0, 1, 2, 3].flatMap((rotation) => {
  const order = rotate(baseOrder, rotation);
  return [order, [...order].reverse()];
});
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
    const order = schedule[round];
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
process.stdout.write(`${JSON.stringify({ purpose: "early_structure_screening_only", rounds, warmups, samples, orderBalance: "Each round is paired with its reverse; all pairwise before/after counts balance.", results }, null, 2)}\n`);
