import { readFileSync, writeFileSync } from "node:fs";

const resultDirectory = new URL("./results/", import.meta.url);
const diagnostics = JSON.parse(readFileSync(new URL("m153-diagnostic-results.json", resultDirectory), "utf8"));
const react = JSON.parse(readFileSync(new URL("m153-react-results.json", resultDirectory), "utf8"));
const sourceFastPath = JSON.parse(readFileSync(new URL("m153-source-fast-path-results.json", resultDirectory), "utf8"));
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};
const quantile = (values, probability) => {
  const sorted = values.toSorted((a, b) => a - b);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
};
const roundMedian = (samples) => median(samples);
function summarizeRows(rows, numerator, denominator) {
  const ratios = rows.map((row) => roundMedian(row.perRuntime[numerator]) / roundMedian(row.perRuntime[denominator]));
  return {
    pairedRounds: ratios.length,
    median: median(ratios), q1: quantile(ratios, 0.25), q3: quantile(ratios, 0.75),
    min: Math.min(...ratios), max: Math.max(...ratios),
    numeratorFasterRounds: ratios.filter((ratio) => ratio < 1).length,
    numeratorSlowerRounds: ratios.filter((ratio) => ratio > 1).length,
  };
}
const diagnosticSummary = {
  purpose: diagnostics.purpose,
  gitHead: diagnostics.gitHead,
  worktreeDirtyAtStart: diagnostics.worktreeDirtyAtStart,
  dirtyPathsAtStart: diagnostics.dirtyPathsAtStart,
  rounds: diagnostics.rounds, warmups: diagnostics.warmups, samples: diagnostics.samples,
  frozenIterationsSha256: diagnostics.frozenIterationsSha256,
  cases: diagnostics.cases.map((item) => {
    const rows = diagnostics.measurements.filter((row) => row.caseId === item.caseId);
    return {
      caseId: item.caseId, iterations: item.iterations,
      comparisons: Object.fromEntries(["m151-integrated", "rfsg-v0.1.1", "rfsg-pre-m15"].map((runtime) => [runtime, summarizeRows(rows, "rfsg-current", runtime)])),
    };
  }),
};
const reactSummary = {
  purpose: react.purpose, gitHead: react.gitHead,
  worktreeDirtyAtStart: react.worktreeDirtyAtStart,
  dirtyPathsAtStart: react.dirtyPathsAtStart,
  rounds: react.rounds, warmups: react.warmups, samples: react.samples,
  cases: react.cases.map((item) => {
    const rows = react.measurements.filter((row) => row.caseId === item.caseId);
    return { caseId: item.caseId, iterations: item.iterations, currentOverV011Duration: summarizeRows(rows, "rfsg-current", "rfsg-v0.1.1") };
  }),
};
const sourceFastPathSummary = {
  purpose: sourceFastPath.purpose,
  gitHead: sourceFastPath.gitHead,
  worktreeDirtyAtStart: sourceFastPath.worktreeDirtyAtStart,
  dirtyPathsAtStart: sourceFastPath.dirtyPathsAtStart,
  rounds: sourceFastPath.rounds,
  warmups: sourceFastPath.warmups,
  samples: sourceFastPath.samples,
  frozenIterationsSha256: sourceFastPath.frozenIterationsSha256,
  cases: sourceFastPath.cases.map((item) => {
    const rows = sourceFastPath.measurements.filter((row) => row.caseId === item.caseId);
    return {
      caseId: item.caseId,
      iterations: item.iterations,
      comparisons: Object.fromEntries(["m151-integrated", "rfsg-v0.1.1", "rfsg-pre-m15"].map((runtime) => [runtime, summarizeRows(rows, "rfsg-current", runtime)])),
    };
  }),
};
writeFileSync(new URL("m153-diagnostic-summary.json", resultDirectory), `${JSON.stringify(diagnosticSummary, null, 2)}\n`);
writeFileSync(new URL("m153-react-summary.json", resultDirectory), `${JSON.stringify(reactSummary, null, 2)}\n`);
writeFileSync(new URL("m153-source-fast-path-summary.json", resultDirectory), `${JSON.stringify(sourceFastPathSummary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ diagnostics: diagnosticSummary.cases.map(({ caseId, comparisons }) => ({ caseId, comparisons })), react: reactSummary.cases.map(({ caseId, currentOverV011Duration }) => ({ caseId, currentOverV011Duration })), sourceFastPath: sourceFastPathSummary.cases }, null, 2)}\n`);
