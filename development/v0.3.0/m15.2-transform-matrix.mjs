import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), "m15.1-transform-scalability.mjs");
const baselinePlugin = process.env.M152_BASELINE_PLUGIN;
const candidatePlugin = process.env.M152_CANDIDATE_PLUGIN;
if (!baselinePlugin || !candidatePlugin) {
  throw new Error("Set M152_BASELINE_PLUGIN and M152_CANDIDATE_PLUGIN to built dist/vite.js file URLs.");
}

const rounds = Number.parseInt(process.env.M152_ROUNDS ?? "3", 10);
const sizes = (process.env.M152_MATRIX_SIZES ?? "0,5,20,100,500").split(",").map(Number);
const kinds = (process.env.M152_MATRIX_KINDS ?? "independent,chain,nested").split(",");
const variants = (process.env.M152_MATRIX_VARIANTS ?? "baseline,candidate").split(",");
const timeoutMs = Number.parseInt(process.env.M152_TIMEOUT_MS ?? "60000", 10);
const cases = process.env.M152_MATRIX_INCLUDE_NONE === "false" ? [] : [{ kind: "none", count: 0 }];
for (const count of sizes.filter((size) => size > 0)) {
  for (const kind of kinds) cases.push({ kind, count });
}
const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "rfsg-m152-matrix-"));
const measurements = [];

function runOne(round, variant, testCase) {
  const outputPath = path.join(temporaryDirectory, `${round}-${variant}-${testCase.kind}-${testCase.count}.json`);
  const environment = {
    ...process.env,
    M152_PLUGIN_PATH: variant === "baseline" ? baselinePlugin : candidatePlugin,
    M152_SIZES: String(testCase.count),
    M152_CASE: testCase.kind,
    M152_COUNT: String(testCase.count),
    M152_EXPECT_DEEP_UPDATE: variant === "baseline" && testCase.kind === "nested" ? "false" : "true",
    M152_SAMPLES: "1",
    M152_WARMUPS: "0",
    M152_OUTPUT: outputPath,
  };
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const result = spawnSync(process.execPath, ["--expose-gc", worker], {
    cwd: repoRoot,
    env: environment,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const elapsedMs = performance.now() - started;
  let measurement;
  if (result.error?.code === "ETIMEDOUT") {
    measurement = { round, variant, ...testCase, status: "timeout", timeoutMs, elapsedMs: Number(elapsedMs.toFixed(1)) };
  } else if (result.status !== 0) {
    measurement = {
      round,
      variant,
      ...testCase,
      status: "failed",
      exitCode: result.status,
      error: result.error?.message,
      stderrTail: result.stderr?.slice(-4000),
      stdoutTail: result.stdout?.slice(-4000),
    };
  } else {
    const report = JSON.parse(readFileSync(outputPath, "utf8"));
    measurement = {
      round,
      variant,
      startedAt,
      processElapsedMs: Number(elapsedMs.toFixed(1)),
      ...report.rows[0],
      status: "ok",
    };
  }
  measurements.push(measurement);
  console.log(JSON.stringify(measurement));
  if (process.env.M152_MATRIX_OUTPUT) {
    mkdirSync(path.dirname(path.resolve(process.env.M152_MATRIX_OUTPUT)), { recursive: true });
    writeFileSync(process.env.M152_MATRIX_OUTPUT, `${JSON.stringify({ rounds, timeoutMs, measurements }, null, 2)}\n`);
  }
  return measurement;
}

try {
  for (let round = 1; round <= rounds; round += 1) {
    const variantOrder = variants.length === 1
      ? variants
      : round % 2 === 1 ? variants : [...variants].reverse();
    for (const testCase of cases) {
      for (const variant of variantOrder) runOne(round, variant, testCase);
    }
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

const report = {
  date: new Date().toISOString(),
  node: process.version,
  platform: `${os.platform()} ${os.arch()}`,
  cpu: os.cpus()[0]?.model,
  rounds,
  samplesPerProcess: 1,
  warmupsPerProcess: 0,
  timeoutMs,
  order: "baseline/candidate alternated by round; each measurement starts a fresh Node process",
  baselinePlugin,
  candidatePlugin,
  measurements,
};
console.log(JSON.stringify(report, null, 2));
if (process.env.M152_MATRIX_OUTPUT) {
  mkdirSync(path.dirname(path.resolve(process.env.M152_MATRIX_OUTPUT)), { recursive: true });
  writeFileSync(process.env.M152_MATRIX_OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
}
