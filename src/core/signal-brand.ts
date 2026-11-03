/**
 * Package-wide identity marker shared by public signal wrappers and deep proxies.
 *
 * Copies of the package do not interoperate, so the brand does not make a
 * foreign signal usable: a brand this copy did not create identifies a signal
 * from another loaded copy, and `isSignal` throws for it. The key is shared
 * through the global symbol registry, so it must stay the same in every later
 * release for a mix of releases to be detected.
 */
export const SIGNAL_BRAND: unique symbol = Symbol.for("react-fine-grained-signals.brand");

/**
 * Stamps the brand on one instance. Non-enumerable keeps it out of JSON,
 * `Object.keys`, spread, and React's prop diffing; non-writable and
 * non-configurable keep it from being retargeted or stripped once the value is
 * public. The hardening is free: measured against a writable/configurable
 * descriptor the cost is identical, because it is the `defineProperty` call
 * itself, and V8 keeps the instance in fast properties either way (checked
 * with `%HasFastProperties`). Stamping the prototype instead would be worse —
 * that pushes the prototype into dictionary mode, which every lookup through
 * it then pays for.
 */
export function stampSignalBrand(value: object): void {
  // The attributes a descriptor leaves out default to false.
  Object.defineProperty(value, SIGNAL_BRAND, { value: true });
}
