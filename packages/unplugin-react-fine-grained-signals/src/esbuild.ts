import { createBundlerPlugin } from "./unplugin.js";

export * from "./unplugin.js";

/** The plugin contract consumed by esbuild. */
export interface EsbuildPlugin {
  name: string;
  setup(build: unknown): void | Promise<void>;
}

export default createBundlerPlugin<EsbuildPlugin>("esbuild");
