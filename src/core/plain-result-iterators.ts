/**
 * `next` methods of this package's own iterators (reactive Map/Set iteration)
 * whose results are ordinary objects with data `done`/`value` properties, so
 * reading those properties can never run user code. Managed `for...of` capture
 * skips deferring those reads for such iterators, as it does for built-ins.
 */
export const plainResultIteratorNext = new WeakSet<Function>();
