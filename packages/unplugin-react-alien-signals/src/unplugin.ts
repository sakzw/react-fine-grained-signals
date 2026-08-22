import { createUnplugin } from "unplugin";
import {
  transformReactAlienSignals,
  type ReactAlienSignalsMode,
  type InternalTransformResult,
} from "./internal/transform.js";

export type { ReactAlienSignalsMode } from "./internal/transform.js";

export interface ReactAlienSignalsOptions {
  /**
   * `manual` preserves explicit useSignals() opt-in. `auto` detects signal
   * reads in components and custom hooks; `all` also wraps JSX components that
   * do not statically expose a .value read.
   */
  mode?: ReactAlienSignalsMode;
  /** Package that exports `useSignals` and its `/runtime` entry. */
  importSource?: string;
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
        mode: options.mode ?? "auto",
      });
    },
  }),
);

export default reactAlienSignals;
