import { readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
const text = readFileSync(new URL("./screen-results.json", import.meta.url), "utf8");
const start = text.indexOf("{\n  \"purpose\"");
if (start < 0) throw new Error("Could not locate screen JSON payload after progress lines");
const data = JSON.parse(text.slice(start));
writeFileSync(new URL("./screen-results-raw.json", import.meta.url), `${JSON.stringify(data, null, 2)}\n`);
const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};
for (const caseId of ["source/read@1", "source/write-read@1"]) {
  const rows = data.results.filter((row) => row.caseId === caseId);
  const runtimes = rows[0].order;
  const medianNsByRuntime = Object.fromEntries(runtimes.map((runtime) => [
    runtime,
    median(rows.map((row) => median(row.perRuntime[runtime].durationsNs))),
  ]));
  const ratios = rows.map((row) => median(row.perRuntime["m15-alien-derived"].durationsNs)
    / median(row.perRuntime["rfsg-v0.1.1"].durationsNs));
  console.log(JSON.stringify({ caseId, medianNsByRuntime, medianM15OverV011: median(ratios), roundRatios: ratios }));
}
