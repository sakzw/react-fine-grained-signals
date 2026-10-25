/* oxlint-disable react/no-children-prop -- the JSX runtime benchmark must pass the compiled `children` config directly. */
const React = await import("react");
const { jsx: reactJsx, jsxs: reactJsxs } = await import("react/jsx-runtime");
const { jsx: signalJsx, jsxs: signalJsxs } = await import("../dist/jsx/jsx-runtime.js");
const { signal } = await import("../dist/index.js");

const iterations = Number(process.env.M10_JSX_ITERATIONS ?? 5_000);
const warmups = Number(process.env.M10_JSX_WARMUPS ?? 1);
const samples = Number(process.env.M10_JSX_SAMPLES ?? 3);
const titleSignal = signal("reactive title");
const classSignal = signal("active");
const styleColor = signal("red");
const valueSignal = signal("text");
const checkedSignal = signal(false);
const radioSignal = signal("basic");
const checkboxGroupSignal = signal(["search"]);
function Component() { return null; }
let sink;

const paired = [
  ["host-no-props", (factory) => () => factory("div", {})],
  ["host-ordinary-props", (factory) => () => factory("div", { title: "title", className: "active", "data-state": "ready", id: "item" })],
  ["host-one-child", (factory) => () => factory("div", { children: "child" })],
  ["host-multiple-children", (factory) => () => factory("div", { children: ["first", "second"] }), "jsxs"],
  ["custom-no-props", (factory) => () => factory(Component, {})],
  ["custom-ordinary-props", (factory) => () => factory(Component, { value: "plain", count: 2 })],
  ["fragment-children", (factory) => () => factory(React.Fragment, { children: ["first", "second"] }), "jsxs"],
];

const signalOnly = [
  ["signal-host-prop", () => signalJsx("div", { title: titleSignal, className: classSignal })],
  ["signal-style-property", () => signalJsx("div", { style: { color: styleColor, width: 12 } })],
  ["signal-child", () => signalJsx("div", { children: titleSignal })],
  ["signal-children-array", () => signalJsxs("div", { children: [titleSignal, "suffix"] })],
  ["bind-value", () => signalJsx("input", { type: "text", bindValue: valueSignal })],
  ["bind-checked", () => signalJsx("input", { type: "checkbox", bindChecked: checkedSignal })],
  ["bind-radio-value", () => signalJsx("input", { type: "radio", name: "plan", value: "basic", bindValue: radioSignal })],
  ["bind-checkbox-group", () => signalJsx("input", { type: "checkbox", name: "features", value: "search", bindValue: checkboxGroupSignal })],
];

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
};
function measure(run) {
  const times = [];
  for (let round = 0; round < warmups + samples; round += 1) {
    if (globalThis.gc) globalThis.gc();
    const start = process.hrtime.bigint();
    for (let index = 0; index < iterations; index += 1) sink = run(index);
    const elapsedNs = Number(process.hrtime.bigint() - start);
    if (round >= warmups) times.push(elapsedNs / iterations);
  }
  return {
    medianNsPerCall: median(times),
    p25NsPerCall: percentile(times, 0.25),
    p75NsPerCall: percentile(times, 0.75),
    samplesNsPerCall: times,
  };
}
function measurePair(reactRun, signalRun) {
  const times = { react: [], rfsg: [] };
  for (let round = 0; round < warmups + samples; round += 1) {
    if (globalThis.gc) globalThis.gc();
    const runs = round % 2 === 0
      ? [["react", reactRun], ["rfsg", signalRun]]
      : [["rfsg", signalRun], ["react", reactRun]];
    for (const [name, run] of runs) {
      const start = process.hrtime.bigint();
      for (let index = 0; index < iterations; index += 1) sink = run(index);
      const elapsedNs = Number(process.hrtime.bigint() - start);
      if (round >= warmups) times[name].push(elapsedNs / iterations);
    }
  }
  const summarize = (values) => ({
    medianNsPerCall: median(values),
    p25NsPerCall: percentile(values, 0.25),
    p75NsPerCall: percentile(values, 0.75),
    samplesNsPerCall: values,
  });
  return { react: summarize(times.react), rfsg: summarize(times.rfsg) };
}

const results = [];
for (const [name, createRun, factoryName = "jsx"] of paired) {
  const reactFactory = factoryName === "jsxs" ? reactJsxs : reactJsx;
  const signalFactory = factoryName === "jsxs" ? signalJsxs : signalJsx;
  const reactRun = createRun(reactFactory);
  const signalRun = createRun(signalFactory);
  const reactElement = reactRun(0);
  const signalElement = signalRun(0);
  const sameProps = JSON.stringify(reactElement.props) === JSON.stringify(signalElement.props);
  if (!sameProps || reactElement.type !== signalElement.type || reactElement.key !== signalElement.key) {
    throw new Error(`${name}: React and RFSG output diverged for ordinary props`);
  }
  const { react, rfsg } = measurePair(reactRun, signalRun);
  results.push({ name, react, rfsg, ratio: rfsg.medianNsPerCall / react.medianNsPerCall, outputEquivalent: true });
}
for (const [name, run] of signalOnly) results.push({ name, rfsgFeatureCost: measure(run) });

const report = {
  node: process.version,
  react: React.version,
  iterations,
  warmups,
  samples,
  gcExposed: typeof globalThis.gc === "function",
  methodology: "JSX factory-only; props literals allocated per call; ordinary cases compare React and RFSG; signal/binding cases are RFSG-only feature costs; median and p25/p75 in ns/call.",
  results,
  sinkType: typeof sink,
};
const serialized = JSON.stringify(report, null, 2);
if (process.env.M10_JSX_OUTPUT) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.M10_JSX_OUTPUT, `${serialized}\n`);
}
console.log(serialized);
