import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { commonCases } from "../config.mjs";
import { fileURLToPath } from "node:url";

const schedule = [
  ["rfsg-m153", "m154-c3", "rfsg-v0.1.1"],
  ["m154-c3", "rfsg-v0.1.1", "rfsg-m153"],
  ["rfsg-v0.1.1", "rfsg-m153", "m154-c3"],
  ["rfsg-m153", "rfsg-v0.1.1", "m154-c3"],
  ["rfsg-v0.1.1", "m154-c3", "rfsg-m153"],
  ["m154-c3", "rfsg-m153", "rfsg-v0.1.1"],
];
const definitions = [
  ["source/create", 24], ["source/read", 24],
  ["source/unobserved-write", 18], ["source/write-read", 18],
  ["computed/create", 18], ["effect/create", 18],
  ["computed/dirty-read", 12], ["computed/equality-suppression", 12],
  ["effect/observed-write", 12], ["effect/fanout", 12, 16],
  ["effect/fanout", 12, 64], ["batch/two-writes-one-reaction", 12],
];
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
const resultPath = new URL("./results/m154-m153-direct-results.json", import.meta.url);

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
function runtimeIdentity(directory, commit) {
  const files = readdirSync(directory).filter((name) => name.endsWith(".js")).toSorted();
  if (!files.includes("index.js") || !files.some((name) => /^core-runtime-.*\.js$/.test(name))) {
    throw new Error(`Expected index.js and a core runtime bundle in ${directory}`);
  }
  const artifacts = files.map((name) => ({ name, sha256: createHash("sha256").update(readFileSync(join(directory, name))).digest("hex") }));
  const hashInput = JSON.stringify(artifacts);
  return {
    commit,
    artifactDirectory: relative(projectRoot, directory).replaceAll("\\", "/"),
    artifactSha256: createHash("sha256").update(hashInput).digest("hex"),
    files: artifacts,
  };
}

const baselineCommit = "53ea18007b1934dc51902b6447551b1e237a2545";
const baselineDist = fileURLToPath(new URL("./baselines/m153-53ea/dist/", import.meta.url));
const currentDist = fileURLToPath(new URL("../../../dist/", import.meta.url));
const baselineManifest = JSON.parse(readFileSync(new URL("./baselines/m153-53ea/identity.json", import.meta.url), "utf8"));
if (baselineManifest.sourceCommit !== baselineCommit) throw new Error("Frozen M1.5.3 artifact commit identity is incorrect.");
const runtimeIdentities = {
  "rfsg-m153": runtimeIdentity(baselineDist, baselineCommit),
  "m154-c3": runtimeIdentity(currentDist, process.env.M154_GIT_HEAD ?? "uncommitted candidate from current HEAD"),
};
if (runtimeIdentities["rfsg-m153"].artifactSha256 !== baselineManifest.artifactSha256) {
  throw new Error("Frozen M1.5.3 artifact hash does not match its checked-in identity manifest.");
}
const result = {
  purpose: "M1.5.4 direct C3 vs frozen M1.5.3 paired duration diagnostic; not the authoritative release matrix",
  gitHead: process.env.M154_GIT_HEAD ?? "not-provided",
  worktreeStatusAtStart: process.env.M154_START_STATUS ?? "not-provided",
  node: process.version,
  roundsPolicy: "24 source/create and source/read; 18 source/write and creation diagnostics; 12 computed/effect/batch regression controls; three-runtime six-round balanced schedule",
  warmups: 3,
  samples: 7,
  frozenIterationsFile: "../m1b-iterations.json",
  frozenIterationsSha256: createHash("sha256").update(iterationsBytes).digest("hex"),
  runtimes: ["rfsg-m153", "m154-c3", "rfsg-v0.1.1"],
  runtimeIdentities,
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
if (process.env.M154_PREFLIGHT_ONLY === "1") {
  process.stdout.write(`${JSON.stringify({ runtimeIdentities, preflightCases: cases.map(({ caseId, iterations }) => ({ caseId, iterations })), status: "passed" }, null, 2)}\n`);
  process.exit(0);
}
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
