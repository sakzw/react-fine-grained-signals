/*
 * M1.5 disposable baseline prototype, derived from Alien Signals 3.2.1.
 * Reference: https://github.com/stackblitz/alien-signals/tree/8734d386d925025d0e99419bd9161c17b112c5ee
 * Copyright (c) 2024-present Johnson Chu. See ALIEN-SIGNALS-LICENSE.txt.
 *
 * This intentionally small harness-only port retains Alien's lazy computed,
 * pending signal values, push/pull graph, synchronous effect queue, batching,
 * and linked-list dependency cleanup. It imports only Alien's low-level
 * `alien-signals/system` entry. It is not production code and does not yet
 * implement RFSG's rendering, interop, error, deep-signal, or lifecycle rules.
 */
import { createReactiveSystem, ReactiveFlags } from "alien-signals/system";

const { None, Mutable, Watching, RecursedCheck, Recursed, Dirty, Pending } = ReactiveFlags;
const HasChildEffect = 64;

let activeSub;
let cycle = 0;
let runDepth = 0;
let batchDepth = 0;
let flushIndex = 0;
let queuedLength = 0;
const queue = [];

const system = createReactiveSystem({
  update(node) {
    if (node.kind === "computed") return updateComputed(node);
    if (node.kind === "source") return updateSource(node);
    node.flags = Mutable;
    return true;
  },
  notify(effect) {
    let insertIndex = queuedLength;
    const firstInsertedIndex = insertIndex;
    do {
      queue[insertIndex++] = effect;
      effect.flags &= ~Watching;
      effect = effect.subs?.sub;
      if (effect === undefined || !(effect.flags & Watching)) break;
    // This queue walk intentionally advances until its linked-list sentinel.
    // oxlint-disable-next-line no-constant-condition
    } while (true);
    queuedLength = insertIndex;
    let leftIndex = firstInsertedIndex;
    while (leftIndex < --insertIndex) {
      const left = queue[leftIndex];
      queue[leftIndex++] = queue[insertIndex];
      queue[insertIndex] = left;
    }
  },
  unwatched(node) {
    if (node.kind === "computed") {
      if (node.depsTail !== undefined) {
        node.flags = Mutable | Dirty;
        disposeDeps(node);
      }
    } else if (node.kind === "effect") {
      disposeEffect(node);
    }
  },
});
const { link, unlink, propagate, checkDirty, shallowPropagate } = system;

function makeNode(kind, flags, fields = {}) {
  return { kind, flags, deps: undefined, depsTail: undefined, subs: undefined, subsTail: undefined, ...fields };
}

function readSource(source) {
  if (source.flags & Dirty && updateSource(source)) {
    if (source.subs !== undefined) shallowPropagate(source.subs);
  }
  if (activeSub !== undefined) link(source, activeSub, cycle);
  return source.currentValue;
}

function updateSource(source) {
  source.flags = Mutable;
  const changed = source.currentValue !== (source.currentValue = source.pendingValue);
  return changed;
}

function readComputed(computed) {
  const flags = computed.flags;
  if (flags & Dirty || (flags & Pending && (checkDirty(computed.deps, computed) || (computed.flags = flags & ~Pending, false)))) {
    if (updateComputed(computed) && computed.subs !== undefined) shallowPropagate(computed.subs);
  } else if (!flags) {
    computed.flags = Mutable | RecursedCheck;
    const previous = activeSub;
    activeSub = computed;
    try {
      computed.value = computed.getter();
    } finally {
      activeSub = previous;
      computed.flags &= ~RecursedCheck;
    }
  }
  if (activeSub !== undefined) link(computed, activeSub, cycle);
  return computed.value;
}

function updateComputed(computed) {
  if (computed.flags & HasChildEffect) disposeChildEffects(computed);
  computed.depsTail = undefined;
  computed.flags = Mutable | RecursedCheck;
  const previous = activeSub;
  activeSub = computed;
  try {
    cycle += 1;
    const previousValue = computed.value;
    computed.value = computed.getter(previousValue);
    return previousValue !== computed.value;
  } finally {
    activeSub = previous;
    computed.flags &= ~RecursedCheck;
    purgeDeps(computed);
  }
}

function writeSource(source, value) {
  if (source.pendingValue !== (source.pendingValue = value)) {
    source.flags = Mutable | Dirty;
    if (source.subs !== undefined) {
      propagate(source.subs, !!runDepth);
      if (!batchDepth) flush();
    }
  }
}

function runEffect(effect) {
  const flags = effect.flags;
  if (flags & Dirty || (flags & Pending && checkDirty(effect.deps, effect))) {
    if (flags & HasChildEffect) disposeChildEffects(effect);
    if (effect.cleanup !== undefined) {
      runCleanup(effect);
      if (!effect.flags) return;
    }
    effect.depsTail = undefined;
    effect.flags = Watching | RecursedCheck;
    const previous = activeSub;
    activeSub = effect;
    try {
      cycle += 1;
      runDepth += 1;
      effect.cleanup = effect.fn();
    } finally {
      runDepth -= 1;
      activeSub = previous;
      effect.flags &= ~RecursedCheck;
      purgeDeps(effect);
    }
  } else if (effect.deps !== undefined) {
    effect.flags = Watching | (flags & HasChildEffect);
  }
}

function flush() {
  try {
    while (flushIndex < queuedLength) {
      const effect = queue[flushIndex];
      queue[flushIndex++] = undefined;
      runEffect(effect);
    }
  } finally {
    while (flushIndex < queuedLength) {
      const effect = queue[flushIndex];
      queue[flushIndex++] = undefined;
      effect.flags |= Watching | Recursed;
    }
    flushIndex = 0;
    queuedLength = 0;
  }
}

function disposeChildEffects(parent) {
  let depLink = parent.depsTail;
  while (depLink !== undefined) {
    const previous = depLink.prevDep;
    if (depLink.dep.kind === "effect") unlink(depLink, parent);
    depLink = previous;
  }
}

function disposeDeps(sub) {
  let depLink = sub.depsTail;
  while (depLink !== undefined) {
    const previous = depLink.prevDep;
    unlink(depLink, sub);
    depLink = previous;
  }
}

function purgeDeps(sub) {
  const tail = sub.depsTail;
  let depLink = tail === undefined ? sub.deps : tail.nextDep;
  while (depLink !== undefined) depLink = unlink(depLink, sub);
}

function runCleanup(effect) {
  const cleanup = effect.cleanup;
  effect.cleanup = undefined;
  const previous = activeSub;
  activeSub = undefined;
  try {
    cleanup();
  } finally {
    activeSub = previous;
  }
}

function disposeEffect(effect) {
  effect.flags = None;
  disposeDeps(effect);
  if (effect.cleanup !== undefined) runCleanup(effect);
}

export function signal(initialValue) {
  const node = makeNode("source", Mutable, { currentValue: initialValue, pendingValue: initialValue });
  return {
    get value() { return readSource(node); },
    set value(value) { writeSource(node, value); },
    peek() { return untracked(() => readSource(node)); },
  };
}

// Alternative 2: preserve the public object/accessor shape, but have its
// accessors call a bound Alien-style signalOper directly on the private node.
export function signalBoundAccessor(initialValue) {
  const node = makeNode("source", Mutable, { currentValue: initialValue, pendingValue: initialValue });
  function signalOper(...value) {
    if (value.length) {
      if (this.pendingValue !== (this.pendingValue = value[0])) {
        this.flags = Mutable | Dirty;
        const subscribers = this.subs;
        if (subscribers !== undefined) {
          propagate(subscribers, !!runDepth);
          if (!batchDepth) flush();
        }
      }
    } else {
      if (this.flags & Dirty && updateSource(this) && this.subs !== undefined) shallowPropagate(this.subs);
      if (activeSub !== undefined) link(this, activeSub, cycle);
      return this.currentValue;
    }
  }
  const operate = signalOper.bind(node);
  const readable = { peek() { return untracked(() => operate()); } };
  Object.defineProperty(readable, "value", {
    get: operate,
    set: operate,
    enumerable: true,
  });
  return readable;
}

// Alternative 3: preserve the public object/accessor shape and inline the
// signal read/write bodies to remove both helper dispatch and bound-call path.
export function signalInlineAccessor(initialValue) {
  const node = makeNode("source", Mutable, { currentValue: initialValue, pendingValue: initialValue });
  return {
    get value() {
      if (node.flags & Dirty) {
        node.flags = Mutable;
        if (node.currentValue !== (node.currentValue = node.pendingValue)) {
          const subscribers = node.subs;
          if (subscribers !== undefined) shallowPropagate(subscribers);
        }
      }
      if (activeSub !== undefined) link(node, activeSub, cycle);
      return node.currentValue;
    },
    set value(value) {
      if (node.pendingValue !== (node.pendingValue = value)) {
        node.flags = Mutable | Dirty;
        const subscribers = node.subs;
        if (subscribers !== undefined) {
          propagate(subscribers, !!runDepth);
          if (!batchDepth) flush();
        }
      }
    },
    peek() {
      return untracked(() => {
        if (node.flags & Dirty) {
          node.flags = Mutable;
          if (node.currentValue !== (node.currentValue = node.pendingValue)) {
            const subscribers = node.subs;
            if (subscribers !== undefined) shallowPropagate(subscribers);
          }
        }
        if (activeSub !== undefined) link(node, activeSub, cycle);
        return node.currentValue;
      });
    },
  };
}

class SharedHelperReadable {
  #node;

  constructor(node) { this.#node = node; }
  get value() { return readSource(this.#node); }
  set value(value) { writeSource(this.#node, value); }
  peek() { return untracked(() => readSource(this.#node)); }
}

class SharedInlineReadable {
  #node;

  constructor(node) { this.#node = node; }
  get value() {
    const node = this.#node;
    if (node.flags & Dirty) {
      node.flags = Mutable;
      if (node.currentValue !== (node.currentValue = node.pendingValue)) {
        const subscribers = node.subs;
        if (subscribers !== undefined) shallowPropagate(subscribers);
      }
    }
    if (activeSub !== undefined) link(node, activeSub, cycle);
    return node.currentValue;
  }
  set value(value) {
    const node = this.#node;
    if (node.pendingValue !== (node.pendingValue = value)) {
      node.flags = Mutable | Dirty;
      const subscribers = node.subs;
      if (subscribers !== undefined) {
        propagate(subscribers, !!runDepth);
        if (!batchDepth) flush();
      }
    }
  }
  peek() { return untracked(() => this.value); }
}

export function signalClassHelper(initialValue) {
  const node = makeNode("source", Mutable, { currentValue: initialValue, pendingValue: initialValue });
  return new SharedHelperReadable(node);
}

export function signalClassInline(initialValue) {
  const node = makeNode("source", Mutable, { currentValue: initialValue, pendingValue: initialValue });
  return new SharedInlineReadable(node);
}

export function computed(getter) {
  const node = makeNode("computed", None, { getter, value: undefined });
  return Object.freeze({
    get value() { return readComputed(node); },
    peek() { return untracked(() => readComputed(node)); },
  });
}

export function effect(fn) {
  const node = makeNode("effect", Watching | RecursedCheck, { fn, cleanup: undefined });
  const previous = activeSub;
  if (previous !== undefined) {
    link(node, previous, 0);
    previous.flags |= HasChildEffect;
  }
  try {
    activeSub = node;
    runDepth += 1;
    node.cleanup = fn();
  } finally {
    runDepth -= 1;
    activeSub = previous;
    node.flags &= ~RecursedCheck;
  }
  return () => disposeEffect(node);
}

export function batch(fn) {
  batchDepth += 1;
  try {
    return fn();
  } finally {
    batchDepth -= 1;
    if (!batchDepth) flush();
  }
}

export function untracked(fn) {
  const previous = activeSub;
  activeSub = undefined;
  try {
    return fn();
  } finally {
    activeSub = previous;
  }
}
