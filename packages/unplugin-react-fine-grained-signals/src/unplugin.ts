import { createUnplugin, type TransformResult } from "unplugin";
import {
  transformReactFineGrainedSignals,
  type ReactFineGrainedSignalsMode,
  type ReactFineGrainedSignalsReactCompiler,
  type ReactFineGrainedSignalsTransform,
  type InternalTransformResult,
} from "./internal/transform.js";

export type {
  ReactFineGrainedSignalsMode,
  ReactFineGrainedSignalsReactCompiler,
  ReactFineGrainedSignalsTransform,
} from "./internal/transform.js";

export interface ReactFineGrainedSignalsOptions {
  /**
   * `manual` preserves explicit useSignals() opt-in. `auto` detects signal
   * reads in components and custom hooks; `all` also wraps JSX components that
   * do not statically expose a .value read.
   */
  mode?: ReactFineGrainedSignalsMode;
  /** `managed` (default) adds an exact try/finally boundary; `inject` adds bare useSignals() for best-effort opt-in. */
  transform?: ReactFineGrainedSignalsTransform;
  /**
   * `auto` (default) marks every transformed function with `"use no memo"`, so
   * React Compiler cannot memoize away the signal reads render tracking needs.
   * `off` omits the directive; only choose it when the compiler is not used, or
   * when its memoization has been verified against this library's tracking.
   */
  reactCompiler?: ReactFineGrainedSignalsReactCompiler;
  /** Package that exports `useSignals` and its `/runtime` entry. */
  importSource?: string;
  /**
   * Extra module specifier whose `memo`/`forwardRef` exports are treated as
   * React's own, for a codebase that imports them through one stable internal
   * module instead of directly from `"react"`. Recognition is additive: a
   * direct `"react"` import always counts, so this only widens detection.
   * It does not resolve arbitrary re-export chains, and it cannot cover
   * relative barrel paths that differ per importing file.
   */
  reactImportSource?: string;
  /** Restrict transformation to matching source module identifiers. */
  include?: (id: string) => boolean;
  /** Exclude matching source module identifiers from transformation. */
  exclude?: (id: string) => boolean;
}

const SCRIPT_MODULE = /\.[cm]?[jt]sx?(?:\?.*)?$/;

export function canTransform(id: string, options: ReactFineGrainedSignalsOptions): boolean {
  if (id.includes("/node_modules/") || id.includes("\\node_modules\\")) {
    return false;
  }
  if (!SCRIPT_MODULE.test(id)) return false;
  if (options.exclude?.(id)) return false;
  return options.include?.(id) ?? true;
}

export const reactFineGrainedSignals = createUnplugin<ReactFineGrainedSignalsOptions>(
  (options = {}) => ({
    name: "unplugin-react-fine-grained-signals",
    enforce: "pre",
    transformInclude(id) {
      return canTransform(id, options);
    },
    transform(code, id): InternalTransformResult | null {
      return transformReactFineGrainedSignals(code, id, {
        importSource: options.importSource ?? "react-fine-grained-signals",
        reactImportSource: options.reactImportSource ?? "react",
        mode: options.mode ?? "auto",
        transform: options.transform ?? "managed",
        reactCompiler: options.reactCompiler ?? "auto",
      });
    },
  }),
);

export default reactFineGrainedSignals;

/**
 * The `{ code, map }` shape a bundler's `transform` hook returns on a real
 * change, `null` on none. Derived from unplugin's own `TransformResult`
 * (rather than naming the source-map types by hand) so the accepted `map`
 * shape -- a real source map object when `sourceMaps: true` produces one, not
 * only `null` -- always matches what unplugin itself expects, and follows
 * unplugin's own type surface if that ever changes.
 */
export type BundlerTransformOutput = Extract<TransformResult, { code: string }> | null;

/**
 * The one piece every per-bundler entry file (`vite.ts`, `webpack.ts`,
 * `rollup.ts`, `esbuild.ts`, `rspack.ts`) repeated: casting `reactFineGrainedSignals`'s
 * `bundler` property to a callable factory of its own bundler-specific plugin
 * type. Each entry file supplies only the two things that actually differ
 * between bundlers -- which property to read and what shape it returns.
 */
export function createBundlerPlugin<Plugin>(
  bundler: "vite" | "webpack" | "rollup" | "esbuild" | "rspack",
): (options?: ReactFineGrainedSignalsOptions) => Plugin {
  return reactFineGrainedSignals[bundler] as (options?: ReactFineGrainedSignalsOptions) => Plugin;
}
