import { createBundlerPlugin } from "./unplugin.js";

export * from "./public.js";

/** The compiler-plugin contract used by webpack. */
export interface WebpackPlugin {
  apply(compiler: unknown): void;
}

export default createBundlerPlugin<WebpackPlugin>("webpack");
