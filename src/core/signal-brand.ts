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
