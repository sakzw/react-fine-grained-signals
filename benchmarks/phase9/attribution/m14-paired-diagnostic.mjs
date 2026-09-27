import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [controlRootArg, variantRootArg, outputArg, ...caseArgs] = process.argv.slice(2);
if (!controlRootArg || !variantRootArg || !outputArg || caseArgs.length === 0) {
  throw new Error("usage: node m14-paired-diagnostic.mjs <control-root> <variant-root> <output.json> <kind@size>...");
}
const controlRoot = resolve(controlRootArg);
const variantRoot = resolve(variantRootArg);
const outputPath = resolve(outputArg);
const phase9Root = resolve(import.meta.dirname, "..");
const iterationPath = resolve(phase9Root, "m1b-iterations.json");
const iterations = JSON.parse(await readFile(iterationPath, "utf8"));
const frozenCase = (kind) => ({
  "computed-create": "computed/create",
  "computed-dirty-read": "computed/dirty-read",
  "computed-dirty-unread": "computed/dirty-unread",
  "computed-equality": "computed/equality-suppression",
  "effect-observed-write": "effect/observed-write",
  "effect-fanout": "effect/fanout",
  "source-create": "source/create",
  "source-read": "source/read",
  "source-unobserved-write": "source/unobserved-write",
  "source-write-read": "source/write-read",
})[kind] ?? kind.replace(/^(batch)-/, "$1/");
const cases = caseArgs.map((key) => {
  const [kind, sizeText] = key.split("@");
  const size = Number(sizeText);
  const frozenKey = `${frozenCase(kind)}@${size}`;
  const count = iterations[frozenKey];
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error(`Missing frozen iterations for ${frozenKey}`);
  return { key, kind, size, iterations: count };
});

function runWorker(root, definition) {
  const payload = JSON.stringify({
    runtimeId: "rfsg-current",
    kind: definition.kind,
    iterations: definition.iterations,
    size: definition.size,
    warmups: 3,
    samples: 7,
  });
  const workerPath = resolve(root, "benchmarks/phase9/worker.mjs");
  const result = spawnSync(process.execPath, ["--expose-gc", workerPath, payload], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`${definition.key} worker failed in ${root}: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  if (parsed.status !== "ok" || parsed.preflight !== "passed" || parsed.samples.length !== 7) {
    throw new Error(`${definition.key} worker did not pass preflight: ${result.stdout}`);
  }
  const values = parsed.samples.map((sample) => sample.durationNs).toSorted((a, b) => a - b);
  return { processMedianNs: values[3], samples: parsed.samples };
}

const records = [];
for (const definition of cases) {
  for (let pair = 0; pair < 4; pair += 1) {
    const order = pair % 2 === 0 ? ["control", "variant"] : ["variant", "control"];
    const paired = {};
    for (const side of order) {
      paired[side] = runWorker(side === "control" ? controlRoot : variantRoot, definition);
    }
    records.push({
      case: definition.key,
      iterations: definition.iterations,
      pair: pair + 1,
      order,
      controlMedianNs: paired.control.processMedianNs,
      variantMedianNs: paired.variant.processMedianNs,
      ratio: paired.variant.processMedianNs / paired.control.processMedianNs,
      controlSamples: paired.control.samples,
      variantSamples: paired.variant.samples,
    });
  }
}
await writeFile(outputPath, `${JSON.stringify({
  method: "four paired fresh-process diagnostics; three warmups and seven samples per process; frozen M1b iterations",
  node: process.version,
  controlRoot,
  variantRoot,
  records,
}, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(records.map(({ case: name, pair, ratio }) => ({ case: name, pair, ratio })))}\n`);
