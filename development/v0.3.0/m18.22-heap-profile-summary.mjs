import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const profile = JSON.parse(readFileSync(resolve(process.argv[2]), "utf8"));
const outputPath = process.argv[3];
const nodes = new Map();
const pending = [profile.head];
while (pending.length) {
  const node = pending.pop();
  nodes.set(node.id, node);
  pending.push(...node.children ?? []);
}
const byFrame = new Map();
let sampledBytes = 0;
for (const sample of profile.samples) {
  const node = nodes.get(sample.nodeId);
  const frame = node?.callFrame;
  const key = `${frame?.functionName || "(anonymous)"} @ ${frame?.url || "native"}`;
  byFrame.set(key, (byFrame.get(key) ?? 0) + sample.size);
  sampledBytes += sample.size;
}
const report = JSON.stringify({
  samplingIntervalBytes: profile.head.samplingInterval,
  sampledAllocationBytes: sampledBytes,
  sampleCount: profile.samples.length,
  topFrames: [...byFrame].map(([frame, bytes]) => ({ frame, bytes }))
    .toSorted((a, b) => b.bytes - a.bytes).slice(0, 30),
}, null, 2);
console.log(report);
if (outputPath) writeFileSync(resolve(outputPath), `${report}\n`);
