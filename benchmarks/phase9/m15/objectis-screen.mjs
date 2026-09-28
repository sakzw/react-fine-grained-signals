import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { commonCases } from "../config.mjs";

const warmups = 3;
const samples = 7;
const cases = ["source/write-read@1", "computed/equality-suppression@1"].map((caseId) => {
  const [id, sizeText] = caseId.split("@");
  const testCase = commonCases.find((item) => item.id === id);
  if (!testCase) throw new Error(`Unknown frozen workload ${id}`);
  return { id, caseId, kind: testCase.kind, size: Number(sizeText) };
});
const iterations = JSON.parse(readFileSync(new URL("../m1b-iterations.json", import.meta.url), "utf8"));
const worker = fileURLToPath(new URL("./objectis-screen-worker.mjs", import.meta.url));
const out = new URL("./objectis-screen-results.json", import.meta.url);
const orders = [
  ["inline", "objectis"], ["objectis", "inline"],
  ["inline", "objectis"], ["objectis", "inline"],
];
const results = [];
const preflights = [];

function run(payload) {
  const child = spawnSync(process.execPath, ["--expose-gc", worker, JSON.stringify(payload)], { encoding: "utf8", windowsHide: true });
  if (child.status !== 0) throw new Error(`${payload.variant} ${payload.caseId}: ${child.stderr || child.stdout}`);
  const parsed = JSON.parse(child.stdout);
  if (parsed.status !== "ok" || parsed.preflight !== "passed") throw new Error(JSON.stringify(parsed));
  return parsed;
}
for (const testCase of cases) {
  const { caseId } = testCase;
  const count = iterations[caseId];
  if (!Number.isSafeInteger(count) || count < 1) throw new Error(`Invalid frozen iterations for ${caseId}`);
  for (const variant of ["inline", "objectis"]) preflights.push(run({ ...testCase, iterations: count, variant, preflightOnly: true }));
}
writeFileSync(out, `${JSON.stringify({ purpose: "Object.is targeted paired screen only", rounds: 4, warmups, samples, frozenIterationsFile: "../m1b-iterations.json", cases: cases.map(({ caseId, kind, size }) => ({ caseId, kind, size })), preflights, results }, null, 2)}\n`);
for (const testCase of cases) {
  const { caseId } = testCase;
  const count = iterations[caseId];
  for (let round = 0; round < orders.length; round += 1) {
    const perVariant = {};
    for (const variant of orders[round]) perVariant[variant] = run({ ...testCase, iterations: count, variant, warmups, samples }).durationsNs;
    results.push({ caseId, iterations: count, round: round + 1, order: orders[round], perVariant });
    writeFileSync(out, `${JSON.stringify({ purpose: "Object.is targeted paired screen only", rounds: 4, warmups, samples, frozenIterationsFile: "../m1b-iterations.json", cases, preflights, results }, null, 2)}\n`);
    process.stderr.write(`completed ${caseId} round ${round + 1}/4\n`);
  }
}
process.stdout.write(`completed Object.is target screen: ${out.pathname}\n`);
