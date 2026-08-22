import reactAlienSignals from "./unplugin.js";
import type { ReactAlienSignalsOptions } from "./unplugin.js";

export { canTransform, type ReactAlienSignalsMode, type ReactAlienSignalsOptions } from "./unplugin.js";

/** The compiler-plugin contract used by webpack. */
export interface WebpackPlugin {
  apply(compiler: unknown): void;
}

const webpackPlugin = reactAlienSignals.webpack as (options?: ReactAlienSignalsOptions) => WebpackPlugin;

export default webpackPlugin;
