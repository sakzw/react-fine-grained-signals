import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { commonCases, allocationWorkloadIds } from "../config.mjs";
import { fileURLToPath } from "node:url";

const rounds = 4;
const warmups = 3;
const samples = 7;
const iterationCounts = JSON.parse(readFileSync(new URL("../m1b-iterations.json", import.meta.url), "utf8"));
const runtimeIds = ["rfsg-v0.1.1", "m15-inline-class", "rfsg-current", "alien-signals"];
const roundOrder = [
  ["rfsg-v0.1.1", "m15-inline-class", "rfsg-current", "alien-signals"],
  ["m15-inline-class", "alien-signals", "rfsg-v0.1.1", "rfsg-current"],
  ["alien-signals", "rfsg-current", "m15-inline-class", "rfsg-v0.1.1"],
  ["rfsg-current", "rfsg-v0.1.1", "alien-signals", "m15-inline-class"],
];
const excludedIds = new Set(allocationWorkloadIds);
const selectedCases = commonCases
  .filter((testCase) => !excludedIds.has(testCase.id) && !testCase.react && !testCase.id.startsWith("rfsg/") && !testCase.id.startsWith("diagnostic/"))
  .flatMap((testCase) => (testCase.sizes ?? [1]).map((size) => {
    const caseId = `${testCase.id}@${size}`;
    const iterations = iterationCounts[caseId];
    if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error(`Missing frozen iterations for ${caseId}`);
    return { id: testCase.id, caseId, kind: testCase.kind, size, iterations };
  }));
const workerPath = fileURLToPath(new URL("./core-screen-worker.mjs", import.meta.url));
const resultPath = new URL("./core-screen-results.json", import.meta.url);
const results = [];
const preflights = [];

function runWorker(payload) {
  const result = spawnSync(process.execPath, ["--expose-gc", workerPath, JSON.stringify(payload)], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`${payload.runtimeId} ${payload.caseId} failed: ${result.stderr || result.stdout}`);
  const parsed = JSON.parse(result.stdout);
  if (parsed.status === "na" && parsed.preflight === "not_applicable") return parsed;
  if (parsed.status !== "ok" || parsed.preflight !== "passed") throw new Error(`${payload.runtimeId} ${payload.caseId} returned ${JSON.stringify(parsed)}`);
  return parsed;
}

// Gate every selected common workload/runtime combination before timing any.
for (const testCase of selectedCases) {
  for (const runtimeId of runtimeIds) {
    const result = runWorker({ ...testCase, runtimeId, preflightOnly: true });
    preflights.push({ caseId: testCase.caseId, runtimeId, ...result });
  }
}
writeFileSync(resultPath, `${JSON.stringify({ purpose: "early-core-screen-only", rounds, warmups, samples, frozenIterationsFile: "../m1b-iterations.json", preflights, results }, null, 2)}\n`);

for (const testCase of selectedCases) {
  for (let round = 0; round < rounds; round += 1) {
    const order = roundOrder[round % roundOrder.length];
    const perRuntime = {};
    for (const runtimeId of order) {
      const result = runWorker({ ...testCase, runtimeId, warmups, samples });
      perRuntime[runtimeId] = result.status === "na" ? { status: "na", reason: result.reason } : result.durationsNs;
    }
    results.push({ ...testCase, round: round + 1, order, perRuntime });
    writeFileSync(resultPath, `${JSON.stringify({ purpose: "early-core-screen-only", rounds, warmups, samples, frozenIterationsFile: "../m1b-iterations.json", preflights, results }, null, 2)}\n`);
    process.stderr.write(`completed ${testCase.caseId} round ${round + 1}/${rounds}\n`);
  }
}
process.stdout.write(`completed ${selectedCases.length} case/size workloads across ${runtimeIds.length} runtimes; raw records: ${resultPath.pathname}\n`);
