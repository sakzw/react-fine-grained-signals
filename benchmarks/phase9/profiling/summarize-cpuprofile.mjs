import { readFile } from "node:fs/promises";

const path = process.argv[2];
if (path === undefined) throw new Error("usage: node summarize-cpuprofile.mjs <profile.cpuprofile>");
const limit = Number(process.argv[3] ?? 20);
const profile = JSON.parse(await readFile(path, "utf8"));
const byId = new Map(profile.nodes.map((node) => [node.id, node]));
const parentOf = new Map();
for (const node of profile.nodes) {
  for (const childId of node.children ?? []) parentOf.set(childId, node.id);
}

const inclusiveMicros = new Map();
const selfMicros = new Map();
const selfSamples = new Map();
for (let index = 0; index < profile.samples.length; index += 1) {
  const leafId = profile.samples[index];
  const delta = profile.timeDeltas?.[index] ?? 0;
  selfMicros.set(leafId, (selfMicros.get(leafId) ?? 0) + delta);
  selfSamples.set(leafId, (selfSamples.get(leafId) ?? 0) + 1);
  for (let nodeId = leafId; nodeId !== undefined; nodeId = parentOf.get(nodeId)) {
    inclusiveMicros.set(nodeId, (inclusiveMicros.get(nodeId) ?? 0) + delta);
  }
}

const totalMicros = profile.timeDeltas?.reduce((sum, delta) => sum + delta, 0) ?? 0;
const rows = [...inclusiveMicros.entries()].map(([id, micros]) => {
  const frame = byId.get(id).callFrame;
  const name = frame.functionName || "(anonymous)";
  const location = frame.url ? `${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1}` : frame.url;
  return {
    id,
    name,
    location,
    inclusiveMicros: micros,
    selfMicros: selfMicros.get(id) ?? 0,
    selfSamples: selfSamples.get(id) ?? 0,
  };
}).toSorted((left, right) => right.inclusiveMicros - left.inclusiveMicros);
const relevant = rows.filter((row) =>
  /RuntimeSignalReadable|RuntimeComputedReadable|readSignalValue|readSignalCore|publishForeignGraphRead|track|readComputedValue|readComputedCore|readComputed\b|updateComputed|checkDirty|promoteSpeculativeCache|speculativeDependenciesAreCurrent|writeSignalValue|notify|flushQueue|withoutAllRenderCollection|withTrackedGraph|withoutInteropSpeculativeMode|purgeDeps/.test(row.name),
).slice(0, limit || 30);

process.stdout.write(`${JSON.stringify({
  profile: path,
  sampleCount: profile.samples.length,
  sampledMs: totalMicros / 1000,
  topInclusive: rows.slice(0, limit).map((row) => ({
    function: row.name,
    location: row.location,
    inclusiveMs: Number((row.inclusiveMicros / 1000).toFixed(1)),
    selfMs: Number((row.selfMicros / 1000).toFixed(1)),
    selfSamples: row.selfSamples,
  })),
  relevantFunctions: relevant.map((row) => ({
    function: row.name,
    location: row.location,
    inclusiveMs: Number((row.inclusiveMicros / 1000).toFixed(1)),
    selfMs: Number((row.selfMicros / 1000).toFixed(1)),
    selfSamples: row.selfSamples,
  })),
}, null, 2)}\n`);
