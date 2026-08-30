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
 * This is that same loader with one behavioural difference -- the map the
 * transform produced wins whether or not an incoming map exists -- so
 * `src/unplugin.ts` points the compiler's loader rule here instead.
 */

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

  let pending: TransformOutput | Promise<TransformOutput>;
  try {
    pending = handler.call(createHookContext(this), source, id);
  } catch (thrown) {
    callback(toError(thrown));
    return;
  }
  Promise.resolve(pending).then((result) => {
    if (result === null || result === undefined) callback(null, source, map);
    else if (typeof result === "string") callback(null, result, map);
    // The one line that differs from unplugin's own loader: the transform
    // re-printed the file, so its map -- not the (absent) incoming one -- is
    // what the emitted text's line numbers now correspond to.
    else callback(null, result.code, result.map ?? map);
  }, (thrown: unknown) => {
    callback(toError(thrown));
  });
}
