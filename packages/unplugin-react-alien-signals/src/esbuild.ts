import reactAlienSignals from "./unplugin.js";
import type { ReactAlienSignalsOptions } from "./unplugin.js";

export {
  canTransform,
  type ReactAlienSignalsMode,
  type ReactAlienSignalsTransform,
  type ReactAlienSignalsOptions,
} from "./unplugin.js";

/** The plugin contract consumed by esbuild. */
export interface EsbuildPlugin {
  name: string;
  setup(build: unknown): void | Promise<void>;
}

const esbuildPlugin = reactAlienSignals.esbuild as (options?: ReactAlienSignalsOptions) => EsbuildPlugin;

export default esbuildPlugin;
