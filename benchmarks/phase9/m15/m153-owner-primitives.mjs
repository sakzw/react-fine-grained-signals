import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";

const rounds = 24;
const warmups = 3;
const samples = 7;
const iterations = 250_000;
const context = { owner: undefined, frames: [] };
const owner = { kind: "graph" };
let observed = 0;
function directScope(callback) {
  const previous = context.owner;
  context.owner = owner;
  try { return callback(); }
  finally { context.owner = previous; }
}
function framedScope(callback) {
  const frame = { owner, active: true };
  context.frames.push(frame);
  context.owner = owner;
  let active = true;
  try { return callback(); }
  finally {
    if (active) {
      active = false;
      frame.active = false;
      while (context.frames.at(-1)?.active === false) context.frames.pop();
      context.owner = context.frames.at(-1)?.owner;
    }
  }
}
function run(scope, timed) {
  let count = 0;
  const callback = () => { if (context.owner === owner) count += 1; };
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) scope(callback);
  const durationNs = Math.round((performance.now() - started) * 1e6);
  if (count !== iterations) throw new Error(`Owner scope ran ${count}/${iterations} callbacks.`);
  observed += count;
  return timed ? durationNs : 0;
}
for (let index = 0; index < warmups; index += 1) { run(directScope, false); run(framedScope, false); }
const measurements = [];
for (let round = 0; round < rounds; round += 1) {
  const order = round % 2 === 0 ? ["direct", "framed"] : ["framed", "direct"];
  const perMode = {};
  for (const mode of order) {
    const scope = mode === "direct" ? directScope : framedScope;
    perMode[mode] = Array.from({ length: samples }, () => run(scope, true));
  }
  measurements.push({ round: round + 1, order, perMode });
}
const output = {
  purpose: "Isolated synchronous owner primitive diagnostic; compares direct save/restore with frame push/restore, not full graph throughput",
  rounds, warmups, samples, iterationsPerSample: iterations,
  checks: { allCallbacksObserved: true, finalOwnerRestored: context.owner === undefined, frameDepth: context.frames.length, observedCallbacks: observed },
  measurements,
};
writeFileSync(new URL("./results/m153-owner-primitives.json", import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
process.stdout.write(`Saved ${rounds} paired owner primitive rounds.\n`);
