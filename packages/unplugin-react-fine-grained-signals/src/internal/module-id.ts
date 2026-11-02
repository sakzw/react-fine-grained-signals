/**
 * How this package reads a module id: the bundler adapter decides which ids
 * to claim and the transform picks its parser plugins, and both have to look
 * at the same name or they disagree about one file.
 */

/**
 * `id` with the `?query`/`#fragment` a bundler appends taken off, which is
 * what both the adapter's claim and the transform's parser choice look at.
 *
 * Vite's `App.tsx?t=173...` HMR stamp and its SFC sub-request
 * `App.vue?vue&type=script&lang.tsx` both name a file by what precedes the
 * query, so that part alone decides the extension. Deciding on the raw id
 * instead diverges in both directions: the SFC sub-request ends in `.tsx`
 * only because its *query* does, so it would be claimed and then reach the
 * parser as `App.vue` -- with neither the `jsx` nor the `typescript` plugin
 * enabled -- and fail as though the author had written broken syntax;
 * `App.tsx#frag` ends in neither, so it would be skipped although the
 * transform handles it perfectly well.
 */
export function stripModuleIdQuery(id: string): string {
  return id.replace(/[?#].*$/, "");
}

/**
 * The esbuild loader names this plugin itself ever chooses. esbuild's own
 * `Loader` union is wider and is not importable here (esbuild is not a
 * dependency of this package).
 */
export type EsbuildLoaderName = "js" | "jsx" | "ts" | "tsx";

/**
 * Every extension the adapter claims, with the esbuild loader its contents are
 * labelled with: one table, so a claimed file always has a loader that parses
 * what the transform parses (each entry gets the same parser plugins from the
 * two patterns below).
 *
 * - `.cjs`/`.cts` are left out on purpose (see `isTransformCandidate` in
 *   `unplugin.ts`).
 * - `.mjsx`/`.mtsx` are left out too: no runtime or compiler gives them a
 *   meaning (TypeScript has `.mts` and `.tsx` but no `.mtsx`, Node has no
 *   `.mjsx`), and esbuild has no loader for them by default.
 * - `.js`/`.mjs` deliberately resolve to `"jsx"`. JavaScript commonly carries
 *   JSX without a `.jsx` suffix -- `JSX_EXTENSION` says so, and the
 *   transform's output for such a file still contains that JSX -- but
 *   unplugin's esbuild adapter labels every file it hands back with
 *   `guessLoader`, which maps `.js` to `"js"` and so overrides a project's own
 *   `loader: { ".js": "jsx" }` setting. Because that adapter returns
 *   `{ contents, loader }` for every file passing `transformInclude`, even the
 *   ones this transform declines to touch, a single wrong answer here breaks
 *   the whole build rather than just one module.
 */
const SCRIPT_MODULE_LOADERS: Readonly<Record<string, EsbuildLoaderName>> = {
  ".js": "jsx",
  ".mjs": "jsx",
  ".jsx": "jsx",
  ".ts": "ts",
  ".mts": "ts",
  ".tsx": "tsx",
};

/**
 * The lower-cased extension of `id` (query already stripped by the caller),
 * or `""` without one. Lower-cased because the parser patterns below are
 * case-insensitive, so `App.TSX` is claimed and parsed exactly as `App.tsx` is.
 */
export function moduleIdExtension(id: string): string {
  return /\.[^./\\]*$/.exec(id)?.[0].toLowerCase() ?? "";
}

/** The loader for a claimed script module's `extension`, or `undefined` if the adapter does not claim it. */
export function scriptModuleLoader(extension: string): EsbuildLoaderName | undefined {
  return Object.hasOwn(SCRIPT_MODULE_LOADERS, extension) ? SCRIPT_MODULE_LOADERS[extension] : undefined;
}

/** Extensions parsed with Babel's `typescript` plugin. */
export const TYPESCRIPT_EXTENSION = /\.[cm]?tsx?$/i;

/**
 * Extensions parsed with Babel's `jsx` plugin. JavaScript commonly carries
 * JSX without a `.jsx` suffix, while TypeScript's angle-bracket assertions
 * make JSX parsing unsafe for `.ts`.
 */
export const JSX_EXTENSION = /\.[cm]?(?:jsx?|tsx)$/i;
