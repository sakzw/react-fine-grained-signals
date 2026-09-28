import assert from "node:assert/strict";
import { batch, computed, effect, signalClassBrandHelper as signal } from "./alien-derived-runtime-core.mjs";

const source = signal(0);
const sentinel = { tag: "stable computed failure" };
const recovered = computed(() => {
  const value = source.value;
  if (value === 1) throw sentinel;
  return value;
});
assert.equal(recovered.value, 0);
source.value = 1;
let first;
try { recovered.value; } catch (error) { first = error; }
let second;
try { recovered.peek(); } catch (error) { second = error; }
assert.equal(first, sentinel, "first read rethrows original error object");
assert.equal(second, sentinel, "later read rethrows the identical cached error object");
source.value = 2;
assert.equal(recovered.value, 2, "a previously tracked dependency can recover the computed");

const errorSource = signal(0);
const healthySource = signal(0);
const stableError = new Error("scheduled computed failed");
const scheduled = computed(() => {
  const value = errorSource.value;
  if (value === 1) throw stableError;
  return value;
});
let badEffectRuns = 0;
let healthyEffectRuns = 0;
const stopBad = effect(() => { scheduled.value; badEffectRuns += 1; });
const stopHealthy = effect(() => { healthySource.value; healthyEffectRuns += 1; });
const originalConsoleError = console.error;
const reported = [];
console.error = (...args) => reported.push(args);
try {
  batch(() => { errorSource.value = 1; healthySource.value = 1; });
  assert.equal(badEffectRuns, 1, "the failing effect aborts its own callback");
  assert.equal(healthyEffectRuns, 2, "the scheduler continues to the next queued effect");
  assert.equal(reported.length, 1, "the contained effect error is reported once");
  assert.equal(reported[0][1].cause, stableError, "the report preserves the original cause");
  errorSource.value = 2;
  assert.equal(badEffectRuns, 2, "the effect remains subscribed and runs after recovery");
} finally {
  stopBad();
  stopHealthy();
  console.error = originalConsoleError;
}
const rerunSource = signal(0);
const cleanupHealthySource = signal(0);
const rerunCleanupError = new Error("cleanup failed during rerun");
const disposeCleanupError = new Error("cleanup failed during dispose");
let rerunBodies = 0;
let healthyBodies = 0;
const reportCalls = [];
const previousConsoleError = console.error;
const reportErrorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "reportError");
console.error = (...args) => reportCalls.push(args);
globalThis.reportError = () => { throw new Error("host reporter failed"); };
const stopRerun = effect(() => {
  rerunSource.value;
  rerunBodies += 1;
  return () => { throw rerunCleanupError; };
});
const stopCleanupHealthy = effect(() => { cleanupHealthySource.value; healthyBodies += 1; });
try {
  assert.doesNotThrow(() => batch(() => { rerunSource.value = 1; cleanupHealthySource.value = 1; }));
  assert.equal(rerunBodies, 1, "a failing prior cleanup aborts only that rerun");
  assert.equal(healthyBodies, 2, "later queued effects still run after cleanup failure");
  assert.equal(reportCalls[0][1].cause, rerunCleanupError);
  assert.doesNotThrow(() => { rerunSource.value = 2; });
  assert.equal(rerunBodies, 2, "effect can run again after its failed cleanup was consumed");

  const stopDispose = effect(() => () => { throw disposeCleanupError; });
  assert.doesNotThrow(stopDispose, "disposing an effect must contain its cleanup error");
  assert.equal(reportCalls.some((args) => args[1]?.cause === disposeCleanupError), true);
  assert.equal(reportCalls.some((args) => args[1]?.cause === rerunCleanupError), true);

  const consoleFailure = new Error("console reporter failed");
  const hostReports = [];
  console.error = () => { throw consoleFailure; };
  globalThis.reportError = (error) => hostReports.push(error);
  const stopConsoleFailure = effect(() => () => { throw disposeCleanupError; });
  assert.doesNotThrow(stopConsoleFailure, "both reporters may fail without escaping cleanup");
  assert.deepEqual(hostReports, [disposeCleanupError], "host reporter is tried even when console reporting throws");
} finally {
  stopRerun();
  stopCleanupHealthy();
  console.error = previousConsoleError;
  if (reportErrorDescriptor) Object.defineProperty(globalThis, "reportError", reportErrorDescriptor);
  else delete globalThis.reportError;
}


const initialThrowSource = signal(0);
const initialBodyError = new Error("initial effect body failed");
let initialBodies = 0;
const initialReports = [];
const oldConsoleError = console.error;
const oldReportError = globalThis.reportError;
console.error = (...args) => initialReports.push(args);
globalThis.reportError = (error) => initialReports.push(["host", error]);
let stopInitial;
try {
  assert.doesNotThrow(() => {
    stopInitial = effect(() => {
      initialThrowSource.value;
      initialBodies += 1;
      if (initialBodies === 1) throw initialBodyError;
    });
  }, "an initial effect body error is contained");
  assert.equal(initialReports[0][0], "react-fine-grained-signals: an effect() callback threw; the error is contained and reported here so this flush can finish.");
  assert.equal(initialReports[0][1].cause, initialBodyError, "initial error uses the established console report contract");
  assert.equal(initialReports[1][1], initialBodyError, "initial error is forwarded to reportError");
  assert.doesNotThrow(() => { initialThrowSource.value = 1; });
  assert.equal(initialBodies, 2, "dependencies read before the initial throw remain subscribed");
} finally {
  stopInitial?.();
  console.error = oldConsoleError;
  if (oldReportError === undefined) delete globalThis.reportError;
  else globalThis.reportError = oldReportError;
}
console.log("Initial effect errors, computed recovery, flush continuation, and cleanup containment passed");
