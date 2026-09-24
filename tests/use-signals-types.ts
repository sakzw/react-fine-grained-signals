import { useSignalTracking } from "../src/index.js";

function TypeContract() {
  const result: void = useSignalTracking();
  // @ts-expect-error useSignalTracking does not accept explicit sources.
  useSignalTracking({});
  // @ts-expect-error void is intentionally not a value-returning API.
  const undefinedResult: undefined = useSignalTracking();

  void [result, undefinedResult];
}

void TypeContract;
