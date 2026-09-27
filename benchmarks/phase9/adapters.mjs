const adapterReadLoop = (source, iterations, read) => {
  let sum = 0;
  for (let index = 0; index < iterations; index += 1) sum += read(source);
  return sum;
};

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
