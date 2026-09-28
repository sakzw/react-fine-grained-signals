import { READABLE_INTEROP_V1 } from "./interop-context.mjs";
import { UNTRACKED_OWNER, executionContext, withSynchronousExecutionOwner } from "./execution-owner.js";
import type { ExecutionContextOwnerV2, ReadableProtocolV1 } from "./execution-owner.js";
import { isGraphExecutionOwner, isRenderExecutionOwner } from "./execution-owner.js";
import type { ForeignReadableAdapterOptions, RuntimeNode } from "./alien-derived-types.js";

interface CandidateReadable {
  readonly value: unknown;
}

function isReadableProtocol(value: unknown): value is ReadableProtocolV1 {
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
  flush,
  isRunning,
  isBatching,
  effect,
}: ForeignReadableAdapterOptions) {
  const protocols = new WeakMap<object, ReadableProtocolV1>();
  const readableNodes = new WeakMap<object, RuntimeNode>();
  const foreignNodes = new WeakMap<ReadableProtocolV1, RuntimeNode>();

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
    node.pendingRevision = observedRevision;
    const subscriber = getActiveSubscriber();
    if (subscriber?.kind === "computed") subscriber.foreignDependent = true;
    if (subscriber !== undefined) link(node, subscriber);
    if (subscriber?.kind === "effect") activateForeignNode(node);
    return node;
  }

  function activateForeignNode(node: RuntimeNode): void {
    if (node.unsubscribe === undefined) {
      const protocol = node.protocol;
      const subscription = protocol!.subscribe((revision) => {
        if (revision === node.revision || revision === node.pendingRevision) return;
        node.pendingRevision = revision;
        node.flags = mutableFlag | dirtyFlag;
        if (node.subs !== undefined) {
          propagate(node.subs, isRunning());
          if (!isBatching()) flush();
        }
      });
      node.unsubscribe = subscription.unsubscribe;
      if (subscription.revision !== node.revision) {
        node.pendingRevision = subscription.revision;
        node.flags = mutableFlag | dirtyFlag;
        if (node.subs !== undefined) {
          propagate(node.subs, isRunning());
          if (!isBatching()) flush();
        }
      }
    }
  }

  const graphOwner = {
    version: 2 as const,
    kind: "graph" as const,
    runtimeToken,
    add(protocol: ReadableProtocolV1, revision: number) { ensureForeignNode(protocol, revision); },
  };

  function withGraphOwner<T>(callback: () => T): T {
    const owner = executionContext.owner;
    if (isGraphExecutionOwner(owner) && owner.runtimeToken === runtimeToken) return callback();
    return withSynchronousExecutionOwner(graphOwner, callback);
  }

  function publishForeignReadable(readable: object, node: RuntimeNode, owner: ExecutionContextOwnerV2 | undefined): void {
    if (owner === UNTRACKED_OWNER || ((isGraphExecutionOwner(owner) || isRenderExecutionOwner(owner)) && owner.runtimeToken === runtimeToken)) return;
    const protocol = protocols.get(readable);
    if (protocol !== undefined) {
      if (isGraphExecutionOwner(owner) || isRenderExecutionOwner(owner)) owner.add(protocol, observeRevision(node));
    }
  }

  function attachProtocol(readable: CandidateReadable, node: RuntimeNode): void {
    readableNodes.set(readable, node);
    const protocol = {
      version: 1 as const,
      runtimeToken,
      getRevision() {
        try { withSynchronousExecutionOwner(UNTRACKED_OWNER, () => readable.value); }
        catch { /* Revisions remain observable while computed read errors are cached. */ }
        return observeRevision(node);
      },
      subscribe(listener: (revision: number) => void) {
        const revision = observeRevision(node);
        let initial = true;
        const unsubscribe = effect(() => {
          try { readable.value; } catch { /* Keep errored computed boundaries observed. */ }
          if (initial) initial = false;
          else listener(observeRevision(node));
        });
        return { unsubscribe, revision };
      },
    };
    protocols.set(readable, protocol);
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
    getNodeForReadable: (value: object) => readableNodes.get(value),
    getReadableRevision,
    observeRevision,
    publishForeignReadable,
    graphOwner,
    withGraphOwner,
  };
}
