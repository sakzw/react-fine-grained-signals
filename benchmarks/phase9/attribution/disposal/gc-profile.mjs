import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [outputArg] = process.argv.slice(2);
if (!outputArg) throw new Error("usage: node gc-profile.mjs <output.json>");
const worker = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const workloadCounts = [
  ["effect/create", 85858],
  ["effect/dispose-only", 78528],
  ["effect/create-dispose", 78528],
];
const records = [];
for (const [workload, iterations] of workloadCounts) {
  for (const runtime of ["current", "v011"]) {
    const payload = JSON.stringify({ runtime, workload, iterations });
    const result = spawnSync(process.execPath, ["--expose-gc", "--trace-gc", worker, payload], {
      cwd: resolve(import.meta.dirname, "../../../.."),
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${runtime} ${workload}: ${result.stderr}`);
    const jsonStart = result.stdout.indexOf('{"runtime"');
    const samplesStart = result.stdout.indexOf('"samples":[', jsonStart);
    const jsonEnd = result.stdout.indexOf("]}", samplesStart);
    if (jsonStart < 0 || samplesStart < 0 || jsonEnd < 0) throw new Error(`${runtime} ${workload} did not emit its worker result`);
    const jsonText = result.stdout.slice(jsonStart, jsonEnd + 2);
    const parsed = JSON.parse(jsonText);
    if (parsed.status !== "ok" || parsed.preflight !== "passed") throw new Error(`${runtime} ${workload} failed preflight`);
    const gcLines = `${result.stdout.slice(0, jsonStart)}${result.stdout.slice(jsonEnd + 2)}\n${result.stderr}`.split(/\r?\n/).filter((line) => /\bScavenge\b|\bMark-Compact\b|\bMark-sweep\b/.test(line));
    const pauseMs = gcLines.map((line) => Number(line.match(/([\d.]+)\s*\/\s*[\d.]+\s*ms/)?.[1] ?? 0));
    records.push({
      runtime, workload, iterations,
      successfulTimedSamples: parsed.samples.length,
      medianSampleNs: parsed.samples.map((sample) => sample.durationNs).toSorted((a, b) => a - b)[3],
      gcCount: gcLines.length,
      gcPauseMs: pauseMs.reduce((sum, value) => sum + value, 0),
      gcLines,
    });
  }
}
const outputPath = resolve(outputArg);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify({ method: "single diagnostic fresh process; three warmups and seven samples; Node --trace-gc; timings are diagnostic only", node: process.version, records }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(records.map(({ runtime, workload, medianSampleNs, gcCount, gcPauseMs }) => ({ runtime, workload, medianSampleNs, gcCount, gcPauseMs })))}\n`);
