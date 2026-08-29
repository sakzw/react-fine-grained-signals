import { createBundlerPlugin } from "./unplugin.js";

export * from "./unplugin.js";

/** The compiler-plugin contract used by Rspack. */
export interface RspackPlugin {
  apply(compiler: unknown): void;
}

export default createBundlerPlugin<RspackPlugin>("rspack");
