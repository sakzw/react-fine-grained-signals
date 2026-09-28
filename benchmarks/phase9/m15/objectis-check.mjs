import assert from "node:assert/strict";
import { computed, effect, signalClassInline } from "./alien-derived-runtime-objectis.mjs";

const direct = signalClassInline(Number.NaN);
let directRuns = 0;
const stopDirect = effect(() => { direct.value; directRuns += 1; });
direct.value = Number.NaN;
assert.equal(directRuns, 1, "NaN to NaN must be equal");
direct.value = 0;
assert.equal(directRuns, 2, "+0 must differ from NaN");
direct.value = -0;
assert.equal(directRuns, 3, "+0 to -0 must trigger");
stopDirect();

const source = signalClassInline(Number.NaN);
const derived = computed(() => source.value);
let derivedRuns = 0;
const stopDerived = effect(() => { derived.value; derivedRuns += 1; });
source.value = Number.NaN;
assert.equal(derivedRuns, 1, "computed propagation must suppress NaN to NaN");
source.value = 0;
assert.equal(derivedRuns, 2, "computed must propagate NaN to +0");
source.value = -0;
assert.equal(derivedRuns, 3, "computed must propagate +0 to -0");
stopDerived();
console.log("Object.is boundary checks passed");
