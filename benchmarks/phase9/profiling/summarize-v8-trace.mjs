import { readFile } from "node:fs/promises";

const path = process.argv[2];
if (path === undefined) throw new Error("usage: node summarize-v8-trace.mjs <trace.txt>");
const lines = (await readFile(path, "utf8")).split(/\r?\n/);
const names = [
  "readSignalValue", "readSignalCore", "track", "publishForeignGraphRead",
  "readComputedValue", "readComputedCore", "updateComputed", "checkDirty",
  "writeSignalValue", "notify", "flushQueue", "run", "withTrackedGraph",
  "withoutAllRenderCollection", "withoutInteropSpeculativeMode",
];

const functions = names.map((name) => {
  const matching = lines.filter((line) => line.includes(`<JSFunction ${name} `));
  const optimized = new Set();
  const deopts = new Map();
  for (const line of matching) {
    const target = line.match(/target (MAGLEV|TURBOFAN_JS)/)?.[1];
    if (target && /for optimization to|\(target/.test(line)) optimized.add(target);
    const reason = line.match(/deopt-eager, reason: (.+?)\): begin\. deoptimizing .*<JSFunction/ )?.[1];
    if (reason !== undefined) deopts.set(reason, (deopts.get(reason) ?? 0) + 1);
  }
  return { function: name, optimized: [...optimized], eagerDeopts: Object.fromEntries(deopts) };
}).filter((item) => item.optimized.length > 0 || Object.keys(item.eagerDeopts).length > 0);

process.stdout.write(`${JSON.stringify({ trace: path, functions }, null, 2)}\n`);
