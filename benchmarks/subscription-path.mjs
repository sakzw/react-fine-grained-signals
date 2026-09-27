import { effect, signal } from "../dist/index.js";

const ITERATIONS = 20_000;
const interopKey = Symbol.for("react-fine-grained-signals.readable-interop.v1");

function measure(name, subscribe) {
  const source = signal(0);
  let notifications = 0;
  const started = performance.now();
  const disposers = Array.from({ length: ITERATIONS }, () => subscribe(source, () => notifications++));
  source.value = 1;
  for (const dispose of disposers) dispose();
  const elapsedMs = performance.now() - started;
  console.log(`${name}: ${Math.round(ITERATIONS / elapsedMs * 1000).toLocaleString()} subscriptions/s; notifications=${notifications}`);
}

measure("effect bridge", (source, listener) => {
  let initial = true;
  return effect(() => {
    source.value;
    if (!initial) listener();
    initial = false;
  });
});

measure("ReadableInterop V1", (source, listener) => {
  const protocol = source[interopKey];
  if (protocol?.version !== 1) throw new Error("ReadableInterop V1 missing from built runtime");
  return protocol.subscribe(listener).unsubscribe;
});
