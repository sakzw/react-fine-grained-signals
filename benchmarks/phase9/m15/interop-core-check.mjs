import assert from "node:assert/strict";

const base = new URL("./alien-derived-runtime-render.mjs", import.meta.url);
const [copyA, copyB] = await Promise.all([
  import(new URL(`${base.href}?copy=A`)),
  import(new URL(`${base.href}?copy=B`)),
]);

const foreignSource = copyB.signalClassBrandHelper(1);
const seenForeign = [];
const disposeForeign = copyA.effect(() => seenForeign.push(foreignSource.value));
foreignSource.value = 2;
assert.deepEqual(seenForeign, [1, 2], "copy A effect observes copy B source writes");
disposeForeign();
foreignSource.value = 3;
assert.deepEqual(seenForeign, [1, 2], "disposing releases a foreign source subscription");

const localSource = copyA.signalClassBrandHelper(1);
const seenLocal = [];
const disposeLocal = copyB.effect(() => seenLocal.push(localSource.value));
localSource.value = 4;
assert.deepEqual(seenLocal, [1, 4], "copy B effect observes copy A source writes");
disposeLocal();

const computedSource = copyB.signalClassBrandHelper(2);
const foreignComputed = copyB.computedClassBrandHelper(() => computedSource.value * 10);
const computedValues = [];
const disposeComputed = copyA.effect(() => computedValues.push(foreignComputed.value));
computedSource.value = 3;
assert.deepEqual(computedValues, [20, 30], "foreign computed updates propagate to the opposite copy");
disposeComputed();

const left = copyB.signalClassBrandHelper(1);
const right = copyB.signalClassBrandHelper(2);
let batchRuns = 0;
let batchValue;
const disposeBatch = copyA.effect(() => {
  batchRuns += 1;
  batchValue = left.value + right.value;
});
copyB.batch(() => { left.value = 10; right.value = 20; });
assert.equal(batchValue, 30);
assert.equal(batchRuns, 2, "foreign writes in one batch produce one local effect rerun");
disposeBatch();

console.log("M1.5 duplicate-copy graph interop checks passed.");
