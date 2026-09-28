import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { commonCases } from "../config.mjs";
const cases = ["computed/dirty-read@1", "computed/equality-suppression@1", "effect/observed-write@1"].map((caseId) => {
  const [id, sizeText] = caseId.split("@");
  const item = commonCases.find((entry) => entry.id === id);
  return { id, caseId, kind: item.kind, size: Number(sizeText) };
});
const counts = JSON.parse(readFileSync(new URL("../m1b-iterations.json", import.meta.url), "utf8"));
const variants = ["brand-only", "core-errors"];
const rounds = 4, warmups = 3, samples = 7;
const orders = [["brand-only", "core-errors"], ["core-errors", "brand-only"], ["brand-only", "core-errors"], ["core-errors", "brand-only"]];
const worker = fileURLToPath(new URL("./core-candidate-worker.mjs", import.meta.url));
const out = new URL("./core-candidate-results.json", import.meta.url);
const preflights = [], results = [];
function run(payload) {
  const child = spawnSync(process.execPath, ["--expose-gc", worker, JSON.stringify(payload)], { encoding: "utf8", windowsHide: true });
  if (child.status !== 0) throw new Error(`${payload.variant} ${payload.caseId}: ${child.stderr || child.stdout}`);
  const result = JSON.parse(child.stdout);
  if (result.status !== "ok" || result.preflight !== "passed") throw new Error(JSON.stringify(result));
  return result;
}
for (const item of cases) {
  item.iterations = counts[item.caseId];
  for (const variant of variants) preflights.push(run({ ...item, variant, preflightOnly: true }));
}
function checkpoint() { writeFileSync(out, `${JSON.stringify({ purpose: "M1.5 Core Candidate computed-error delta screen", rounds, warmups, samples, frozenIterationsFile: "../m1b-iterations.json", cases, orders, preflights, results }, null, 2)}\n`); }
checkpoint();
for (const item of cases) for (let round = 0; round < rounds; round += 1) {
  const perVariant = {};
  for (const variant of orders[round]) perVariant[variant] = run({ ...item, variant, warmups, samples }).durationsNs;
  results.push({ ...item, round: round + 1, order: orders[round], perVariant });
  checkpoint();
  process.stderr.write(`completed ${item.caseId} round ${round + 1}/4\n`);
}
process.stdout.write(`completed Core Candidate error screen: ${out.pathname}\n`);
