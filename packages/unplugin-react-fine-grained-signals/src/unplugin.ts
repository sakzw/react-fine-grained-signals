import { fileURLToPath } from "node:url";
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

// `.cjs`/`.cts` are declared-CommonJS by extension, and the transform's only
// codegen for a new binding is an ESM `import` statement: injecting one into a
// module that also uses `module.exports`/`require` produces a file that is
// either invalid or reinterpreted as ESM, which makes `module` undefined at
// runtime. Excluding them outright is the honest boundary -- an author who
// wants the transform on that code can move it to `.mjs`/`.js`.
const SCRIPT_MODULE = /\.m?[jt]sx?(?:\?.*)?$/;

export const pluginName = "unplugin-react-fine-grained-signals";

export function canTransform(id: string, options: ReactFineGrainedSignalsOptions): boolean {
  if (id.includes("/node_modules/") || id.includes("\\node_modules\\")) {
    return false;
  }
  if (!SCRIPT_MODULE.test(id)) return false;
  if (options.exclude?.(id)) return false;
  return options.include?.(id) ?? true;
}

/**
 * The esbuild loader names this plugin itself ever chooses. esbuild's own
 * `Loader` union is wider and is not importable here (esbuild is not a
 * dependency of this package), so a value read out of the project's configured
 * loader map is handed straight back and narrowed to this at the hook boundary.
 */
export type EsbuildLoaderName = "js" | "jsx" | "ts" | "tsx";

/**
 * `.js`/`.mjs` deliberately resolve to `"jsx"`. JavaScript commonly carries JSX
 * without a `.jsx` suffix -- the transform's own parser configuration says so,
 * and its output for such a file still contains that JSX -- but unplugin's
 * esbuild adapter labels every file it hands back with `guessLoader`, which
 * maps `.js` to `"js"` and so overrides a project's own
 * `loader: { ".js": "jsx" }` setting. Because that adapter returns
 * `{ contents, loader }` for every file passing `transformInclude`, even the
 * ones this transform declines to touch, a single wrong answer here breaks the
 * whole build rather than just one module.
 */
const ESBUILD_LOADERS: Record<string, EsbuildLoaderName> = {
  ".js": "jsx",
  ".mjs": "jsx",
  ".jsx": "jsx",
  ".ts": "ts",
  ".mts": "ts",
  ".tsx": "tsx",
};

/**
 * The loader to label `id`'s contents with, deferring to the build's own
 * `loader` map first so a project that configured an extension keeps its
 * choice. Exported for the adapter tests, which exercise the decision without
 * needing esbuild itself.
 */
export function resolveEsbuildLoader(
  id: string,
  configuredLoaders?: Record<string, string> | undefined,
): string {
  const cleanId = id.replace(/[?#].*$/, "");
  const extension = /\.[^./\\]*$/.exec(cleanId)?.[0].toLowerCase() ?? "";
  return configuredLoaders?.[extension] ?? ESBUILD_LOADERS[extension] ?? "js";
}

let transformLoaderPath: string | null | undefined;

/** The absolute path of this package's own webpack/rspack loader, if reachable. */
function resolveTransformLoaderPath(): string | null {
  if (transformLoaderPath === undefined) {
    try {
      transformLoaderPath = fileURLToPath(new URL("./loader.js", import.meta.url));
    } catch {
      transformLoaderPath = null;
    }
  }
  return transformLoaderPath;
}

interface WebpackLikeRule {
  enforce?: unknown;
  use?: unknown;
}

interface WebpackLikeCompiler {
  options?: { module?: { rules?: unknown[] | undefined } | undefined } | undefined;
}

const patchedMarker = "__reactFineGrainedSignalsLoaderPatched";

/** Is this the bare `{ enforce, use(data) }` rule unplugin adds for `transform`? */
function isUnpluginTransformRule(rule: unknown): rule is WebpackLikeRule {
  if (rule === null || typeof rule !== "object") return false;
  if (typeof (rule as WebpackLikeRule).use !== "function") return false;
  return Object.keys(rule).every((key) => key === "use" || key === "enforce");
}

/**
 * Repoints unplugin's webpack/rspack transform rule at this package's own
 * loader, which is the same loader with the source map passed through
 * correctly -- see `src/loader.ts` for why unplugin's copy drops it.
 *
 * The rule is rewritten rather than replaced: unplugin's `use(data)` still
 * decides *whether* this file is claimed (it applies `transformInclude` and
 * carries the plugin object along in `options`), and only the loader entries it
 * stamped with this plugin's `ident` have their module path swapped. Anything
 * that does not match that shape is left exactly as it was, so a future
 * unplugin release that restructures this simply gets its own behaviour back
 * instead of a broken build.
 */
function useOwnTransformLoader(compiler: unknown): void {
  const loaderPath = resolveTransformLoaderPath();
  if (loaderPath === null) return;
  const rules = (compiler as WebpackLikeCompiler | null)?.options?.module?.rules;
  if (!Array.isArray(rules)) return;
  for (const rule of rules) {
    if (!isUnpluginTransformRule(rule)) continue;
    const original = rule.use as ((data: unknown) => unknown) & { [patchedMarker]?: true };
    if (original[patchedMarker] === true) continue;
    const patched = (data: unknown): unknown => {
      const entries = original(data);
      if (!Array.isArray(entries)) return entries;
      return entries.map((entry) =>
        entry !== null &&
          typeof entry === "object" &&
          (entry as { ident?: unknown }).ident === pluginName
          ? { ...(entry as object), loader: loaderPath }
          : entry,
      );
    };
    patched[patchedMarker] = true;
    rule.use = patched;
  }
}

export const reactFineGrainedSignals = createUnplugin<ReactFineGrainedSignalsOptions>(
  (options = {}) => {
    // esbuild hands a plugin its resolved build options through the `config`
    // hook, which is the only place a project's own `loader` map can be read.
    let configuredLoaders: Record<string, string> | undefined;
    return {
      name: pluginName,
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
      esbuild: {
        config(buildOptions: { loader?: Record<string, string> | undefined }) {
          configuredLoaders = buildOptions.loader;
        },
        loader(_code: string, id: string) {
          return resolveEsbuildLoader(id, configuredLoaders) as EsbuildLoaderName;
        },
      },
      webpack: useOwnTransformLoader,
      rspack: useOwnTransformLoader,
    };
  },
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
