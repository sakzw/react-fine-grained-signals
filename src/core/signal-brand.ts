/** Package-wide identity marker shared by public signal wrappers and deep proxies. */
export const SIGNAL_BRAND: unique symbol = Symbol.for("react-fine-grained-signals.signal");
