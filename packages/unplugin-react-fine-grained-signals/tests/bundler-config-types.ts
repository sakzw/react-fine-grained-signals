// Type-only check, run by `pnpm typecheck:transform` (not by Vitest): each entry's
// plugin fits its bundler's own config type. Rollup 4's `ExistingRawSourceMap`
// wants `sourcesContent: string[]`; a `transform` typed with unplugin's
// `SourceMapCompact` (`(string | null)[]`) made `RollupOptions` fail with TS2322.
import type { Configuration as RspackConfiguration } from "@rspack/core";
import type { BuildOptions } from "esbuild";
import type { RollupOptions } from "rollup";
import type { PluginOption, UserConfig } from "vite";
import type { Configuration as WebpackConfiguration } from "webpack";
import esbuildSignals from "../src/esbuild.js";
import reactFineGrainedSignals from "../src/index.js";
import rollupSignals from "../src/rollup.js";
import rspackSignals from "../src/rspack.js";
import viteSignals from "../src/vite.js";
import webpackSignals from "../src/webpack.js";

export const rollupConfig: RollupOptions = { plugins: [rollupSignals({ mode: "auto" })] };
export const viteConfig: UserConfig = { plugins: [viteSignals({ mode: "auto" })] };
export const vitePlugin: PluginOption = reactFineGrainedSignals.vite({ mode: "auto" });
export const webpackConfig: WebpackConfiguration = { plugins: [webpackSignals({ mode: "auto" })] };
export const rspackConfig: RspackConfiguration = { plugins: [rspackSignals({ mode: "auto" })] };
export const esbuildConfig: BuildOptions = { plugins: [esbuildSignals({ mode: "auto" })] };
