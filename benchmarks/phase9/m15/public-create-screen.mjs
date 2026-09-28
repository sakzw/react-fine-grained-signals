import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const caseId = "source/create@1";
const testCase = { id: "source/create", caseId, kind: "source-create", size: 1 };
const iterations = JSON.parse(readFileSync(new URL("../m1b-iterations.json", import.meta.url), "utf8"))[caseId];
if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error(`Invalid frozen iterations for ${caseId}`);
const worker = fileURLToPath(new URL("./public-create-worker.mjs", import.meta.url));
const out = new URL("./public-create-results.json", import.meta.url);
const orders = [["bare", "public"], ["public", "bare"], ["bare", "public"], ["public", "bare"]];
const results = [];
function run(variant, warmups, samples, preflightOnly = false) {
  const child = spawnSync(process.execPath, ["--expose-gc", worker, JSON.stringify({ ...testCase, iterations, variant, warmups, samples, preflightOnly })], { encoding: "utf8", windowsHide: true });
  if (child.status !== 0) throw new Error(`${variant}: ${child.stderr || child.stdout}`);
  const parsed = JSON.parse(child.stdout);
  if (parsed.status !== "ok" || parsed.preflight !== "passed") throw new Error(JSON.stringify(parsed));
  return parsed;
}
const preflights = [run("bare", 0, 0, true), run("public", 0, 0, true)];
writeFileSync(out, `${JSON.stringify({ purpose: "public-wrapper-and-brand source/create differential", caseId, iterations, rounds: 4, warmups: 3, samples: 7, preflights, results }, null, 2)}\n`);
for (let round = 0; round < orders.length; round += 1) {
  const perVariant = {};
  for (const variant of orders[round]) perVariant[variant] = run(variant, 3, 7).durationsNs;
  results.push({ ...testCase, iterations, round: round + 1, order: orders[round], perVariant });
  writeFileSync(out, `${JSON.stringify({ purpose: "public-wrapper-and-brand source/create differential", caseId, iterations, rounds: 4, warmups: 3, samples: 7, preflights, results }, null, 2)}\n`);
  process.stderr.write(`completed public-create round ${round + 1}/4\n`);
}
process.stdout.write(`saved ${out.pathname}\n`);
