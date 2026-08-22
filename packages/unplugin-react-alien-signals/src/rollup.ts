import reactAlienSignals from "./unplugin.js";
import type { ReactAlienSignalsOptions } from "./unplugin.js";

export { canTransform, type ReactAlienSignalsMode, type ReactAlienSignalsOptions } from "./unplugin.js";

/** A minimal Rollup-compatible plugin shape. */
export interface RollupPlugin {
  name: string;
  enforce?: "pre" | "post";
  transform?: (code: string, id: string) => { code: string; map?: null } | null;
}

const rollupPlugin = reactAlienSignals.rollup as (options?: ReactAlienSignalsOptions) => RollupPlugin;

export default rollupPlugin;
