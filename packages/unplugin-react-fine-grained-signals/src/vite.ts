import { createBundlerPlugin, type BundlerTransformOutput } from "./unplugin.js";

export * from "./unplugin.js";

/**
 * The Vite plugin shape this entry returns. Unlike the Rollup entry, `transform`
 * is an object hook carrying `order: "pre"`, which Vite uses to run it ahead of
 * other pre-enforced plugins' transforms -- notably `@vitejs/plugin-react`'s
 * React Compiler step -- regardless of their order in the `plugins` array
 * (see `src/unplugin.ts`).
 */
export interface VitePlugin {
  name: string;
  enforce?: "pre" | "post";
  transform?: {
    order: "pre";
    handler: (code: string, id: string) => BundlerTransformOutput;
  };
}

export default createBundlerPlugin<VitePlugin>("vite");
