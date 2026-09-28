import { readFileSync } from "node:fs";
const path = process.argv[2] ?? "./screen-alternatives-results.json";
const data = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};
const quantile = (values, fraction) => {
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
};
for (const caseId of ["source/read@1", "source/write-read@1"]) {
  const rows = data.results.filter((row) => row.caseId === caseId);
  const runtimes = rows[0].order;
  const v011RoundMedians = rows.map((row) => median(row.perRuntime["rfsg-v0.1.1"].durationsNs));
  const helperRoundMedians = rows.map((row) => median(row.perRuntime["m15-helper-object"].durationsNs));
  const perRuntime = Object.fromEntries(runtimes.map((runtime) => {
    const roundMedians = rows.map((row) => median(row.perRuntime[runtime].durationsNs));
    const ratios = roundMedians.map((value, index) => value / v011RoundMedians[index]);
    const helperRatios = roundMedians.map((value, index) => value / helperRoundMedians[index]);
    return [runtime, {
      medianRoundNs: median(roundMedians),
      roundsNs: roundMedians,
      ratioToV011: median(ratios),
      ratioIqr: [quantile(ratios, 0.25), quantile(ratios, 0.75)],
      ratioMinMax: [Math.min(...ratios), Math.max(...ratios)],
      roundsBelowOne: ratios.filter((ratio) => ratio < 1).length,
      roundRatios: ratios,
      relativeToHelperObject: median(helperRatios),
      helperRatioIqr: [quantile(helperRatios, 0.25), quantile(helperRatios, 0.75)],
    }];
  }));
  const variants = runtimes.filter((runtime) => runtime !== "rfsg-v0.1.1");
  console.log(JSON.stringify({
    caseId,
    variants: Object.fromEntries(variants.map((runtime) => [runtime, {
      medianNs: perRuntime[runtime].medianRoundNs,
      vsV011: perRuntime[runtime].ratioToV011,
      v011RatioIqr: perRuntime[runtime].ratioIqr,
      vsHelperObject: perRuntime[runtime].relativeToHelperObject,
      helperRatioIqr: perRuntime[runtime].helperRatioIqr,
      roundsBelowV011: perRuntime[runtime].roundsBelowOne,
    }])),
  }));
}
