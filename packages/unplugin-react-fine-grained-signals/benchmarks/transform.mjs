import os from "node:os";
import { appendFileSync } from "node:fs";
import signals from "../dist/vite.js";

const argumentIterations = process.argv.slice(2).find((argument) => argument !== "--");
const iterations = Number.parseInt(argumentIterations ?? process.env.BENCH_ITERATIONS ?? "400", 10);
const largeIterations = Number.parseInt(
  process.env.BENCH_LARGE_ITERATIONS ?? String(Math.max(1, Math.floor(iterations / 20))),
  10,
);
const warmups = Number.parseInt(process.env.BENCH_WARMUPS ?? "3", 10);
const samples = Number.parseInt(process.env.BENCH_SAMPLES ?? "9", 10);
const managedHook = process.env.BENCH_MANAGED_HOOK ?? "useSignalCapture";
if (!Number.isSafeInteger(iterations) || iterations < 1) {
  throw new Error("BENCH_ITERATIONS must be a positive integer");
}
if (!Number.isSafeInteger(largeIterations) || largeIterations < 1) {
  throw new Error("BENCH_LARGE_ITERATIONS must be a positive integer");
}

const percentile = (values, ratio) => {
  const index = (values.length - 1) * ratio;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return values[low] + (values[high] - values[low]) * (index - low);
};

function reactiveSource(componentCount) {
  const declarations = [];
  const components = [];
  for (let index = 0; index < componentCount; index += 1) {
    declarations.push(`const source${index} = { value: ${index} };`);
    if (index % 5 === 0) {
      components.push(`export function useCounter${index}() { return source${index}.value; }`);
    } else if (index % 7 === 0) {
      components.push(`export const Counter${index} = memo(() => <p>{source${index}.value}</p>);`);
    } else if (index % 11 === 0) {
      components.push(
        `export const Counter${index} = forwardRef((props, ref) => <p ref={ref}>{source${index}.value}</p>);`,
      );
    } else {
      components.push(
        `export function Counter${index}({ label }: { label: string }) { return <p>{label}:{source${index}.value}</p>; }`,
      );
    }
  }
  return ['import { forwardRef, memo } from "react";', ...declarations, ...components].join("\n");
}

const smallReactive = reactiveSource(1);
const largeReactive = reactiveSource(120);
const smallNoCandidate = smallReactive.replaceAll(".value", ".current");
const largeNoCandidate = largeReactive.replaceAll(".value", ".current");

function createTransform(transformMode) {
  const plugin = signals({ mode: "auto", transform: transformMode });
  const transformHook = typeof plugin.transform === "function" ? plugin.transform : plugin.transform?.handler;
  if (typeof transformHook !== "function") {
    throw new Error("The built Vite adapter did not expose a transform hook");
  }
  return (source) => transformHook.call(plugin, source, "benchmark.tsx");
}

function transformedCase(name, source, transformMode, expected) {
  const runTransform = createTransform(transformMode);
  return {
    name,
    source,
    iterations: source === largeReactive || source === largeNoCandidate ? largeIterations : iterations,
    run() {
      return runTransform(source);
    },
    check(result) {
      if (!expected) {
        if (result !== null) throw new Error(`${name} unexpectedly transformed source`);
        return;
      }
      if (result === null) throw new Error(`${name} did not transform source`);
      if (
        !result.code.includes("useSignalTracking") &&
        !result.code.includes("useManagedSignals") &&
        !result.code.includes("useSignalCapture")
      ) {
        throw new Error(`${name} omitted the runtime hook`);
      }
      if (transformMode === "managed" && !result.code.includes(managedHook)) {
        throw new Error(`${name} omitted its managed capture hook`);
      }
    },
  };
}

const cases = [
  {
    name: "small/pass-through",
    source: smallReactive,
    iterations,
    run() {
      return smallReactive;
    },
    check(result) {
      if (result !== smallReactive) throw new Error("pass-through changed source");
    },
  },
  transformedCase("small/auto no-candidate", smallNoCandidate, "inject", false),
  transformedCase("small/auto inject", smallReactive, "inject", true),
  transformedCase("small/auto managed", smallReactive, "managed", true),
  {
    name: "large/pass-through",
    source: largeReactive,
    iterations: largeIterations,
    run() {
      return largeReactive;
    },
    check(result) {
      if (result !== largeReactive) throw new Error("pass-through changed source");
    },
  },
  transformedCase("large/auto no-candidate", largeNoCandidate, "inject", false),
  transformedCase("large/auto inject", largeReactive, "inject", true),
  transformedCase("large/auto managed", largeReactive, "managed", true),
];

function benchmark(definition) {
  const checked = definition.run();
  definition.check(checked);

  for (let round = 0; round < warmups; round += 1) {
    for (let index = 0; index < definition.iterations; index += 1) definition.run();
  }

  const timings = [];
  for (let sample = 0; sample < samples; sample += 1) {
    global.gc?.();
    const start = process.hrtime.bigint();
    for (let index = 0; index < definition.iterations; index += 1) definition.run();
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    timings.push(elapsed / definition.iterations);
  }
  timings.sort((left, right) => left - right);
  const median = percentile(timings, 0.5);
  return {
    case: definition.name,
    "median ms/module": median.toFixed(3),
    "modules/s": (1_000 / median).toLocaleString("en-US", { maximumFractionDigits: 0 }),
    "p25 ms": percentile(timings, 0.25).toFixed(3),
    "p75 ms": percentile(timings, 0.75).toFixed(3),
    outputBytes:
      typeof checked === "string"
        ? Buffer.byteLength(checked)
        : typeof checked?.code === "string"
          ? Buffer.byteLength(checked.code)
          : 0,
    rawMsPerModule: timings,
  };
}

console.log(`Node ${process.version}; ${iterations} small and ${largeIterations} large modules per sample`);
console.log(`${os.platform()} ${os.arch()}; ${os.cpus()[0]?.model ?? "unknown CPU"}`);
console.log("Manual diagnostics only: compare results only on identical Node versions and hardware.");
console.log("Pass-through is a lower bound; no-candidate includes Babel parse/traverse/generate without a rewrite.");
const results = cases.map(benchmark);
console.table(results);
if (process.env.BENCH_OUTPUT) {
  const metadata = {
    kind: "transform-sample",
    date: process.env.BENCH_DATE ?? new Date().toISOString().slice(0, 10),
    commit: process.env.BENCH_COMMIT ?? "working-tree",
    workingTree: process.env.BENCH_WORKING_TREE ?? undefined,
    round: Number.parseInt(process.env.BENCH_ROUND ?? "0", 10),
    order: process.env.BENCH_ORDER ?? "",
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model,
    iterations,
    largeIterations,
    warmups,
    samples,
    managedHook,
  };
  for (const result of results)
    appendFileSync(process.env.BENCH_OUTPUT, `${JSON.stringify({ ...metadata, ...result })}\n`);
}
