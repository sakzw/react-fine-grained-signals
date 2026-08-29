import { createBundlerPlugin, type BundlerTransformOutput } from "./unplugin.js";

export * from "./unplugin.js";

/** A minimal Rollup-compatible plugin shape. */
export interface RollupPlugin {
  name: string;
  enforce?: "pre" | "post";
  transform?: (code: string, id: string) => BundlerTransformOutput;
}

export default createBundlerPlugin<RollupPlugin>("rollup");
