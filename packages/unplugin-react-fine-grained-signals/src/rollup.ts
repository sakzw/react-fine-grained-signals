import { createBundlerPlugin, type BundlerTransformOutput } from "./unplugin.js";

export * from "./unplugin.js";

/** A minimal Rollup-compatible plugin shape. */
export interface RollupPlugin {
  name: string;
  // Rollup has no `enforce` concept: unplugin passes the field through and
  // Rollup ignores it, so ordering under Rollup is decided solely by this
  // plugin's position in the `plugins` array and the consumer has to place it
  // before any plugin that compiles JSX away. Vite is where `enforce: "pre"`
  // actually does something.
  enforce?: "pre" | "post";
  transform?: (code: string, id: string) => BundlerTransformOutput;
}

export default createBundlerPlugin<RollupPlugin>("rollup");
