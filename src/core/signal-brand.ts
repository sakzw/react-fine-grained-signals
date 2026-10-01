/**
 * Package-wide identity marker shared by public signal wrappers and deep proxies.
 *
 * The key names a *generation* of the cross-copy contract; the number stored
 * under it is that generation's minor version. A minor version only ever widens
 * the contract, so anything from the minimum upwards is trusted; a change that
 * an older copy could not honour takes a new key instead.
 *
 * v0.1.x used `react-fine-grained-signals.signal` and trusted every version
 * from 1 upwards. A v0.2 signal is only reactive under the v2 shared execution
 * owner and the ReadableInterop V1 protocol, neither of which a v0.1.x copy
 * knows, so reusing that key with a larger number would have let v0.1.x
 * recognize v0.2 signals (and v0.2 recognize v0.1.x ones) and then silently
 * never update. A separate key makes each generation reject the other's
 * signals outright: JSX and `isSignal` fail loudly instead of going stale.
 */
export const SIGNAL_BRAND: unique symbol = Symbol.for("react-fine-grained-signals.signal.v2");
export const SIGNAL_BRAND_VERSION = 1;
export const SIGNAL_BRAND_MIN_VERSION = 1;

/** The v0.1.x key, kept only to report an incompatible signal clearly. */
export const LEGACY_SIGNAL_BRAND_V1 = Symbol.for("react-fine-grained-signals.signal");
