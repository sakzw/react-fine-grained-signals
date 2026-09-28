import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const frozen = JSON.parse(readFileSync(new URL("../m1b-iterations.json", import.meta.url), "utf8"));
const cases = [
  ["rfsg/react-useSignalValue@1", "useSignalValue"],
  ["rfsg/react-managed-tracking@1", "managed"],
  ["rfsg/react-bare-tracking@1", "bare"],
  ["rfsg/react-jsx-direct-binding@1", "jsx-binding"],
].map(([caseId, kind]) => ({ caseId, kind, iterations: frozen[caseId] }));
for (const item of cases) if (!Number.isSafeInteger(item.iterations) || item.iterations < 1) throw new Error(`Missing frozen iterations for ${item.caseId}`);
const worker = fileURLToPath(new URL("../react-worker.mjs", import.meta.url));
const output = new URL("./react-production-shapes-results.json", import.meta.url);
const runtimes = ["rfsg-v0.1.1", "rfsg-current"];
const rounds = 8;
const results = [];
const save = () => writeFileSync(output, `${JSON.stringify({ purpose: "M1.5.1 supplementary React shape diagnostic; production vs v0.1.1", rounds, warmups: 3, samples: 7, frozenIterationsFile: "../m1b-iterations.json", cases, results }, null, 2)}\n`);
for (const item of cases) for (let round = 0; round < rounds; round += 1) {
  const order = round % 2 === 0 ? runtimes : runtimes.toReversed();
  const perRuntime = {};
  for (const runtimeId of order) {
    const proc = spawnSync(process.execPath, ["--expose-gc", worker, JSON.stringify({ ...item, runtimeId, warmups: 3, samples: 7 })], { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 });
    if (proc.status !== 0) throw new Error(`${runtimeId} ${item.caseId}: ${proc.error?.message ?? proc.stderr ?? proc.stdout}`);
    const response = JSON.parse(proc.stdout);
    if (response.status !== "ok" || response.preflight !== "passed") throw new Error(`Preflight failed: ${proc.stdout}`);
    perRuntime[runtimeId] = response.samples.map((sample) => sample.durationNs);
  }
  results.push({ ...item, round: round + 1, order, perRuntime });
  save();
  process.stderr.write(`${item.caseId} round ${round + 1}/${rounds}\n`);
}
process.stdout.write(`Saved ${results.length} paired React shape rounds to ${output.pathname}\n`);
