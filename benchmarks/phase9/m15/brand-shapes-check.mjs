import assert from "node:assert/strict";
import * as runtime from "./alien-derived-runtime-brand-candidates.mjs";
const candidates = [
  ["weakset+brand", runtime.signalClassBrandWeakSet, runtime.computedClassBrandWeakSet, runtime.isSignalBrandWeakSet],
  ["helper brand", runtime.signalClassBrandHelper, runtime.computedClassBrandHelper, runtime.isSignalBrandHelper],
  ["direct brand", runtime.signalClassBrandDirect, runtime.computedClassBrandDirect, runtime.isSignalBrandDirect],
];
for (const [name, makeSignal, makeComputed, isSignal] of candidates) {
  const source = makeSignal(2);
  const derived = makeComputed(() => source.value * 2);
  assert.equal(source.value, 2, `${name} source value`);
  assert.equal(source.peek(), 2, `${name} source peek`);
  assert.equal(derived.value, 4, `${name} computed value`);
  assert.equal(derived.peek(), 4, `${name} computed peek`);
  source.value = 3;
  assert.equal(derived.value, 6, `${name} propagation`);
  assert.equal(isSignal(source), true, `${name} source brand`);
  assert.equal(isSignal(derived), true, `${name} computed brand`);
  assert.equal(Reflect.set(derived, "value", 10), false, `${name} read-only computed`);
  for (const value of [source, derived]) {
    assert.deepEqual(Object.keys(value), [], `${name} enumerable shape`);
    assert.deepEqual(Object.getOwnPropertyNames(value), [], `${name} own names`);
    assert.deepEqual(Object.getOwnPropertySymbols(value), [runtime.SIGNAL_BRAND], `${name} brand shape`);
    assert.deepEqual(Object.getOwnPropertyNames(Object.getPrototypeOf(value)).sort(), ["constructor", "peek", "value"].sort());
    assert.deepEqual(Object.getOwnPropertyDescriptor(value, runtime.SIGNAL_BRAND), { value: 1, enumerable: false, writable: false, configurable: false });
  }
}
console.log("Three single-object public brand shapes passed");
