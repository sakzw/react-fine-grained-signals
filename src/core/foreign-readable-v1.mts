import { READABLE_INTEROP_V1 } from "./interop-context.mjs";
import { UNTRACKED_OWNER, executionContext, withSynchronousExecutionOwner } from "./execution-owner.js";
import type { ExecutionContextOwnerV2, ReadableProtocolV1 } from "./execution-owner.js";
import { isGraphExecutionOwner, isRenderExecutionOwner } from "./execution-owner.js";
import type { ForeignReadableAdapterOptions, RuntimeNode } from "./alien-derived-types.js";

interface CandidateReadable {
  readonly value: unknown;
}

/** A render owner records another copy's read under its protocol object itself. */
export function isReadableProtocol(value: unknown): value is ReadableProtocolV1 {
  return typeof value === "object" && value !== null
    && Reflect.get(value, "version") === 1
    && typeof Reflect.get(value, "getRevision") === "function"
    && typeof Reflect.get(value, "subscribe") === "function";
}

function observeRevision(node: RuntimeNode): number {
  return node.renderRevision ??= 0;
}

// Owns the cross-copy readable protocol and its bridge nodes. Graph scheduling,
// linking, and propagation remain in the single Alien-derived graph core.
export function createForeignReadableAdapter({
  runtimeToken,
  makeNode,
  mutableFlag,
  dirtyFlag,
  getActiveSubscriber,
  link,
  propagate,
  shallowPropagate,
  flush,
  isRunning,
  isBatching,
  effect,
  own,
}: ForeignReadableAdapterOptions) {
  const readableNodes = new WeakMap<object, RuntimeNode>();
  const foreignNodes = new WeakMap<ReadableProtocolV1, RuntimeNode>();
  const localReadable = Symbol("localReadable");
  type LocalReadableProtocol = ReadableProtocolV1 & { readonly [localReadable]: CandidateReadable };

  function getLocalReadableRevision(this: LocalReadableProtocol): number {
    const readable = this[localReadable];
    const node = readableNodes.get(readable)!;
    try { withSynchronousExecutionOwner(UNTRACKED_OWNER, () => readable.value); }
    catch { /* Revisions remain observable while computed read errors are cached. */ }
    return observeRevision(node);
  }

  function subscribeLocalReadable(this: LocalReadableProtocol, listener: (revision: number) => void) {
    const readable = this[localReadable];
    const node = readableNodes.get(readable)!;
    const revision = observeRevision(node);
    let initial = true;
    const unsubscribe = effect(() => {
      try { readable.value; } catch { /* Keep errored computed boundaries observed. */ }
      if (initial) initial = false;
      else listener(observeRevision(node));
    });
    return { unsubscribe, revision };
  }

  // A bridge is a source whose value is the other copy's revision. Like a
  // source write, every newly learned revision -- pushed, read, or polled --
  // marks it Dirty and propagates to its subscribers, so `pendingRevision`
  // never advances past a revision its subscribers were not told about (a
  // silent advance would make the later push look stale and drop it).
  function advance(node: RuntimeNode, revision: number): boolean {
    if (revision === node.pendingRevision) return false;
    node.pendingRevision = revision;
    node.flags = mutableFlag | dirtyFlag;
    if (node.subs !== undefined) propagate(node.subs, isRunning());
    return true;
  }

  // A revision this copy learns by reading rather than by push: advance, then
  // settle at once, as a source read settles a pending write, so the reader
  // and later checks see a committed bridge instead of a change they already
  // observed. Effects it queues run when the push (or the next flush) arrives.
  function observeForeignRevision(node: RuntimeNode, revision: number): void {
    if (advance(node, revision)) {
      node.revision = revision;
      node.flags = mutableFlag;
      if (node.subs !== undefined) shallowPropagate(node.subs);
    }
  }

  function ensureForeignNode(protocol: ReadableProtocolV1, observedRevision: number): RuntimeNode {
    let node = foreignNodes.get(protocol);
    if (node === undefined) {
      node = makeNode("external", mutableFlag, {
        protocol,
        revision: observedRevision,
        pendingRevision: observedRevision,
        unsubscribe: undefined,
      });
      foreignNodes.set(protocol, node);
    }
    // Before linking, so the reader itself is not invalidated by what it read.
    observeForeignRevision(node, observedRevision);
    const subscriber = getActiveSubscriber();
    if (subscriber?.kind === "computed") subscriber.foreignDependent = true;
    if (subscriber !== undefined) link(node, subscriber);
    // A handshake that finds the source already past the revision this effect
    // just read marks it stale (bit 128), so its first run is retried once it
    // finishes; see `effect()` in alien-derived-runtime-core.mts.
    if (subscriber?.kind === "effect" && activateForeignNode(node)) subscriber.flags |= 128;
    return node;
  }

  // Returns true when the subscription reports a revision newer than the one
  // this copy last observed.
  function activateForeignNode(node: RuntimeNode): boolean | undefined {
    if (node.unsubscribe === undefined) {
      const protocol = node.protocol;
      const subscription = protocol!.subscribe((revision) => {
        if (revision !== node.revision) advance(node, revision);
        // Flush even for a revision a read already learned: that read only
        // queued the bridge's effects.
        if (!isBatching()) flush();
      });
      node.unsubscribe = subscription.unsubscribe;
      if (advance(node, subscription.revision)) {
        if (!isBatching()) flush();
        return true;
      }
    }
  }

  const graphOwner = {
    version: 2 as const,
    kind: "graph" as const,
    runtimeToken,
    add(protocol: ReadableProtocolV1, revision: number) { ensureForeignNode(protocol, revision); },
    own,
  };

  function withGraphOwner<T>(callback: () => T): T {
    const owner = executionContext.owner;
    if (isGraphExecutionOwner(owner) && owner.runtimeToken === runtimeToken) return callback();
    return withSynchronousExecutionOwner(graphOwner, callback);
  }

  function publishForeignReadable(readable: object, node: RuntimeNode, owner: ExecutionContextOwnerV2 | undefined): void {
    if (owner === UNTRACKED_OWNER || ((isGraphExecutionOwner(owner) || isRenderExecutionOwner(owner)) && owner.runtimeToken === runtimeToken)) return;
    const protocol = node.readableProtocol;
    if (protocol !== undefined) {
      if (isGraphExecutionOwner(owner) || isRenderExecutionOwner(owner)) owner.add(protocol, observeRevision(node));
    }
  }

  function attachProtocol(readable: CandidateReadable, node: RuntimeNode): void {
    readableNodes.set(readable, node);
    const protocol: LocalReadableProtocol = {
      version: 1 as const,
      runtimeToken,
      [localReadable]: readable,
      getRevision: getLocalReadableRevision,
      subscribe: subscribeLocalReadable,
    };
    node.readableProtocol = protocol;
    Object.defineProperty(readable, READABLE_INTEROP_V1, {
      value: protocol,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  function getReadableRevision(readable: object): number {
    const node = readableNodes.get(readable);
    if (node !== undefined) return observeRevision(node);
    const protocolValue: unknown = Reflect.get(readable, READABLE_INTEROP_V1);
    if (isReadableProtocol(protocolValue)) return protocolValue.getRevision();
    throw new TypeError("Unknown candidate readable");
  }

  return {
    attachProtocol,
    ensureForeignNode,
    activateForeignNode,
    observeForeignRevision,
    getNodeForReadable: (value: object) => readableNodes.get(value),
    getReadableRevision,
    observeRevision,
    publishForeignReadable,
    graphOwner,
    withGraphOwner,
  };
}
