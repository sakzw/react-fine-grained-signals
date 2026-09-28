import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const iterations = JSON.parse(readFileSync(new URL("../m1b-iterations.json", import.meta.url), "utf8"))["rfsg/react-jsx-direct-binding@1"];
if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error("Missing frozen JSX binding iterations.");
const worker = fileURLToPath(new URL("../react-worker.mjs", import.meta.url));
const output = new URL("./react-jsx-diagnostic-results.json", import.meta.url);
const runtimes = ["rfsg-v0.1.1", "rfsg-current"];
const rounds = 8;
const results = [];
const save = () => writeFileSync(output, `${JSON.stringify({ purpose: "M1.5.1 supplementary JSX direct-binding check; production-vs-v0.1.1", iterations, rounds, warmups: 3, samples: 7, results }, null, 2)}\n`);
for (let round = 0; round < rounds; round += 1) {
  const order = round % 2 === 0 ? runtimes : runtimes.toReversed();
  const perRuntime = {};
  for (const runtimeId of order) {
    const proc = spawnSync(process.execPath, ["--expose-gc", worker, JSON.stringify({ runtimeId, kind: "jsx-binding", iterations, warmups: 3, samples: 7 })], { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 });
    if (proc.status !== 0) throw new Error(`${runtimeId} JSX round ${round + 1}: ${proc.error?.message ?? proc.stderr ?? proc.stdout}`);
    const response = JSON.parse(proc.stdout);
    if (response.status !== "ok" || response.preflight !== "passed") throw new Error(`JSX preflight failed: ${proc.stdout}`);
    perRuntime[runtimeId] = response.samples.map((sample) => sample.durationNs);
  }
  results.push({ round: round + 1, order, perRuntime });
  save();
  process.stderr.write(`jsx-binding round ${round + 1}/${rounds}\n`);
}
process.stdout.write(`Saved eight paired JSX rounds to ${output.pathname}\n`);
