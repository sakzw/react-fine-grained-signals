/**
 * The webpack/rspack transform loader.
 *
 * unplugin ships its own loader for both compilers, and both copies of it hand
 * the transform's source map on with
 * `callback(null, res.code, map == null ? map : res.map || map)` -- so a plugin
 * that runs with `enforce: "pre"`, and therefore sees no incoming map at all in
 * a normal configuration, has its map discarded every single time. That matters
 * here because Babel re-prints the whole file: every line number shifts, and a
 * downstream loader then builds its map treating the already-transformed text
 * as the original source, so breakpoints and stack traces land on lines that do
 * not exist. Vite, Rollup and esbuild take the map straight off the `transform`
 * hook's return value and are unaffected.
 *
 * This is that same loader with its map handling corrected, so
 * `src/unplugin.ts` points the compiler's loader rule here instead:
 *
 * - with no incoming map -- the ordinary `enforce: "pre"` case -- the map the
 *   transform produced is passed on rather than dropped;
 * - with an incoming map -- webpack lets several `pre` loaders chain, so
 *   `enforce: "pre"` does not actually guarantee this one runs first -- the two
 *   are composed, so neither the upstream loader's edits nor this transform's
 *   are lost from the positions a debugger ends up with.
 */
import { Buffer } from "node:buffer";

/** What a `transform` hook may hand back, per unplugin's own `TransformResult`. */
type TransformOutput = string | { code: string; map?: unknown } | null | undefined | void;

type TransformHandler = (
  this: unknown,
  code: string,
  id: string,
) => TransformOutput | Promise<TransformOutput>;

/** The slice of the resolved unplugin plugin this loader reads back. */
interface LoaderPlugin {
  transform?: TransformHandler | { handler: TransformHandler } | undefined;
  transformInclude?: ((id: string) => boolean | null | undefined) | undefined;
}

type LoaderCallback = (error: Error | null, content?: string, sourceMap?: unknown) => void;

/** The slice of webpack's/rspack's loader context this loader uses. */
interface LoaderContext {
  async(): LoaderCallback;
  query: unknown;
  resource: string;
  addDependency?: ((file: string) => void) | undefined;
  getDependencies?: (() => string[]) | undefined;
  emitWarning?: ((warning: Error) => void) | undefined;
  emitError?: ((error: Error) => void) | undefined;
}

function toError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

/** webpack hands the incoming map on as an object or as its JSON text. */
function toSourceMapObject(map: unknown): Record<string, unknown> | null {
  if (typeof map === "string") {
    try {
      const parsed: unknown = JSON.parse(map);
      return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return map !== null && typeof map === "object" ? (map as Record<string, unknown>) : null;
}

/**
 * A `sourceMappingURL` comment naming a map file rather than carrying one.
 *
 * Babel strips these itself, but only on the branch it takes when it found no
 * input map -- so appending an input map below suppresses that stripping and
 * would leave a stale `//# sourceMappingURL=App.tsx.map` line in the output.
 * Rather than cut such a comment out of the source by hand (a text edit to the
 * author's file, on a guess about what is comment and what is string), a file
 * that carries one simply does not get an input map appended: it keeps exactly
 * the behaviour it had before this loader forwarded incoming maps at all.
 * Matching too eagerly therefore only costs composition for that one file,
 * which is why this looks for the shape and not for a precise comment.
 */
const EXTERNAL_SOURCE_MAP_COMMENT = /(?:\/\/|\/\*)[@#][ \t]+sourceMappingURL=(?!data:)/;

/**
 * The incoming map re-attached to `source` as a trailing inline
 * `sourceMappingURL` comment, or `null` when there is no map worth attaching.
 *
 * Composing has to happen inside the Babel run that re-prints the file: Babel
 * is the only thing that knows how its output positions relate to its input,
 * and it already merges an input map into the map it emits. Its `inputSourceMap`
 * option defaults to reading that map out of exactly this comment, and it lifts
 * the comment out of the AST as it reads it, so nothing of it reaches the
 * printed output -- which makes this the transform's `inputSourceMap` channel
 * without the transform needing an option for it.
 *
 * Forwarding the incoming map must never make the result worse than not
 * forwarding it, so several shapes are left behind rather than passed on: a map
 * with no `sources` array makes Babel throw outright, and one whose `sources`
 * is present but empty composes into a map with no sources at all, throwing
 * away the perfectly good file name the transform's own map would have had.
 */
function inlineSourceMapComment(map: unknown, source: string): string | null {
  const candidate = toSourceMapObject(map);
  if (candidate === null) return null;
  if (Number(candidate.version) !== 3) return null;
  if (typeof candidate.mappings !== "string") return null;
  if (!Array.isArray(candidate.sources) || candidate.sources.length === 0) return null;
  if (EXTERNAL_SOURCE_MAP_COMMENT.test(source)) return null;
  let json: string;
  try {
    json = JSON.stringify(candidate);
  } catch {
    // A map carrying a circular reference is not one that can be handed on.
    return null;
  }
  const encoded = Buffer.from(json, "utf8").toString("base64");
  return `\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${encoded}`;
}

/**
 * Removes occurrences of the exact text appended above from a transform's
 * result. Babel takes its own copy back out as it reads it, so this is for a
 * `transform` hook that is not Babel and would print it straight back.
 *
 * The guarantee is only that: every byte-identical occurrence goes, whether or
 * not this loader is what put it there. A file already containing a comment
 * byte-identical to the one generated here -- which means already carrying this
 * exact incoming map, inline -- would lose it, and is accepted as an edge case;
 * on the Babel path it would not have survived anyway, since Babel filters out
 * every inline map comment it sees rather than only the last. A comment naming
 * a map *file* is a different matter and is handled before the fact, by
 * `EXTERNAL_SOURCE_MAP_COMMENT` above.
 */
function withoutInlineSourceMap(code: string, comment: string | null): string {
  return comment === null ? code : code.replaceAll(comment, "");
}

/**
 * The `this` a `transform` hook is called with. This plugin's own transform is
 * a pure `(code, id)` function that never touches it, so rather than rebuild
 * unplugin's full build context out of compiler internals, this forwards the
 * few context methods that have a direct loader equivalent and leaves it there.
 */
function createHookContext(loaderContext: LoaderContext): Record<string, unknown> {
  return {
    addWatchFile(file: string) {
      loaderContext.addDependency?.(file);
    },
    getWatchFiles() {
      return loaderContext.getDependencies?.() ?? [];
    },
    error(message: unknown) {
      throw toError(message);
    },
    warn(message: unknown) {
      const warning = toError(message);
      if (loaderContext.emitWarning !== undefined) loaderContext.emitWarning(warning);
      else console.warn(warning.message);
    },
  };
}

export default function reactFineGrainedSignalsLoader(
  this: LoaderContext,
  source: string,
  map?: unknown,
): void {
  const callback = this.async();
  const query = this.query;
  const plugin =
    query !== null && typeof query === "object"
      ? ((query as { plugin?: LoaderPlugin }).plugin ?? undefined)
      : undefined;
  const hook = plugin?.transform;
  const handler = typeof hook === "function" ? hook : hook?.handler;
  if (handler === undefined) {
    callback(null, source, map);
    return;
  }
  const id = this.resource;
  if (plugin?.transformInclude !== undefined && plugin.transformInclude(id) !== true) {
    callback(null, source, map);
    return;
  }

  const runTransform = (input: string): Promise<TransformOutput> => {
    try {
      return Promise.resolve(handler.call(createHookContext(this), input, id));
    } catch (thrown) {
      return Promise.reject(toError(thrown));
    }
  };
  // Carrying the incoming map in must not be able to fail a build on its own:
  // if the run that carries it throws, the run without it is precisely what
  // this loader did before, so that one's outcome -- its result or its error --
  // is the one reported.
  const inlineMap = inlineSourceMapComment(map, source);
  const transformed =
    inlineMap === null
      ? runTransform(source)
      : runTransform(source + inlineMap).catch(() => runTransform(source));

  transformed.then((result) => {
    if (result === null || result === undefined) callback(null, source, map);
    else if (typeof result === "string") {
      callback(null, withoutInlineSourceMap(result, inlineMap), map);
    }
    // What differs from unplugin's own loader: the transform re-printed the
    // file, so its map -- already composed with the incoming one, when there
    // was one -- is what the emitted text's line numbers now correspond to.
    else callback(null, withoutInlineSourceMap(result.code, inlineMap), result.map ?? map);
  }, (thrown: unknown) => {
    callback(toError(thrown));
  });
}
