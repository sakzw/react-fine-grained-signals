import { computed, deepSignal, effect, untracked } from "../dist/index.js";

const ITERATIONS = 5_000;
const retainedSelector = (value) => value.user.name;
const interopKey = Symbol.for("react-fine-grained-signals.readable-interop.v1");

function evaluate(source, selector) {
  try {
    const value = selector(source.value);
    if ((typeof value === "object" && value !== null) || typeof value === "function") {
      throw new TypeError("selector result must be primitive");
    }
    return { kind: "value", value };
  } catch (error) {
    return { kind: "error", error };
  }
}

// Previous selector-store shape: cached result plus a dynamically tracked effect.
function createEffectStore(source, selector, notify) {
  let result = evaluate(source, selector);
  const dispose = effect(() => {
    const next = evaluate(source, selector);
    const changed = result.kind !== next.kind ||
      (result.kind === "value" && next.kind === "value" && !Object.is(result.value, next.value)) ||
      (result.kind === "error" && next.kind === "error" && !Object.is(result.error, next.error));
    if (changed) {
      result = next;
      notify();
    }
  });
  return {
    snapshot() {
      if (result.kind === "error") throw result.error;
      return result.value;
    },
    dispose,
  };
}

// Candidate M2 shape: memoized computed selector plus the M1 V1 subscription.
function createComputedStore(source, selector, notify) {
  const derived = computed(() => {
    const value = selector(source.value);
    if ((typeof value === "object" && value !== null) || typeof value === "function") {
      throw new TypeError("selector result must be primitive");
    }
    return value;
  });
  untracked(() => derived.value);
  const protocol = derived[interopKey];
  const subscription = protocol.subscribe(notify);
  return {
    snapshot: () => untracked(() => derived.value),
    dispose: () => subscription.unsubscribe(),
  };
}

function timed(label, callback) {
  const started = performance.now();
  const result = callback();
  const elapsed = performance.now() - started;
  console.log(`${label}: ${elapsed.toFixed(2)} ms (${Math.round(result.operations / elapsed * 1000).toLocaleString()} ops/s); selector evaluations=${result.evaluations}; notifications=${result.notifications}`);
}

function mountAndDispose(createStore) {
  let evaluations = 0;
  let notifications = 0;
  for (let i = 0; i < ITERATIONS; i += 1) {
    const source = deepSignal({ user: { name: "Ada", age: 36 }, useLeft: true, left: "L", right: "R" });
    const store = createStore(source, (value) => { evaluations += 1; return value.user.name; }, () => { notifications += 1; });
    store.snapshot();
    store.dispose();
  }
  return { operations: ITERATIONS, evaluations, notifications };
}

function selectedUpdates(createStore) {
  const source = deepSignal({ user: { name: "Ada", age: 36 } });
  let evaluations = 0;
  let notifications = 0;
  const store = createStore(source, (value) => { evaluations += 1; return value.user.name; }, () => { notifications += 1; });
  for (let i = 0; i < ITERATIONS; i += 1) source.value.user.name = `name-${i}`;
  store.dispose();
  return { operations: ITERATIONS, evaluations, notifications };
}

function siblingUpdates(createStore) {
  const source = deepSignal({ user: { name: "Ada", age: 36 } });
  let evaluations = 0;
  let notifications = 0;
  const store = createStore(source, (value) => { evaluations += 1; return value.user.name; }, () => { notifications += 1; });
  for (let i = 0; i < ITERATIONS; i += 1) source.value.user.age = i;
  store.dispose();
  return { operations: ITERATIONS, evaluations, notifications };
}

function branchSwitches(createStore) {
  const source = deepSignal({ useLeft: true, left: { name: "Ada" }, right: { name: "Grace" } });
  let evaluations = 0;
  let notifications = 0;
  const store = createStore(source, (value) => {
    evaluations += 1;
    return value.useLeft ? value.left.name : value.right.name;
  }, () => { notifications += 1; });
  for (let i = 0; i < ITERATIONS; i += 1) source.value.useLeft = !source.value.useLeft;
  store.dispose();
  return { operations: ITERATIONS, evaluations, notifications };
}

function retainedHeap(createStore) {
  const count = 3_000;
  const source = deepSignal({ user: { name: "Ada" } });
  const stores = [];
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < count; i += 1) stores.push(createStore(source, retainedSelector, () => {}));
  globalThis.gc();
  const retainedBytes = process.memoryUsage().heapUsed - before;
  for (const store of stores) store.dispose();
  stores.length = 0;
  globalThis.gc();
  return { count, bytesPerStore: retainedBytes / count };
}

console.log(`Node ${process.version}; ${ITERATIONS.toLocaleString()} iterations per case`);
for (const [label, createStore] of [["effect store", createEffectStore], ["computed + V1", createComputedStore]]) {
  timed(`${label} mount/create + dispose`, () => mountAndDispose(createStore));
  timed(`${label} selected update`, () => selectedUpdates(createStore));
  timed(`${label} unrelated sibling update`, () => siblingUpdates(createStore));
  timed(`${label} branch switch`, () => branchSwitches(createStore));
  const heap = retainedHeap(createStore);
  console.log(`${label} retained subscription heap: ${heap.bytesPerStore.toFixed(1)} B/store (${heap.count.toLocaleString()} live stores; approximate process heap delta)`);
}
