// M17.7: capture count, output size, transform time, and render time of the
// managed transform before and after the callee-resolution change.
//
//   npx tsx development/v0.3.0/m17.7-capture-perf.mjs <base transform.ts> <candidate transform.ts>
//
// Both arguments are copies of packages/unplugin-react-fine-grained-signals/src/internal/transform.ts.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const root = resolve(import.meta.dirname, "../..");
const { transformWithOxc } = await import("vite");
const React = await import("react");
const { renderToString } = await import("react-dom/server");
const jsxRuntime = await import("react/jsx-runtime");
const library = await import(join(root, "src/index.ts"));
const runtime = await import(join(root, "src/runtime.ts"));
const libraryJsx = await import(join(root, "src/jsx-runtime.ts"));

const [basePath, candidatePath] = process.argv.slice(2).map((path) => resolve(path));
const variants = {
  base: (await import(basePath)).transformReactFineGrainedSignals,
  candidate: (await import(candidatePath)).transformReactFineGrainedSignals,
};

const options = (mode) => ({
  importSource: "react-fine-grained-signals", mode, transform: "managed", reactCompiler: "auto", reactImportSource: "react",
});
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const captures = (code) => (code.match(/\.capture\(/g) ?? []).length;

function measure(transform, source, mode, file = "Fixture.tsx") {
  for (let i = 0; i < 2; i += 1) transform(source, file, options(mode));
  const times = [];
  let code = "";
  for (let i = 0; i < 7; i += 1) {
    const start = performance.now();
    code = transform(source, file, options(mode))?.code ?? source;
    times.push(performance.now() - start);
  }
  return { ms: Number(median(times).toFixed(2)), bytes: code.length, captures: captures(code), code };
}

const head = `import { signal } from "react-fine-grained-signals";\nexport const tick = signal(0);\n`;
const repeat = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join("\n");
const cases = {
  "section 7 example": `${head}export function App({ items, title }) {
  const visible = items.filter(Boolean);
  return (<p>{tick.value}{visible.map(String).join(",")}{title.toUpperCase()}</p>);
}`,
  "200 builtin calls on props": `${head}export function App({ items, title, rows }) {
  return (<div>{tick.value}
${repeat(200, (i) => `    <p>{items.filter(Boolean).map(String).join("${i}")}{title.toUpperCase()}{rows.map((r) => r.name.trim()).join()}</p>`)}
  </div>);
}`,
  "200 calls on destructured props": `${head}export function App(props) {
  const { items, title } = props;
  return (<div>{tick.value}
${repeat(200, (i) => `    <p>{items.slice(${i}).join()}{title.padStart(${i})}</p>`)}
  </div>);
}`,
  "helper chain x100": `${head}${repeat(100, (i) => i === 0 ? "function h0(x) { return x.trim(); }" : `function h${i}(x) { return h${i - 1}(x); }`)}
export function App({ title }) { return <p>{tick.value}{h99(title)}</p>; }`,
  "helper chain x100 (unknown arg)": `${head}import { ext } from "./ext";\n${repeat(100, (i) => i === 0 ? "function h0(x) { return x.trim(); }" : `function h${i}(x) { return h${i - 1}(x); }`)}
export function App() { return <p>{tick.value}{h99(ext)}</p>; }`,
  "alias chain x200": `${head}export function App({ items }) {
  const a0 = items;
${repeat(199, (i) => `  const a${i + 1} = a${i};`)}
  return <p>{tick.value}{a199.map(String).join()}</p>;
}`,
  "deep member x200": `${head}export function App(props) {
  return (<div>{tick.value}
${repeat(200, (i) => `    <p>{props.a.b.c.d.e${i}.trim()}</p>`)}
  </div>);
}`,
  "200 helpers called with props": `${head}${repeat(200, (i) => `function label${i}(row) { return row.name.trim() + ${i}; }`)}
export function App({ rows }) { return <div>{tick.value}${repeat(200, (i) => `{rows.map(label${i}).join()}{label${i}(rows[0])}`)}</div>; }`,
};

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === "dist") return [];
    return statSync(path).isDirectory() ? walk(path) : /\.(t|j)sx$/.test(name) ? [path] : [];
  });
}
const exampleFiles = walk(join(root, "examples"));

const rows = [];
for (const mode of ["auto", "all"]) {
  for (const [name, source] of Object.entries(cases)) {
    const base = measure(variants.base, source, mode);
    const candidate = measure(variants.candidate, source, mode);
    rows.push({ mode, case: name, captures: `${base.captures} -> ${candidate.captures}`, bytes: `${base.bytes} -> ${candidate.bytes}`, ms: `${base.ms} -> ${candidate.ms}` });
  }
  let baseTotal = 0;
  let candidateTotal = 0;
  const changed = [];
  for (const file of exampleFiles) {
    const source = readFileSync(file, "utf8");
    const base = measure(variants.base, source, mode, file).captures;
    const candidate = measure(variants.candidate, source, mode, file).captures;
    baseTotal += base;
    candidateTotal += candidate;
    if (base !== candidate) changed.push(`${file.slice(root.length + 1)} ${base}->${candidate}`);
  }
  rows.push({ mode, case: `examples (${exampleFiles.length} files)`, captures: `${baseTotal} -> ${candidateTotal}`, bytes: changed.join("; ") || "unchanged", ms: "" });
}
console.table(rows);

// Render time of the section 7 example (server render, so every render runs the captures).
const registry = {
  react: React, "react/jsx-runtime": jsxRuntime, "react-fine-grained-signals": library,
  "react-fine-grained-signals/runtime": runtime, "react-fine-grained-signals/jsx-runtime": libraryJsx,
};
async function load(code) {
  const jsx = await transformWithOxc(code, "Fixture.jsx", { lang: "jsx", jsx: { runtime: "automatic", importSource: "react" } });
  const linked = jsx.code
    .replace(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)";?/g, (_, names, id) =>
      `const {${names.replace(/\bas\b/g, ":")}} = __registry[${JSON.stringify(id)}];`)
    .replace(/export const (\w+)/g, "const $1")
    .replace(/export function (\w+)/g, "__exports.$1 = $1; function $1");
  const exports = {};
  new Function("__registry", "__exports", linked)(registry, exports);
  return exports;
}
const renderRows = [];
for (const mode of ["auto", "all"]) {
  for (const name of ["section 7 example", "200 builtin calls on props", "200 calls on destructured props"]) {
    const result = {};
    for (const [variant, transform] of Object.entries(variants)) {
      const code = transform(cases[name].replace(/^import .*\n/, ""), "Fixture.jsx", options(mode))?.code;
      const { App } = await load(`import { signal } from "react-fine-grained-signals";\n${code}`);
      const props = { items: ["a", "", "b", "c"], title: "hello", rows: [{ name: " x " }, { name: "y" }] };
      const element = React.createElement(App, props);
      const iterations = name.startsWith("200") ? 200 : 5000;
      for (let i = 0; i < iterations; i += 1) renderToString(element);
      const batches = [];
      for (let b = 0; b < 5; b += 1) {
        const start = performance.now();
        for (let i = 0; i < iterations; i += 1) renderToString(element);
        batches.push((performance.now() - start) / iterations * 1000);
      }
      result[variant] = median(batches).toFixed(1);
    }
    renderRows.push({ mode, case: name, "us/render base": result.base, "us/render candidate": result.candidate });
  }
}
console.table(renderRows);
