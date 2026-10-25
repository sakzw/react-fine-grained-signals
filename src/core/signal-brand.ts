/**
 * Package-wide identity marker shared by public signal wrappers and deep proxies.
 *
 * Copies of the package do not interoperate, so the brand does not make a
 * foreign signal usable: a brand this copy did not create identifies a signal
 * from another loaded copy, and `isSignal` throws for it.
 *
 * The key names a *generation*: v0.1.x used `react-fine-grained-signals.signal`
 * and its signals never update under v0.2, so v0.2 uses a separate key and each
 * generation fails to recognize the other's signals rather than going stale.
 * The number stored under the key is that generation's version.
 */
export const SIGNAL_BRAND: unique symbol = Symbol.for("react-fine-grained-signals.signal.v2");
export const SIGNAL_BRAND_VERSION = 1;
export const SIGNAL_BRAND_MIN_VERSION = 1;
