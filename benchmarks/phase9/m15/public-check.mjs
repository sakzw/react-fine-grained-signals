import assert from "node:assert/strict";
import { computed, effect, isSignal, signal, SIGNAL_BRAND } from "./alien-derived-runtime-public.mjs";

const source = signal(2);
const doubled = computed(() => source.value * 2);
assert.equal(source.value, 2);
assert.equal(source.peek(), 2);
assert.equal(doubled.value, 4);
assert.equal(doubled.peek(), 4);
source.value = 3;
assert.equal(doubled.value, 6);
assert.equal(isSignal(source), true);
assert.equal(isSignal(doubled), true);
assert.equal(Reflect.set(doubled, "value", 10), false);
for (const value of [source, doubled]) {
  assert.deepEqual(Object.keys(value), []);
  assert.deepEqual(Object.getOwnPropertyNames(value), []);
  assert.deepEqual(Object.getOwnPropertySymbols(value), [SIGNAL_BRAND]);
  assert.deepEqual(Object.getOwnPropertySymbols(Object.getPrototypeOf(value)), []);
  assert.deepEqual(Object.getOwnPropertyNames(Object.getPrototypeOf(value)).sort(), ["constructor", "peek", "value"].sort());
  assert.deepEqual(Object.getOwnPropertyDescriptor(value, SIGNAL_BRAND), {
    value: 1, enumerable: false, writable: false, configurable: false,
  });
}
const foreign = { peek() {} };
Object.defineProperty(foreign, SIGNAL_BRAND, { value: 1 });
assert.equal(isSignal(foreign), true);
const malformed = {};
Object.defineProperty(malformed, SIGNAL_BRAND, { value: 1 });
assert.equal(isSignal(malformed), false);
let runs = 0;
const stop = effect(() => { source.value; runs += 1; });
source.value = 4;
assert.equal(runs, 2);
stop();
console.log("Public wrapper and brand conformance passed");
