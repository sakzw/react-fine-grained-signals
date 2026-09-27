import { getReadableInterop } from "./interop.js";
import { notifyListener } from "./render-tracking.js";

/** Subscribe through the private V1 boundary without creating an EffectNode. */
export function subscribeReadableV1(
  readable: object,
  listener: () => void,
): (() => void) | undefined {
  const protocol = getReadableInterop(readable);
  if (protocol === undefined) return undefined;
  const subscription = protocol.subscribe(() => notifyListener(listener));
  return () => subscription.unsubscribe();
}
