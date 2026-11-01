/**
 * How this package reads a module id: the bundler adapter decides which ids
 * to claim and the transform picks its parser plugins, and both have to look
 * at the same name or they disagree about one file.
 */

/**
 * `id` with the `?query`/`#fragment` a bundler appends taken off. Vite's
 * `App.tsx?t=173...` HMR stamp and its SFC sub-request
 * `App.vue?vue&type=script&lang.tsx` both name a file by what precedes the
 * query, so that part alone decides the extension.
 */
export function stripModuleIdQuery(id: string): string {
  return id.replace(/[?#].*$/, "");
}

/**
 * The extensions the adapter claims. `.cjs`/`.cts` are left out on purpose
 * (see `isTransformCandidate` in `unplugin.ts`); the match is case-insensitive
 * like the two parser tests below, so `App.TSX` is claimed and then parsed
 * exactly as `App.tsx` is.
 */
export const SCRIPT_MODULE_EXTENSION = /\.m?[jt]sx?$/i;

/** Extensions parsed with Babel's `typescript` plugin. */
export const TYPESCRIPT_EXTENSION = /\.[cm]?tsx?$/i;

/**
 * Extensions parsed with Babel's `jsx` plugin. JavaScript commonly carries
 * JSX without a `.jsx` suffix, while TypeScript's angle-bracket assertions
 * make JSX parsing unsafe for `.ts`.
 */
export const JSX_EXTENSION = /\.[cm]?(?:jsx?|tsx)$/i;
