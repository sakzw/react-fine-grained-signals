import os from "node:os";
import { createRequire } from "node:module";
import inspector from "node:inspector";
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
const repoRequire = createRequire(new URL("../../package.json", import.meta.url));
const pluginRequire = createRequire(new URL("../../packages/unplugin-react-fine-grained-signals/package.json", import.meta.url));
const { transformSync } = pluginRequire("@babel/core");
const t = pluginRequire("@babel/types");
const { transformWithOxc } = repoRequire("vite");
const reactJsxRuntime = repoRequire("react/jsx-runtime");
import * as library from "../../dist/index.js";
import * as libraryRuntime from "../../dist/runtime.js";

const sizes = (process.env.M152_SIZES ?? process.env.M151_SIZES ?? "0,5,20,100,500")
  .split(",")
  .map(Number);
const samples = Number.parseInt(process.env.M152_SAMPLES ?? process.env.M151_SAMPLES ?? "3", 10);
const warmups = Number.parseInt(process.env.M152_WARMUPS ?? process.env.M151_WARMUPS ?? "1", 10);
const pluginPath = process.env.M152_PLUGIN_PATH ?? "../../packages/unplugin-react-fine-grained-signals/dist/vite.js";
const pluginModule = await import(new URL(pluginPath, import.meta.url).href);
const signals = pluginModule.default;

function fixture(count, kind) {
  const depth = kind === "chain" || kind === "nested" ? count : 1;
  const lines = [
    'import { deepSignal } from "react-fine-grained-signals";',
    `function makeTree(depth, name) { let value = { name }; for (let index = 0; index < depth; index += 1) value = { child: value }; return value; }`,
    `export const state = deepSignal(makeTree(${depth}, "Ada"));`,
    "export function Profile() {",
  ];
  if (kind === "none") {
    lines.push("  return <p>{state.value.child.name}</p>;");
  } else if (kind === "chain") {
    lines.push("  const { child: value0 } = state.value;");
    for (let index = 1; index < count; index += 1) {
      lines.push(`  const { child: value${index} } = value${index - 1};`);
    }
    lines.push(`  return <p>{value${count - 1}.name}</p>;`);
  } else if (kind === "independent") {
    for (let index = 0; index < count; index += 1) {
      lines.push(`  const { child: value${index} } = state.value;`);
    }
    lines.push(`  return <p>{${Array.from({ length: count }, (_, i) => `value${i}.name`).join(" + ")}}</p>;`);
  } else if (kind === "nested") {
    const keys = Array.from({ length: count }, () => "child");
    let pattern = "name";
    for (let index = keys.length - 1; index >= 0; index -= 1) pattern = `child: { ${pattern} }`;
    lines.push(`  const { ${pattern} } = state.value;`);
    lines.push("  return <p>{name}</p>;");
  } else {
    throw new Error(`Unknown fixture kind: ${kind}`);
  }
  lines.push("}");
  return lines.join("\n");
}

function createTransform() {
  const plugin = signals({ mode: "auto", transform: "managed" });
  const hook = typeof plugin.transform === "function" ? plugin.transform : plugin.transform?.handler;
  if (typeof hook !== "function") throw new Error("Vite transform hook was not found");
  return (source) => hook.call(plugin, source, "m15.2-benchmark.tsx");
}

function outputMetrics(result) {
  if (result === null || typeof result?.code !== "string") throw new Error("fixture was not transformed");
  const captures = result.code.match(/\.capture\(\(\)\s*=>/g)?.length ?? 0;
  return { captures, outputBytes: Buffer.byteLength(result.code) };
}

const moduleLinker = {
  name: "m152-benchmark-module-linker",
  visitor: {
    ImportDeclaration(path) {
      const properties = path.node.specifiers.map((specifier) => {
        if (!t.isImportSpecifier(specifier) || !t.isIdentifier(specifier.imported)) {
          throw path.buildCodeFrameError("benchmark fixtures only use named imports");
        }
        return t.objectProperty(t.identifier(specifier.imported.name), t.cloneNode(specifier.local));
      });
      path.replaceWith(t.variableDeclaration("const", [
        t.variableDeclarator(t.objectPattern(properties), t.memberExpression(
          t.identifier("__modules"), t.stringLiteral(path.node.source.value), true,
        )),
      ]));
    },
    ExportNamedDeclaration(path) {
      const declaration = path.node.declaration;
      if (!declaration) throw path.buildCodeFrameError("benchmark fixtures only export declarations");
      const names = [];
      if (t.isVariableDeclaration(declaration)) {
        for (const item of declaration.declarations) if (t.isIdentifier(item.id)) names.push(item.id.name);
      } else if (t.isFunctionDeclaration(declaration) && declaration.id) names.push(declaration.id.name);
      path.replaceWithMultiple([
        declaration,
        ...names.map((name) => t.expressionStatement(t.assignmentExpression(
          "=", t.memberExpression(t.identifier("__exports"), t.identifier(name)), t.identifier(name),
        ))),
      ]);
    },
  },
};

async function executeAndVerify(code, count, kind, verifyDeepUpdate) {
  const jsx = await transformWithOxc(code, "m15.2-benchmark-output.jsx", {
    lang: "jsx",
    jsx: { runtime: "automatic", importSource: "react" },
  });
  const linked = transformSync(jsx.code, {
    babelrc: false,
    configFile: false,
    filename: "m15.2-benchmark-output.js",
    plugins: [moduleLinker],
  });
  if (typeof linked?.code !== "string") throw new Error("runtime fixture linking emitted no code");
  const exports = {};
  const modules = {
    "react-fine-grained-signals": library,
    "react-fine-grained-signals/runtime": {
      ...libraryRuntime,
      useSignalCapture: () => ({ capture: (read) => read() }),
    },
    "react/jsx-runtime": reactJsxRuntime,
  };
  new Function("__modules", "__exports", linked.code)(modules, exports);

  const expected = (name) => kind === "independent" ? Array(count).fill(name).join("") : name;
  const readChild = () => exports.Profile().props.children;
  if (readChild() !== expected("Ada")) throw new Error(`${kind}/${count}: initial runtime value mismatch`);

  if (!verifyDeepUpdate) return;
  let target = exports.state.value;
  const depth = kind === "chain" || kind === "nested" ? count : 1;
  for (let index = 0; index < depth; index += 1) target = target.child;
  target.name = "Bea";
  if (readChild() !== expected("Bea")) throw new Error(`${kind}/${count}: deep update value mismatch`);
}

const rows = [];
const transform = createTransform();
const profileSession = process.env.M152_PROFILE ? new inspector.Session() : null;
if (profileSession) {
  profileSession.connect();
  await new Promise((resolve, reject) => profileSession.post("Profiler.enable", (error) => error ? reject(error) : resolve()));
}
const cases = [];
if (sizes.includes(0)) cases.push({ kind: "none", count: 0 });
for (const count of sizes.filter((size) => size > 0)) {
  for (const kind of ["independent", "chain", "nested"]) cases.push({ kind, count });
}
const selectedCase = process.env.M152_CASE;
const selectedCount = process.env.M152_COUNT == null ? undefined : Number(process.env.M152_COUNT);
const selectedCases = selectedCase == null
  ? cases
  : cases.filter(({ kind, count }) => kind === selectedCase && (selectedCount === undefined || count === selectedCount));
if (selectedCases.length === 0) throw new Error(`No benchmark case matches ${selectedCase}/${selectedCount}`);

for (const { kind, count } of selectedCases) {
  const source = fixture(count, kind);
  let result;
  for (let round = 0; round < warmups; round += 1) result = transform(source);
  const timings = [];
  const heapUsedDeltas = [];
  let postGcRetainedHeapDelta = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    if (profileSession && sample === 0) {
      await new Promise((resolve, reject) => profileSession.post("Profiler.start", (error) => error ? reject(error) : resolve()));
    }
    const start = performance.now();
    result = transform(source);
    timings.push(performance.now() - start);
    if (profileSession && sample === 0) {
      const profile = await new Promise((resolve, reject) => profileSession.post("Profiler.stop", (error, value) => error ? reject(error) : resolve(value.profile)));
      writeFileSync(process.env.M152_PROFILE, `${JSON.stringify(profile)}\n`);
    }
    heapUsedDeltas.push(process.memoryUsage().heapUsed - before);
    outputMetrics(result);
    global.gc?.();
    postGcRetainedHeapDelta = process.memoryUsage().heapUsed - before;
  }
  const correctnessStart = performance.now();
  const deepUpdateVerified = process.env.M152_EXPECT_DEEP_UPDATE !== "false";
  await executeAndVerify(result.code, count, kind, deepUpdateVerified);
  const correctnessValidationMs = performance.now() - correctnessStart;
  const metrics = outputMetrics(result);
  timings.sort((a, b) => a - b);
  rows.push({
    case: kind,
    destructurings: count,
    transformMedianMs: Number(timings[Math.floor(timings.length / 2)]?.toFixed(3)),
    transformMinMs: Number(timings[0]?.toFixed(3)),
    transformMaxMs: Number(timings.at(-1)?.toFixed(3)),
    correctnessValidationMs: Number(correctnessValidationMs.toFixed(3)),
    outputBytes: metrics.outputBytes,
    captureCount: metrics.captures,
    deepUpdateVerified,
    // These are synchronous before/after heapUsed deltas, not peak heap nor
    // total allocations. The post-GC delta is only a noisy retention sample.
    heapUsedDeltaAfterTransformMiB: Number((Math.max(...heapUsedDeltas) / 1024 / 1024).toFixed(2)),
    postGcRetainedHeapDeltaMiB: Number((postGcRetainedHeapDelta / 1024 / 1024).toFixed(2)),
  });
  console.log(JSON.stringify(rows.at(-1)));
}

const report = {
  date: new Date().toISOString(),
  node: process.version,
  platform: `${os.platform()} ${os.arch()}`,
  cpu: os.cpus()[0]?.model,
  warmups,
  samples,
  pluginPath,
  rows,
};
console.log(JSON.stringify(report, null, 2));
if (process.env.M152_OUTPUT ?? process.env.M151_OUTPUT) {
  writeFileSync(process.env.M152_OUTPUT ?? process.env.M151_OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
}
