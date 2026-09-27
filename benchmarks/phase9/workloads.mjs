const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const triangular = (count) => count * (count + 1) / 2;

export function createWorkload(kind, api, iterations, size = 1) {
  if (kind === "source-create") {
    return {
      setup: () => ({ last: undefined }),
      run(state) {
        for (let index = 0; index < iterations; index += 1) state.last = api.signal(index + 1);
      },
      verify(state) { assert(api.read(state.last) === iterations, "last created source has the wrong value"); },
    };
  }

  if (kind === "source-read") {
    return {
      setup: () => ({ source: api.signal(7), sum: 0 }),
      run(state) {
        let sum = 0;
        for (let index = 0; index < iterations; index += 1) sum += api.read(state.source);
        state.sum = sum;
      },
      verify(state) { assert(state.sum === iterations * 7, "read sum is incorrect"); },
    };
  }

  if (kind === "source-unobserved-write") {
    return {
      setup: () => ({ source: api.signal(0) }),
      run(state) {
        for (let index = 0; index < iterations; index += 1) api.write(state.source, index + 1);
      },
      verify(state) { assert(api.read(state.source) === iterations, "unobserved write lost the final value"); },
    };
  }

  if (kind === "source-write-read") {
    return {
      setup: () => ({ source: api.signal(0), sum: 0 }),
      run(state) {
        let sum = 0;
        for (let index = 0; index < iterations; index += 1) {
          api.write(state.source, index + 1);
          sum += api.read(state.source);
        }
        state.sum = sum;
      },
      verify(state) {
        assert(api.read(state.source) === iterations, "write/read final source is incorrect");
        assert(state.sum === triangular(iterations), "write/read sum is incorrect");
      },
    };
  }

  if (kind === "effect-create" || kind === "effect-create-dispose") {
    return {
      setup: () => ({ source: api.signal(1), runs: 0, stops: [] }),
      run(state) {
        for (let index = 0; index < iterations; index += 1) {
          const stop = api.effect(() => { api.read(state.source); state.runs += 1; });
          if (kind === "effect-create-dispose") api.dispose(stop);
          else state.stops.push(stop);
        }
      },
      verify(state) {
        assert(state.runs === iterations, "effect construction did not run once per effect");
        if (kind === "effect-create-dispose") {
          const before = state.runs;
          api.write(state.source, 2);
          assert(state.runs === before, "disposed effects still reacted");
        }
      },
      dispose(state) { for (const stop of state.stops) api.dispose(stop); },
    };
  }

  if (kind === "effect-observed-write") {
    return {
      setup() {
        const state = { source: api.signal(0), runs: 0 };
        state.stop = api.effect(() => { api.read(state.source); state.runs += 1; });
        return state;
      },
      run(state) {
        for (let index = 0; index < iterations; index += 1) api.write(state.source, index + 1);
      },
      verify(state) {
        assert(state.runs === iterations + 1, "observed write did not run synchronously once per change");
        const before = state.runs;
        api.dispose(state.stop);
        api.write(state.source, iterations + 1);
        assert(state.runs === before, "disposed observer still reacted");
      },
    };
  }

  if (kind === "effect-fanout") {
    return {
      setup() {
        const state = { source: api.signal(0), runs: 0, stops: [] };
        for (let index = 0; index < size; index += 1) {
          state.stops.push(api.effect(() => { api.read(state.source); state.runs += 1; }));
        }
        return state;
      },
      run(state) {
        for (let index = 0; index < iterations; index += 1) api.write(state.source, index + 1);
      },
      verify(state) { assert(state.runs === size * (iterations + 1), "fan-out notification count is incorrect"); },
      dispose(state) { for (const stop of state.stops) api.dispose(stop); },
    };
  }

  if (kind === "effect-dynamic") {
    return {
      setup() {
        const state = {
          selector: api.signal(0), left: api.signal(0), right: api.signal(0), runs: 0,
        };
        state.stop = api.effect(() => {
          state.value = api.read(state.selector) === 0 ? api.read(state.left) : api.read(state.right);
          state.runs += 1;
        });
        return state;
      },
      run(state) {
        for (let index = 0; index < iterations; index += 1) {
          const branch = (index % 2) === 0 ? 1 : 0;
          api.write(state.selector, branch);
          api.write(branch === 0 ? state.right : state.left, index + 10);
          api.write(branch === 0 ? state.left : state.right, index + 10);
        }
      },
      verify(state) {
        assert(state.runs === 1 + iterations * 2, "dynamic dependencies did not run on selector and active source changes");
        const before = state.runs;
        const selected = api.read(state.selector) === 0 ? state.left : state.right;
        const stale = selected === state.left ? state.right : state.left;
        api.write(stale, -1);
        assert(state.runs === before, "dynamic dependency remained subscribed to the old branch");
        api.write(selected, -2);
        assert(state.runs === before + 1, "dynamic dependency stopped tracking the selected branch");
        api.dispose(state.stop);
      },
    };
  }

  if (kind === "computed-create") {
    return {
      setup: () => ({ source: api.signal(3), last: undefined, evaluations: 0 }),
      run(state) {
        for (let index = 0; index < iterations; index += 1) {
          state.last = api.computed(() => { state.evaluations += 1; return api.read(state.source) + 1; });
        }
      },
      verify(state) {
        assert(state.evaluations === 0, "computed creation eagerly evaluated the getter");
        assert(api.readComputed(state.last) === 4, "last created computed returned an incorrect value");
        assert(state.evaluations === 1, "reading a lazy computed did not evaluate once");
      },
    };
  }

  if (kind === "computed-dirty-read") {
    return {
      setup() {
        const state = { source: api.signal(0), sum: 0 };
        state.value = api.computed(() => api.read(state.source) * 2);
        return state;
      },
      run(state) {
        let sum = 0;
        for (let index = 0; index < iterations; index += 1) {
          api.write(state.source, index + 1);
          sum += api.readComputed(state.value);
        }
        state.sum = sum;
      },
      verify(state) {
        assert(api.readComputed(state.value) === iterations * 2, "dirty/read computed value is incorrect");
        assert(state.sum === iterations * (iterations + 1), "dirty/read sum is incorrect");
      },
    };
  }

  if (kind === "computed-dirty-unread") {
    return {
      setup() {
        const state = { source: api.signal(0), evaluations: 0 };
        state.value = api.computed(() => { state.evaluations += 1; return api.read(state.source); });
        assert(api.readComputed(state.value) === 0, "computed initial value is incorrect");
        return state;
      },
      run(state) {
        for (let index = 0; index < iterations; index += 1) api.write(state.source, index + 1);
      },
      verify(state) {
        assert(state.evaluations === 1, "dirty/unread computed evaluated before it was read");
        assert(api.readComputed(state.value) === iterations, "dirty/unread computed final value is incorrect");
        assert(state.evaluations === 2, "dirty/unread computed should settle once on its final read");
      },
    };
  }

  if (kind === "computed-equality") {
    return {
      setup() {
        const state = { source: api.signal(0), runs: 0 };
        state.value = api.computed(() => Math.floor(api.read(state.source) / 2));
        state.stop = api.effect(() => { api.readComputed(state.value); state.runs += 1; });
        return state;
      },
      run(state) {
        for (let index = 0; index < iterations; index += 1) api.write(state.source, index + 1);
      },
      verify(state) {
        assert(api.readComputed(state.value) === Math.floor(iterations / 2), "equality computed result is incorrect");
        assert(state.runs === 1 + Math.floor(iterations / 2), "equal computed values did not suppress downstream effects");
        api.dispose(state.stop);
      },
    };
  }

  if (kind === "computed-fanout") {
    return {
      setup() {
        const state = { source: api.signal(0), sum: 0, values: [] };
        for (let index = 0; index < size; index += 1) {
          state.values.push(api.computed(() => api.read(state.source) * (index + 1)));
        }
        return state;
      },
      run(state) {
        let sum = 0;
        for (let tick = 0; tick < iterations; tick += 1) {
          api.write(state.source, tick + 1);
          for (const value of state.values) sum += api.readComputed(value);
        }
        state.sum = sum;
      },
      verify(state) {
        const factor = size * (size + 1) / 2;
        assert(state.sum === triangular(iterations) * factor, "source-to-many computed sum is incorrect");
      },
    };
  }

  if (kind === "computed-fanin") {
    return {
      setup() {
        const state = { sources: [], value: undefined };
        for (let index = 0; index < size; index += 1) state.sources.push(api.signal(0));
        state.value = api.computed(() => state.sources.reduce((sum, source) => sum + api.read(source), 0));
        return state;
      },
      run(state) {
        for (let tick = 0; tick < iterations; tick += 1) {
          api.write(state.sources[tick % size], tick + 1);
          api.readComputed(state.value);
        }
      },
      verify(state) {
        const sum = state.sources.reduce((total, source) => total + api.read(source), 0);
        assert(api.readComputed(state.value) === sum, "many-to-one computed did not match its source sum");
      },
    };
  }

  if (kind === "batch-two-writes") {
    if (!api.supportsBatch) return { notApplicable: "Vue reactivity has no public multi-write transaction API." };
    return {
      setup() {
        const state = { left: api.signal(0), right: api.signal(0), runs: 0 };
        state.total = api.computed(() => api.read(state.left) + api.read(state.right));
        state.stop = api.effect(() => { api.readComputed(state.total); state.runs += 1; });
        return state;
      },
      run(state) {
        for (let index = 0; index < iterations; index += 1) {
          api.batch(() => {
            api.write(state.left, index + 1);
            api.write(state.right, index + 1);
          });
        }
      },
      verify(state) {
        assert(api.readComputed(state.total) === iterations * 2, "batched total is incorrect");
        assert(state.runs === iterations + 1, "batch did not coalesce to one downstream reaction");
        api.dispose(state.stop);
      },
    };
  }

  if (kind === "deep-read") {
    if (typeof api.deepSignal !== "function") return { notApplicable: "deepSignal is an RFSG-specific API." };
    return {
      setup: () => ({ state: api.deepSignal({ branch: { leaf: 7 } }), sum: 0 }),
      run(state) {
        let sum = 0;
        for (let index = 0; index < iterations; index += 1) sum += state.state.value.branch.leaf;
        state.sum = sum;
      },
      verify(state) { assert(state.sum === iterations * 7, "deepSignal leaf read sum is incorrect"); },
    };
  }

  if (kind === "deep-watched-write") {
    if (typeof api.deepSignal !== "function") return { notApplicable: "deepSignal is an RFSG-specific API." };
    return {
      setup() {
        const state = { proxy: api.deepSignal({ branch: { leaf: 0 } }), runs: 0 };
        state.stop = api.effect(() => { state.proxy.value.branch.leaf; state.runs += 1; });
        return state;
      },
      run(state) {
        for (let index = 0; index < iterations; index += 1) state.proxy.value.branch.leaf = index + 1;
      },
      verify(state) {
        assert(state.proxy.value.branch.leaf === iterations, "deepSignal watched leaf has the wrong final value");
        assert(state.runs === iterations + 1, "deepSignal watched leaf notification count is incorrect");
        api.dispose(state.stop);
      },
    };
  }

  throw new Error(`Unknown workload kind: ${kind}`);
}
