const adapterReadLoop = (source, iterations, read) => {
  let sum = 0;
  for (let index = 0; index < iterations; index += 1) sum += read(source);
  return sum;
};

const rfsgDirectReadLoop = (source, iterations) => {
  let sum = 0;
  for (let index = 0; index < iterations; index += 1) sum += source.value;
  return sum;
};

function adaptRfsg(api, runtimeId, signal = api.signal, computed = api.computed) {
  return {
    runtimeId,
    signal,
    read: (source) => source.value,
    write: (source, value) => { source.value = value; },
    computed,
    readComputed: (value) => value.value,
    effect: (fn) => api.effect(fn),
    dispose: (stop) => stop(),
    batch: api.batch,
    supportsBatch: true,
    directReadLoop: rfsgDirectReadLoop,
    adapterReadLoop: (source, count) => adapterReadLoop(source, count, (value) => value.value),
    deepSignal: api.deepSignal,
  };
}

export async function loadAdapter(runtimeId) {
  const directReadLoop = (source, iterations) => {
    let sum = 0;
    if (runtimeId === "alien-signals") {
      for (let index = 0; index < iterations; index += 1) sum += source();
    } else {
      for (let index = 0; index < iterations; index += 1) sum += source.value;
    }
    return sum;
  };

  switch (runtimeId) {
    case "rfsg-W0": {
      const api = await import("./source-hot-path/variants/W0/dist/index.js");
      return adaptRfsg(api, runtimeId);
    }
    case "rfsg-v0.1.1": {
      const api = await import("react-fine-grained-signals");
      return {
        runtimeId,
        signal: (value) => api.signal(value),
        read: (source) => source.value,
        write: (source, value) => { source.value = value; },
        computed: (fn) => api.computed(fn),
        readComputed: (value) => value.value,
        effect: (fn) => api.effect(fn),
        dispose: (stop) => stop(),
        batch: api.batch,
        supportsBatch: true,
        directReadLoop,
        adapterReadLoop: (source, count) => adapterReadLoop(source, count, (value) => value.value),
        deepSignal: (value) => api.deepSignal(value),
      };
    }
    case "rfsg-current": {
      const api = await import("../../dist/index.js");
      return adaptRfsg(api, runtimeId);
    }
    case "rfsg-m153": {
      const api = await import("./m15/baselines/m153-53ea/dist/index.js");
      return adaptRfsg(api, runtimeId);
    }
    case "m154-c3": {
      const api = await import("../../dist/index.js");
      return adaptRfsg(api, runtimeId);
    }
    case "rfsg-pre-m15": {
      const api = await import("./m15/current-dist/index.js");
      return {
        runtimeId,
        signal: (value) => api.signal(value),
        read: (source) => source.value,
        write: (source, value) => { source.value = value; },
        computed: (fn) => api.computed(fn),
        readComputed: (value) => value.value,
        effect: (fn) => api.effect(fn),
        dispose: (stop) => stop(),
        batch: api.batch,
        supportsBatch: true,
        directReadLoop,
        adapterReadLoop: (source, count) => adapterReadLoop(source, count, (value) => value.value),
        deepSignal: (value) => api.deepSignal(value),
      };
    }
    case "rfsg-m151-owner": {
      const api = await import("./m15/bundled/candidate/m15-candidate.js");
      return {
        runtimeId,
        signal: api.signalClassBrandHelper,
        read: (source) => source.value,
        write: (source, value) => { source.value = value; },
        computed: api.computedClassBrandHelper,
        readComputed: (value) => value.value,
        effect: api.effect,
        dispose: (stop) => stop(),
        batch: api.batch,
        supportsBatch: true,
        directReadLoop(source, count) { let sum = 0; for (let index = 0; index < count; index += 1) sum += source.value; return sum; },
        adapterReadLoop(source, count) { let sum = 0; for (let index = 0; index < count; index += 1) sum += source.value; return sum; },
        deepSignal: api.deepSignal,
      };
    }
    case "alien-signals": {
      const api = await import("alien-signals");
      return {
        runtimeId,
        signal: (value) => api.signal(value),
        read: (source) => source(),
        write: (source, value) => { source(value); },
        computed: (fn) => api.computed(fn),
        readComputed: (value) => value(),
        effect: (fn) => api.effect(fn),
        dispose: (stop) => stop(),
        batch: (fn) => {
          api.startBatch();
          try { return fn(); } finally { api.endBatch(); }
        },
        supportsBatch: true,
        directReadLoop,
        adapterReadLoop: (source, count) => adapterReadLoop(source, count, (value) => value()),
        deepSignal: undefined,
      };
    }
    case "vue-reactivity": {
      const api = await import("@vue/reactivity");
      return {
        runtimeId,
        signal: (value) => api.shallowRef(value),
        read: (source) => source.value,
        write: (source, value) => { source.value = value; },
        computed: (fn) => api.computed(fn),
        readComputed: (value) => value.value,
        effect: (fn) => {
          const runner = api.effect(fn);
          return () => api.stop(runner);
        },
        dispose: (stop) => stop(),
        batch: undefined,
        supportsBatch: false,
        directReadLoop,
        adapterReadLoop: (source, count) => adapterReadLoop(source, count, (value) => value.value),
        deepSignal: undefined,
      };
    }
    default:
      throw new Error(`Unknown runtime: ${runtimeId}`);
  }
}
