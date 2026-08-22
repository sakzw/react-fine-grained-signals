import reactAlienSignals from "./unplugin.js";
import type { ReactAlienSignalsOptions } from "./unplugin.js";

export {
  canTransform,
  type ReactAlienSignalsMode,
  type ReactAlienSignalsTransform,
  type ReactAlienSignalsOptions,
} from "./unplugin.js";

/** The compiler-plugin contract used by Rspack. */
export interface RspackPlugin {
  apply(compiler: unknown): void;
}

const rspackPlugin = reactAlienSignals.rspack as (options?: ReactAlienSignalsOptions) => RspackPlugin;

export default rspackPlugin;
