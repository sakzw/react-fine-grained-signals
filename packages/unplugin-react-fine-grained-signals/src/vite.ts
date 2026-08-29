import { createBundlerPlugin, type BundlerTransformOutput } from "./unplugin.js";

export * from "./unplugin.js";

/** A Rollup-compatible plugin shape also accepted by Vite. */
export interface VitePlugin {
  name: string;
  enforce?: "pre" | "post";
  transform?: (code: string, id: string) => BundlerTransformOutput;
}

export default createBundlerPlugin<VitePlugin>("vite");
