import { createUnplugin } from "unplugin";
import {
  transformReactAlienSignals,
  type ReactAlienSignalsMode,
  type ReactAlienSignalsReactCompiler,
  type ReactAlienSignalsTransform,
  type InternalTransformResult,
} from "./internal/transform.js";

export type {
  ReactAlienSignalsMode,
  ReactAlienSignalsReactCompiler,
  ReactAlienSignalsTransform,
} from "./internal/transform.js";

export interface ReactAlienSignalsOptions {
  /**
   * `manual` preserves explicit useSignals() opt-in. `auto` detects signal
   * reads in components and custom hooks; `all` also wraps JSX components that
   * do not statically expose a .value read.
   */
  mode?: ReactAlienSignalsMode;
  /** `managed` (default) adds an exact try/finally boundary; `inject` adds bare useSignals() for best-effort opt-in. */
  transform?: ReactAlienSignalsTransform;
  /**
   * `auto` (default) marks every transformed function with `"use no memo"`, so
   * React Compiler cannot memoize away the signal reads render tracking needs.
   * `off` omits the directive; only choose it when the compiler is not used, or
   * when its memoization has been verified against this library's tracking.
   */
  reactCompiler?: ReactAlienSignalsReactCompiler;
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

export function canTransform(id: string, options: ReactAlienSignalsOptions): boolean {
  if (id.includes("/node_modules/") || id.includes("\\node_modules\\")) {
    return false;
  }
  if (!SCRIPT_MODULE.test(id)) return false;
  if (options.exclude?.(id)) return false;
  return options.include?.(id) ?? true;
}

export const reactAlienSignals = createUnplugin<ReactAlienSignalsOptions>(
  (options = {}) => ({
    name: "unplugin-react-alien-signals",
    enforce: "pre",
    transformInclude(id) {
      return canTransform(id, options);
    },
    transform(code, id): InternalTransformResult | null {
      return transformReactAlienSignals(code, id, {
        importSource: options.importSource ?? "react-alien-signals",
        reactImportSource: options.reactImportSource ?? "react",
        mode: options.mode ?? "auto",
        transform: options.transform ?? "managed",
        reactCompiler: options.reactCompiler ?? "auto",
      });
    },
  }),
);

export default reactAlienSignals;
