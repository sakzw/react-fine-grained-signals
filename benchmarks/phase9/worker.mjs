import { performance } from "node:perf_hooks";
import { loadAdapter } from "./adapters.mjs";
import { createWorkload } from "./workloads.mjs";

const payload = JSON.parse(process.argv[2] ?? "{}");
const { runtimeId, kind, iterations, size, warmups, samples } = payload;
if (!runtimeId || !kind || !Number.isSafeInteger(iterations) || iterations < 1) {
  throw new Error("Worker needs runtimeId, kind, and a positive iterations count.");
}
const writeJson = (value) => new Promise((resolve, reject) => {
  process.stdout.write(JSON.stringify(value), (error) => error ? reject(error) : resolve());
});

const api = await loadAdapter(runtimeId);
if (kind === "batch-two-writes" && !api.supportsBatch) {
  await writeJson({ status: "na", reason: "Vue reactivity has no public multi-write transaction API." });
  process.exit(0);
}

if (kind === "adapter-read-diagnostic") {
  const source = api.signal(7);
  const expected = iterations * 7;
  const verify = () => {
    if (api.directReadLoop(source, iterations) !== expected) throw new Error("direct read diagnostic produced a wrong sum");
    if (api.adapterReadLoop(source, iterations) !== expected) throw new Error("adapter read diagnostic produced a wrong sum");
  };
  try {
    verify();
    for (let index = 0; index < warmups; index += 1) {
      api.directReadLoop(source, iterations);
      api.adapterReadLoop(source, iterations);
    }
    const results = [];
    for (let sample = 0; sample < samples; sample += 1) {
      global.gc?.();
      let startedAt = performance.now();
      api.directReadLoop(source, iterations);
      const directDurationNs = Math.round((performance.now() - startedAt) * 1e6);
      global.gc?.();
      startedAt = performance.now();
      api.adapterReadLoop(source, iterations);
      const adapterDurationNs = Math.round((performance.now() - startedAt) * 1e6);
      verify();
      results.push({ sample, directDurationNs, adapterDurationNs });
    }
    await writeJson({ status: "ok", preflight: "passed", gcExposed: typeof global.gc === "function", samples: results });
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}

async function execute(iterationCount, timed) {
  const workload = createWorkload(kind, api, iterationCount, size);
  if (workload.notApplicable) return { status: "na", reason: workload.notApplicable };
  const state = workload.setup();
  try {
    if (timed) {
      const startedAt = performance.now();
      workload.run(state);
      const durationNs = Math.round((performance.now() - startedAt) * 1e6);
      workload.verify(state);
      return { durationNs };
    }
    workload.run(state);
    workload.verify(state);
    return { status: "ok" };
  } finally {
    workload.dispose?.(state);
  }
}

try {
  const preflight = await execute(Math.min(iterations, 4), false);
  if (preflight.status === "na") {
    process.stdout.write(JSON.stringify(preflight));
    process.exit(0);
  }
  for (let index = 0; index < warmups; index += 1) {
    global.gc?.();
    await execute(iterations, false);
  }
  const results = [];
  for (let sample = 0; sample < samples; sample += 1) {
    global.gc?.();
    const result = await execute(iterations, true);
    results.push({ sample, durationNs: result.durationNs });
  }
  process.stdout.write(JSON.stringify({ status: "ok", preflight: "passed", gcExposed: typeof global.gc === "function", samples: results }));
} catch (error) {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
}
