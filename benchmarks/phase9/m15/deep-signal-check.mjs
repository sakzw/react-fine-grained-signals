import assert from "node:assert/strict";
import * as runtime from "./alien-derived-runtime-candidate.mjs";
const { computedClassBrandHelper: computed, effect, signalClassBrandHelper: signal, deepSignal } = runtime;

const state = deepSignal({ user: { name: "Ada", age: 36 }, unused: 0 });
const names = [];
const dispose = effect(() => names.push(state.value.user.name));
state.value.user.name = "Grace";
assert.deepEqual(names, ["Ada", "Grace"], "nested property writes notify only through its version source");
state.value = { user: { name: "Lin", age: 37 }, unused: 1 };
assert.deepEqual(names, ["Ada", "Grace", "Lin"], "root replacement reconnects nested proxies");
dispose();

const choose = signal(true);
const branch = deepSignal({ left: "L", right: "R" });
const selected = computed(() => choose.value ? branch.value.left : branch.value.right);
const values = [];
const stop = effect(() => values.push(selected.value));
branch.value.left = "L2";
choose.value = false;
const afterSwitch = values.length;
branch.value.left = "ignored";
assert.equal(values.length, afterSwitch, "dynamic branch cleanup releases the old property dependency");
branch.value.right = "R2";
assert.equal(values.at(-1), "R2");
stop();

const untracked = deepSignal({ nested: { value: 1 } });
let untrackedRuns = 0;
const stopUntracked = effect(() => { untracked.peek().nested.value; untrackedRuns += 1; });
untracked.value.nested.value = 2;
assert.equal(untrackedRuns, 1, "peek returns a non-tracking raw snapshot");
stopUntracked();

console.log("M1.5 minimal deepSignal semantics passed.");
