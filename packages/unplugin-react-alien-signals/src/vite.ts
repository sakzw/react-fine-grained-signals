import reactAlienSignals from "./unplugin.js";
import type { ReactAlienSignalsOptions } from "./unplugin.js";

export {
  canTransform,
  type ReactAlienSignalsMode,
  type ReactAlienSignalsTransform,
  type ReactAlienSignalsOptions,
} from "./unplugin.js";

/** A Rollup-compatible plugin shape also accepted by Vite. */
export interface VitePlugin {
  name: string;
  enforce?: "pre" | "post";
  transform?: (code: string, id: string) => { code: string; map?: null } | null;
}

const vitePlugin = reactAlienSignals.vite as (options?: ReactAlienSignalsOptions) => VitePlugin;

export default vitePlugin;
