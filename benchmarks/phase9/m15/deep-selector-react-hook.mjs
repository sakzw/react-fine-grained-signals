import { useMemo, useRef, useSyncExternalStore } from "react";

export function createSignalValueHook(runtime) {
  return function useSignalValue(source) {
    const subscribe = useMemo(() => (notify) => {
      let initial = true;
      return runtime.effect(() => {
        source.value;
        if (initial) initial = false;
        else notify();
      });
    }, [source]);
    const snapshot = useMemo(() => () => source.value, [source]);
    return useSyncExternalStore(subscribe, snapshot, snapshot);
  };
}

export function createDeepSelectorHook(runtime) {
  return function useDeepSignalValue(source, selector, dependencies = []) {
    const initialLength = useRef(dependencies.length);
    if (dependencies.length !== initialLength.current) throw new Error("selector dependencies length changed");
    const store = useMemo(() => {
      const evaluate = () => {
        try {
          const value = selector(source.value);
          if ((typeof value === "object" && value !== null) || typeof value === "function") {
            throw new TypeError("selector must return a primitive snapshot");
          }
          return { kind: "value", value };
        } catch (error) { return { kind: "error", error }; }
      };
      let result = runtime.untracked(evaluate);
      const changed = (next) => result.kind !== next.kind
        || (result.kind === "value" && next.kind === "value" && !Object.is(result.value, next.value))
        || (result.kind === "error" && next.kind === "error" && !Object.is(result.error, next.error));
      return {
        getSnapshot() { if (result.kind === "error") throw result.error; return result.value; },
        subscribe(notify) {
          let initial = true;
          return runtime.effect(() => {
            const next = evaluate();
            const didChange = changed(next);
            result = next;
            if (initial) initial = false;
            else if (didChange) notify();
          });
        },
      };
    }, [source, ...dependencies]);
    return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  };
}
