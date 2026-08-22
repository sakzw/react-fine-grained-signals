import { useSignals } from "../src/index.js";

function TypeContract() {
  const result: void = useSignals();
  // @ts-expect-error useSignals does not accept explicit sources.
  useSignals({});
  // @ts-expect-error void is intentionally not a value-returning API.
  const undefinedResult: undefined = useSignals();

  void [result, undefinedResult];
}

void TypeContract;
