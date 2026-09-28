import { READABLE_INTEROP_V1 } from "./interop-context.mjs";
import { UNTRACKED_OWNER, executionContext, withExecutionOwner } from "./execution-owner.js";

function observeRevision(node) {
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
}) {
  const protocols = new WeakMap();
  const readableNodes = new WeakMap();
  const foreignNodes = new WeakMap();

  function ensureForeignNode(protocol, observedRevision) {
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

  function activateForeignNode(node) {
    if (node.unsubscribe === undefined) {
      const protocol = node.protocol;
      const subscription = protocol.subscribe((revision) => {
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
    version: 2,
    kind: "graph",
    runtimeToken,
    add(protocol, revision) { ensureForeignNode(protocol, revision); },
  };

  function withGraphOwner(callback) {
    const owner = executionContext.owner;
    if (owner?.kind === "graph" && owner.runtimeToken === runtimeToken) return callback();
    return withExecutionOwner(graphOwner, callback);
  }

  function publishForeignReadable(readable, node, owner) {
    if (owner === UNTRACKED_OWNER || owner?.runtimeToken === runtimeToken) return;
    const protocol = protocols.get(readable);
    if (protocol !== undefined) {
      if (owner?.kind === "graph" || owner?.kind === "render") owner.add(protocol, observeRevision(node));
    }
  }

  function attachProtocol(readable, node) {
    readableNodes.set(readable, node);
    const protocol = {
      version: 1,
      runtimeToken,
      getRevision() {
        try { withExecutionOwner(UNTRACKED_OWNER, () => { readable.value; }); }
        catch { /* Revisions remain observable while computed read errors are cached. */ }
        return observeRevision(node);
      },
      subscribe(listener) {
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

  function getReadableRevision(readable) {
    const node = readableNodes.get(readable);
    if (node !== undefined) return observeRevision(node);
    const protocol = readable?.[READABLE_INTEROP_V1];
    if (protocol?.version === 1 && typeof protocol.getRevision === "function") return protocol.getRevision();
    throw new TypeError("Unknown candidate readable");
  }

  return { attachProtocol, ensureForeignNode, activateForeignNode, getNodeForReadable: (value) => readableNodes.get(value), getReadableRevision, observeRevision, publishForeignReadable, graphOwner, withGraphOwner };
}
