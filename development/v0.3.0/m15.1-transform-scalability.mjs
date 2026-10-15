import os from "node:os";
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import signals from "../../packages/unplugin-react-fine-grained-signals/dist/vite.js";

const sizes = (process.env.M151_SIZES ?? "0,5,20,100,500").split(",").map(Number);
const samples = Number.parseInt(process.env.M151_SAMPLES ?? "5", 10);
const warmups = Number.parseInt(process.env.M151_WARMUPS ?? "1", 10);

function fixture(count, dependent) {
  const lines = [
    'import { deepSignal } from "react-fine-grained-signals";',
    "const state = deepSignal({ child: { name: 'Ada' } });",
    "export function Profile() {",
  ];
  if (count === 0) {
    lines.push("  return <p>{state.value.child.name}</p>;");
  } else if (dependent) {
    lines.push("  const { child: value0 } = state.value;");
    for (let index = 1; index < count; index += 1) {
      lines.push(`  const { child: value${index} } = value${index - 1};`);
    }
    lines.push(`  return <p>{value${count - 1}.name}</p>;`);
  } else {
    for (let index = 0; index < count; index += 1) {
      lines.push(`  const { child: value${index} } = state.value;`);
    }
    lines.push(`  return <p>{${Array.from({ length: count }, (_, i) => `value${i}.name`).join(" + ")}}</p>;`);
  }
  lines.push("}");
  return lines.join("\n");
}

function createTransform() {
  const plugin = signals({ mode: "auto", transform: "managed" });
  const hook = typeof plugin.transform === "function" ? plugin.transform : plugin.transform?.handler;
  if (typeof hook !== "function") throw new Error("Vite transform hook was not found");
  return (source) => hook.call(plugin, source, "m15.1-benchmark.tsx");
}

function check(result, count, dependent) {
  if (result === null || typeof result?.code !== "string") throw new Error("fixture was not transformed");
  if (!result.code.includes("useSignalCapture")) throw new Error("managed capture hook is missing");
  const captures = result.code.match(/\.capture\(\(\)\s*=>/g)?.length ?? 0;
  const minimum = count === 0 ? 1 : dependent ? count + 1 : count * 2;
  if (captures < minimum) {
    throw new Error(`tracking output incomplete: ${captures} captures, expected at least ${minimum}`);
  }
  if (count > 0 && !result.code.includes(`value${count - 1}`)) throw new Error("terminal alias was lost");
  return captures;
}

const rows = [];
for (const dependent of [false, true]) {
  for (const count of sizes) {
    if (count === 0 && dependent) continue;
    const source = fixture(count, dependent);
    const transform = createTransform();
    let result = transform(source);
    const captures = check(result, count, dependent);
    for (let round = 0; round < warmups; round += 1) result = transform(source);

    const timings = [];
    let peakHeapDelta = 0;
    let retainedHeapDelta = 0;
    for (let sample = 0; sample < samples; sample += 1) {
      global.gc?.();
      const before = process.memoryUsage().heapUsed;
      const start = performance.now();
      result = transform(source);
      timings.push(performance.now() - start);
      peakHeapDelta = Math.max(peakHeapDelta, process.memoryUsage().heapUsed - before);
      check(result, count, dependent);
      global.gc?.();
      retainedHeapDelta = process.memoryUsage().heapUsed - before;
    }
    timings.sort((a, b) => a - b);
    rows.push({
      case: dependent ? "dependent-chain" : count === 0 ? "no-destructuring-control" : "independent",
      destructurings: count,
      medianMs: Number(timings[Math.floor(timings.length / 2)]?.toFixed(3)),
      minMs: Number(timings[0]?.toFixed(3)),
      maxMs: Number(timings.at(-1)?.toFixed(3)),
      outputBytes: Buffer.byteLength(result.code),
      captureCount: captures,
      peakHeapDeltaMiB: Number((peakHeapDelta / 1024 / 1024).toFixed(2)),
      retainedHeapDeltaMiB: Number((retainedHeapDelta / 1024 / 1024).toFixed(2)),
    });
    console.log(JSON.stringify(rows.at(-1)));
  }
}

const report = {
  date: new Date().toISOString(),
  node: process.version,
  platform: `${os.platform()} ${os.arch()}`,
  cpu: os.cpus()[0]?.model,
  warmups,
  samples,
  rows,
};
console.log(JSON.stringify(report, null, 2));
if (process.env.M151_OUTPUT) writeFileSync(process.env.M151_OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
