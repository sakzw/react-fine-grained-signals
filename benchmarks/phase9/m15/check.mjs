import assert from "node:assert/strict";
import {
  batch,
  computed,
  effect,
  signal,
  signalBoundAccessor,
  signalClassHelper,
  signalClassInline,
  signalInlineAccessor,
  untracked,
} from "./alien-derived-runtime.mjs";

for (const [name, makeSignal] of [
  ["helper accessor", signal],
  ["bound signalOper accessor", signalBoundAccessor],
  ["class/helper accessor", signalClassHelper],
  ["inline class accessor", signalClassInline],
  ["inline accessor", signalInlineAccessor],
]) {
  const source = makeSignal(0);
  assert.equal(source.value, 0, `${name}: initial value`);
  assert.equal(source.peek(), 0, `${name}: peek initial value`);
  source.value = 1;
  assert.equal(source.value, 1, `${name}: assigned value`);
  let runs = 0;
  const stop = effect(() => { source.value; runs += 1; });
  source.value = 2;
  assert.equal(runs, 2, `${name}: observed write`);
  batch(() => { source.value = 3; source.value = 4; });
  assert.equal(runs, 3, `${name}: batched writes`);
  stop();
}

const directBoundShape = signalBoundAccessor(0);
assert.deepEqual(Object.getOwnPropertyNames(directBoundShape), ["peek", "value"]);
assert.equal(typeof directBoundShape, "object", "bound descriptor shape must remain a non-callable object");
const classShape = signalClassHelper(0);
assert.deepEqual(Object.getOwnPropertyNames(classShape), [], "shared class instance keeps methods on its prototype");

for (const [name, runtime] of [
  ["bundled class/helper", await import("./bundled/entry-class-helper.mjs")],
  ["bundled inline class", await import("./bundled/entry-class-inline.mjs")],
  ["bundled bound descriptor", await import("./bundled/entry-bound-descriptor.mjs")],
]) {
  const source = runtime.signal(1);
  assert.equal(source.value, 1, `${name}: initial value`);
  let runs = 0;
  const stop = runtime.effect(() => { source.value; runs += 1; });
  runtime.batch(() => { source.value = 2; source.value = 3; });
  assert.equal(source.value, 3, `${name}: batched final value`);
  assert.equal(runs, 2, `${name}: batched effect count`);
  stop();
}

const source = signal(2);
let evaluations = 0;
const doubled = computed(() => { evaluations += 1; return source.value * 2; });
assert.equal(evaluations, 0, "computed must stay lazy");
assert.equal(doubled.value, 4);
assert.equal(doubled.peek(), 4);
assert.equal(evaluations, 1, "computed must cache clean reads");

let runs = 0;
const stop = effect(() => { doubled.value; runs += 1; });
assert.equal(runs, 1, "effect must run synchronously on creation");
source.value = 3;
assert.equal(runs, 2, "effect must synchronously observe source writes");
batch(() => { source.value = 4; source.value = 5; });
assert.equal(runs, 3, "batch must coalesce writes into one effect run");
stop();
source.value = 6;
assert.equal(runs, 3, "disposed effect must stop reacting");

const untrackedSource = signal(1);
const trackedSource = signal(1);
let trackingRuns = 0;
const stopTracking = effect(() => {
  untracked(() => untrackedSource.value);
  trackedSource.value;
  trackingRuns += 1;
});
untrackedSource.value = 2;
assert.equal(trackingRuns, 1, "untracked reads must not subscribe the current effect");
trackedSource.value = 2;
assert.equal(trackingRuns, 2, "tracked reads must subscribe the current effect");
stopTracking();

const parentSource = signal(0);
const childSource = signal(0);
let parentRuns = 0;
let childRuns = 0;
let childCleanups = 0;
const stopParent = effect(() => {
  parentSource.value;
  parentRuns += 1;
  effect(() => {
    childSource.value;
    childRuns += 1;
    return () => { childCleanups += 1; };
  });
});
childSource.value = 1;
assert.equal(childRuns, 2, "nested child effect must observe writes");
assert.equal(childCleanups, 1, "child rerun must invoke its prior cleanup");
parentSource.value = 1;
assert.equal(parentRuns, 2, "parent effect must rerun");
assert.equal(childRuns, 3, "parent rerun must recreate child effect once");
assert.equal(childCleanups, 2, "parent rerun must dispose the previous child first");
stopParent();
assert.equal(childCleanups, 3, "disposing the parent must dispose its child");

console.log("M1.5 bare Alien-derived Stage 2 checks passed");
