import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { commonCases } from "../config.mjs";
const rounds = 4, warmups = 3, samples = 7;
const targetIds = ["source/create@1", "source/read@1"];
const iterationsFile = JSON.parse(readFileSync(new URL("../m1b-iterations.json", import.meta.url), "utf8"));
const cases = targetIds.map((caseId) => {
  const [id, sizeText] = caseId.split("@");
  const definition = commonCases.find((item) => item.id === id);
  return { id, caseId, kind: definition.kind, size: Number(sizeText), iterations: iterationsFile[caseId] };
});
const runtimes = ["bare", "weakset-brand", "helper-brand", "direct-brand"];
const orders = [
  ["bare", "weakset-brand", "helper-brand", "direct-brand"],
  ["weakset-brand", "direct-brand", "bare", "helper-brand"],
  ["helper-brand", "direct-brand", "weakset-brand", "bare"],
  ["direct-brand", "bare", "helper-brand", "weakset-brand"],
];
const worker = fileURLToPath(new URL("./brand-candidates-worker.mjs", import.meta.url));
const out = new URL("./brand-candidates-results.json", import.meta.url);
const preflights = [], results = [];
function run(payload) {
  const child = spawnSync(process.execPath, ["--expose-gc", worker, JSON.stringify(payload)], { encoding: "utf8", windowsHide: true });
  if (child.status !== 0) throw new Error(`${payload.runtimeId} ${payload.caseId}: ${child.stderr || child.stdout}`);
  const value = JSON.parse(child.stdout);
  if (value.status !== "ok" || value.preflight !== "passed") throw new Error(JSON.stringify(value));
  return value;
}
for (const testCase of cases) for (const runtimeId of runtimes) {
  const result = run({ ...testCase, runtimeId, preflightOnly: true });
  preflights.push({ caseId: testCase.caseId, runtimeId, ...result });
}
function checkpoint() {
  writeFileSync(out, `${JSON.stringify({ purpose: "single-object public brand candidate differential", rounds, warmups, samples, cases: cases.map(({ id, caseId, kind, size, iterations }) => ({ id, caseId, kind, size, iterations })), orders, preflights, results }, null, 2)}\n`);
}
checkpoint();
for (const testCase of cases) for (let round = 0; round < rounds; round += 1) {
  const perRuntime = {};
  for (const runtimeId of orders[round]) perRuntime[runtimeId] = run({ ...testCase, runtimeId, warmups, samples }).durationsNs;
  results.push({ ...testCase, round: round + 1, order: orders[round], perRuntime });
  checkpoint();
  process.stderr.write(`completed ${testCase.caseId} round ${round + 1}/${rounds}\n`);
}
process.stdout.write(`completed ${cases.length} workload shapes; raw ${out.pathname}\n`);
