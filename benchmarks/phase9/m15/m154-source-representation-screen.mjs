import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { commonCases } from "../config.mjs";
import { fileURLToPath } from "node:url";

const schedule = [
  ["rfsg-current", "m151-integrated", "rfsg-pre-m15", "rfsg-v0.1.1"],
  ["m151-integrated", "rfsg-v0.1.1", "rfsg-current", "rfsg-pre-m15"],
  ["rfsg-v0.1.1", "rfsg-pre-m15", "m151-integrated", "rfsg-current"],
  ["rfsg-pre-m15", "rfsg-current", "rfsg-v0.1.1", "m151-integrated"],
];
const fullDefinitions = [
  ["source/create", 24], ["source/read", 24],
  ["source/unobserved-write", 12], ["source/write-read", 12],
  ["computed/create", 12], ["effect/create", 12],
  ["computed/dirty-read", 8], ["computed/equality-suppression", 8],
  ["effect/observed-write", 8], ["effect/fanout", 8, 16],
  ["effect/fanout", 8, 64], ["batch/two-writes-one-reaction", 8],
];
const focused = process.env.M154_FOCUSED === "1";
const definitions = focused ? [
  ["source/create", 24], ["source/read", 24],
  ["computed/dirty-read", 8], ["effect/observed-write", 8],
] : fullDefinitions;
const iterationsBytes = readFileSync(new URL("../m1b-iterations.json", import.meta.url));
const frozenIterations = JSON.parse(iterationsBytes.toString("utf8"));
const cases = definitions.map(([id, rounds, size = 1]) => {
  const caseId = `${id}@${size}`;
  const definition = commonCases.find((item) => item.id === id);
  const iterations = frozenIterations[caseId];
  if (definition === undefined || !Number.isSafeInteger(iterations) || iterations < 1) throw new Error(`Missing frozen case ${caseId}`);
  return { id, caseId, kind: definition.kind, size, iterations, rounds };
});
const workerPath = fileURLToPath(new URL("./owner-diagnostic-worker.mjs", import.meta.url));
const candidateName = focused ? "m154-source-fastpath-candidate" : "m154-symbol-protocol-candidate";
const resultPath = new URL(`./results/${candidateName}-results.json`, import.meta.url);
const result = {
  purpose: `M1.5.4 ${focused ? "focused source-only owner-free fastpath" : "source representation"} diagnostic; fresh-process paired durations, not an authoritative release matrix`,
  gitHead: process.env.M154_GIT_HEAD ?? "not-provided",
  worktreeStatusAtStart: process.env.M154_START_STATUS ?? "not-provided",
  node: process.version,
  roundsPolicy: "24 source/create and source/read; 12 source/write and creation diagnostics; 8 regression controls",
  warmups: 3,
  samples: 7,
  frozenIterationsFile: "../m1b-iterations.json",
  frozenIterationsSha256: createHash("sha256").update(iterationsBytes).digest("hex"),
  runtimes: ["rfsg-current", "m151-integrated", "rfsg-v0.1.1", "rfsg-pre-m15"],
  schedule,
  cases,
  measurements: [],
};

function run(payload) {
  const proc = spawnSync(process.execPath, ["--expose-gc", workerPath, JSON.stringify(payload)], {
    encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024,
  });
  if (proc.status !== 0) throw new Error(`${payload.runtimeId} ${payload.caseId}: ${proc.error?.message ?? proc.stderr ?? proc.stdout ?? `exit ${proc.status}`}`);
  const value = JSON.parse(proc.stdout);
  if (value.status !== "ok" || value.preflight !== "passed") throw new Error(`Preflight failed: ${JSON.stringify(value)}`);
  return value;
}

for (const item of cases) for (const runtimeId of result.runtimes) run({ ...item, runtimeId, preflightOnly: true });
writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
for (const item of cases) {
  for (let round = 0; round < item.rounds; round += 1) {
    const order = schedule[round % schedule.length];
    const perRuntime = {};
    for (const runtimeId of order) perRuntime[runtimeId] = run({ ...item, runtimeId, warmups: result.warmups, samples: result.samples }).durationsNs;
    result.measurements.push({ ...item, round: round + 1, order: [...order], perRuntime });
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`${item.caseId} round ${round + 1}/${item.rounds}\n`);
  }
}
process.stdout.write(`Saved ${result.measurements.length} paired diagnostic rounds to ${resultPath.pathname}\n`);
