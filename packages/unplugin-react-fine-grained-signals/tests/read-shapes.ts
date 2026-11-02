/**
 * The read shapes `selection-capture-consistency.test.ts` (static: selection,
 * capture and inject agree) and `runtime-differential.test.ts` (dynamic: the
 * compiled component re-renders when the runtime's own tracking says it
 * should) both run. Each case places one read of `s` in some context. The
 * prelude defines everything the cases use, so the modules also run; `./ext`
 * is the one import the execution test supplies.
 */

export type Shape = "function" | "arrow" | "memo" | "forwardRef" | "default" | "async";

export interface Case {
  readonly name: string;
  readonly params?: string;
  readonly body?: string;
  readonly jsx?: string;
  /** What a capture of the target contains; defaults to `s.value`. */
  readonly token?: string;
  /** Module-level code placed before the component. */
  readonly module?: string;
  /** How the component is declared; defaults to a plain function declaration. */
  readonly shape?: Shape;
  /**
   * A disagreement that is intentional by documented design, with the
   * citation. Only these cases may differ, and only in the stated way.
   */
  readonly expected?: { readonly selected: boolean; readonly captured: boolean; readonly why: string };
  /**
   * A disagreement that contradicts the documented design but cannot be fixed
   * in the transform alone. Pinned so that it is visible, and so that a fix
   * shows up here as a failure to update.
   */
  readonly knownLimitation?: { readonly selected: boolean; readonly captured: boolean; readonly why: string };
  /** How `runtime-differential.test.ts` runs the case; see there. */
  readonly run?: Run;
}

/** The compiled candidates, and whether the unrelated read `o.value` is added. */
export type Outcome = `${"managed" | "inject"} ${"alone" | "companion"}`;

/** A candidate's re-render on the write, where it differs from the oracle's. */
export interface Deviation {
  readonly rerenders: Partial<Record<Outcome, boolean>>;
  /**
   * Whether those candidates keep showing the text from before the write. If
   * not, they show what the oracle shows (another component updated it, or
   * the oracle's re-render shows the same text).
   */
  readonly stale?: boolean;
  readonly why: string;
}

export interface Run {
  /** Props to mount with (the argument a custom Hook gets). */
  readonly props?: Readonly<Record<string, unknown>>;
  /** The write that should re-render; defaults to `s.value = 5;`. */
  readonly write?: string;
  /**
   * The oracle's own parameters and body, when the source cannot simply get a
   * first-statement `useSignalTracking()` (it runs after parameter defaults).
   */
  readonly oracle?: { readonly params?: string; readonly body?: string };
  /** Why the case cannot run at all. */
  readonly skip?: string;
  /** Intended by documented design, with the citation. Must differ from the oracle. */
  readonly exception?: Deviation;
  /** Contradicts the documented design, like `knownLimitation` above. */
  readonly knownLimitation?: Deviation;
}

export const prelude = `import { computed, deepCollectionSignal, deepSignal, signal, untracked, useComputed, useSignalEffect } from "react-fine-grained-signals";
import * as rfgs from "react-fine-grained-signals";
import { Show } from "react-fine-grained-signals/utils";
import { forwardRef, memo, use, useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { ext, extStore } from "./ext";
function log(value: unknown): void {
  void value;
}
function List(props: { render: () => number }) {
  return <i>{props.render()}</i>;
}
const s = signal(1);
const o = signal(2);
const u = signal(3);
const st = signal({ a: 1 });
const list = signal([1, 2]);
const readS = () => s.value;
const items = [1, 2];
const state = deepSignal({ user: { name: "Ada" }, items: [{ title: "a", meta: { tag: "x" } }] });
const store = deepCollectionSignal({ users: new Map([["u", { name: "Ada" }]]) });
`;

// README.md, "Managed tracking contract": "Any other call is captured unless
// its callee is proven" -- a precaution, not proof that it reads -- while
// "Runtime key or alias" and "An imported helper body is not inspected to
// select a function in `auto` mode" keep such calls from selecting.
const precaution = { selected: false, captured: true } as const;

export const cases: readonly Case[] = [
  { name: "a JSX child", jsx: "{s.value}" },
  { name: "a render-time const", body: "const x = s.value;", jsx: "{x}" },
  { name: "a helper call", body: "const x = readS();", jsx: "{x}", token: "readS(" },
  {
    name: "a conditional",
    params: "props: { f?: boolean }",
    body: "const x = props.f ? s.value : 0;",
    jsx: "{x}",
    run: { props: { f: true } },
  },
  { name: "a template literal", body: "const x = `${s.value}`;", jsx: "{x}" },
  { name: "a try block", body: "let x = 0; try { x = s.value; } catch {}", jsx: "{x}" },
  { name: "a sync IIFE", body: "const x = (() => s.value)();", jsx: "{x}" },
  {
    name: "a called local function",
    body: "function now() { return s.value; } const x = now();",
    jsx: "{x}",
    token: "now(",
  },
  { name: "an uncalled local function", body: "function later() { return s.value; }", jsx: "{later.name}" },
  { name: "an alias", body: "const t = s; const x = t.value;", jsx: "{x}", token: "t.value" },
  { name: "a computed member", body: 'const x = s["value"];', jsx: "{x}", token: 's["value"]' },
  {
    name: "an object getter",
    body: "const obj = { get v() { return s.value; } }; const x = obj.v;",
    jsx: "{x}",
    token: "obj.v",
  },
  { name: "a sync forEach callback", body: "items.forEach(() => log(s.value));" },
  { name: "a map render callback", jsx: "{items.map((i) => <b key={i}>{s.value}</b>)}" },
  { name: "Array.from with a mapper", body: "const x = Array.from({ length: 1 }, () => s.value);", jsx: "{x}" },
  {
    name: "a parameter default",
    params: "{ label = s.value }: { label?: number }",
    jsx: "{label}",
    run: {
      // README.md:545-547: a default runs before the body, so a hand-written
      // first-statement call misses it; the plugin moves it behind the boundary.
      oracle: { params: "props: { label?: number }", body: "const { label = s.value } = props;" },
    },
  },
  {
    name: "a parameter default through a helper",
    params: "{ label = readS() }: { label?: number }",
    jsx: "{label}",
    token: "readS(",
    run: { oracle: { params: "props: { label?: number }", body: "const { label = readS() } = props;" } },
  },
  { name: "peek", body: "const x = s.peek();", jsx: "{x}", token: "s.peek(" },
  { name: "untracked", body: "const x = untracked(() => s.value);", jsx: "{x}" },
  { name: "a useSignalEffect callback", body: "useSignalEffect(() => { log(s.value); });" },
  { name: "a useEffect callback", body: "useEffect(() => { log(s.value); }, []);" },
  {
    name: "a useMemo callback",
    body: "const x = useMemo(() => s.value, []);",
    jsx: "{x}",
    run: {
      exception: {
        rerenders: { "managed alone": false, "managed companion": false, "inject alone": false },
        why: 'README.md:380-385: a function handed to any Hook call "runs outside the render, so its reads are not collected"; inject tracks it like the oracle once selected',
      },
    },
  },
  { name: "a useCallback callback", body: "const f = useCallback(() => s.value, []);", jsx: "{f.name}" },
  {
    name: "a useState initializer",
    body: "const [x] = useState(() => s.value);",
    jsx: "{x}",
    run: {
      exception: {
        rerenders: { "managed alone": false, "managed companion": false, "inject alone": false },
        why: 'README.md:380-385: a function handed to any Hook call "runs outside the render, so its reads are not collected"; inject tracks it like the oracle once selected',
      },
    },
  },
  {
    name: "a useComputed getter",
    body: "const c = useComputed(() => s.value * 2);",
    jsx: "{c}",
    run: {
      skip: '`{c}` renders the signal object, which React rejects as a child; `useComputed` is lazy, so the getter\'s first evaluation is covered by "a useComputed value read in render"',
    },
  },
  {
    name: "a useComputed value read in render",
    body: "const c = useComputed(() => s.value * 2);",
    jsx: "{c.value}",
    token: "c.value",
  },
  { name: "an inline event handler", jsx: "<button onClick={() => log(s.value)} />" },
  { name: "a named event handler", body: "const onClick = () => log(s.value);", jsx: "<button onClick={onClick} />" },
  { name: "a ref callback", jsx: "<div ref={() => log(s.value)} />" },
  { name: "setTimeout", body: "setTimeout(() => log(s.value), 0);" },
  { name: "a promise continuation", body: "Promise.resolve().then(() => log(s.value));" },
  {
    name: "an async IIFE",
    body: "(async () => { log(s.value); })();",
    run: {
      exception: {
        rerenders: { "managed alone": false, "managed companion": false, "inject alone": false },
        why: 'README.md:244: in an async function, its "reads never become render dependencies, even the ones before its first `await`"',
      },
    },
  },
  {
    name: "an async forEach callback",
    body: "items.forEach(async () => { log(s.value); });",
    // Selection follows the design (an async function is outside the render),
    // but `items.forEach(...)` is still captured as a precaution once the
    // component is selected for another read, and forEach runs the callback's
    // synchronous prefix inside that capture. Keeping it out needs the
    // generated code to run the callback untracked, which the capture store
    // offers no way to do.
    knownLimitation: { ...precaution, why: "an async callback inside a captured call" },
    run: {
      exception: {
        rerenders: { "managed alone": false, "inject alone": false },
        why: 'README.md:244: in an async function, its "reads never become render dependencies, even the ones before its first `await`"',
      },
      // README.md:258, pinned like `knownLimitation` above: the captured
      // forEach runs the callback's synchronous prefix inside the capture.
      knownLimitation: {
        rerenders: { "managed companion": true },
        why: "README.md:258: an async callback inside a captured call subscribes its synchronous prefix",
      },
    },
  },
  {
    name: "a called async function",
    body: "async function load() { log(s.value); } void load();",
    token: "load(",
    run: {
      exception: {
        rerenders: { "managed alone": false, "managed companion": false, "inject alone": false },
        why: 'README.md:244: in an async function, its "reads never become render dependencies, even the ones before its first `await`"',
      },
    },
  },
  { name: "a generator", body: "function* g() { yield s.value; } const it = g();", jsx: "{String(it)}", token: "g(" },
  {
    name: "a render prop of another component",
    jsx: "<List render={() => s.value} />",
    run: {
      // The oracle's bare collector is still open while List renders the
      // callback, so the read is credited to C (design doc, line 15).
      exception: {
        rerenders: { "managed alone": false, "managed companion": false, "inject alone": false },
        stale: true,
        why: 'README.md:250: for a render prop, "Capture is not guaranteed" (RFGS003)',
      },
    },
  },
  { name: "a Show children callback", jsx: "<Show when={o}>{() => s.value}</Show>" },

  // Calls of functions the module defines in other shapes.
  {
    name: "a class method called in render",
    module: "class Box { read() { return s.value; } }\nconst box = new Box();",
    body: "const x = box.read();",
    jsx: "{x}",
    token: "box.read(",
    expected: { ...precaution, why: "a class method is not a proven callee" },
    run: {
      exception: {
        rerenders: { "managed alone": false, "inject alone": false },
        stale: true,
        why: 'README.md:256: "A precautionary capture (an unresolved callee, a runtime-key member) does not select a function"',
      },
    },
  },
  {
    name: "a class getter",
    module: "class Box { get v() { return s.value; } }\nconst box = new Box();",
    body: "const x = box.v;",
    jsx: "{x}",
    token: "box.v",
    run: {
      exception: {
        rerenders: { "managed alone": false, "managed companion": false, "inject alone": false },
        stale: true,
        why: 'README.md:244: "a getter or setter" that an operator runs implicitly "is not tracked"',
      },
    },
  },
  {
    name: "a static class method",
    module: "class Util { static read() { return s.value; } }",
    body: "const x = Util.read();",
    jsx: "{x}",
    token: "Util.read(",
    expected: { ...precaution, why: "a class method is not a proven callee" },
    run: {
      exception: {
        rerenders: { "managed alone": false, "inject alone": false },
        stale: true,
        why: 'README.md:256: "A precautionary capture (an unresolved callee, a runtime-key member) does not select a function"',
      },
    },
  },
  {
    name: "an object method called in render",
    body: "const api = { read() { return s.value; } }; const x = api.read();",
    jsx: "{x}",
    token: "api.read(",
  },
  { name: "an uncalled object method", body: "const api = { read() { return s.value; } };", jsx: "{api.read.name}" },
  {
    name: "a module object method",
    module: "const api = { read: () => s.value };",
    body: "const x = api.read();",
    jsx: "{x}",
    token: "api.read(",
  },
  {
    name: "a method named peek",
    module: "const stack = { peek: () => s.value };",
    body: "const x = stack.peek();",
    jsx: "{x}",
    token: "stack.peek(",
  },
  {
    name: "a function returned from a helper and called",
    module: "const make = () => () => s.value;",
    body: "const x = make()();",
    jsx: "{x}",
    token: "make()(",
    expected: { ...precaution, why: "a callee that is a call result is chosen at run time" },
    run: {
      exception: {
        rerenders: { "managed alone": false, "inject alone": false },
        stale: true,
        why: 'README.md:256: "A precautionary capture (an unresolved callee, a runtime-key member) does not select a function"',
      },
    },
  },
  {
    name: "a closure stored in an array and called by index",
    body: "const fs = [() => s.value]; const x = fs[0]!();",
    jsx: "{x}",
    token: "fs[0]",
  },
  {
    name: "a handler picked by a runtime key",
    params: "props: { k: string }",
    body: "const handlers = { a: () => s.value, b() { return 0; } }; const x = handlers[props.k]();",
    jsx: "{x}",
    token: "handlers[props.k]",
    run: { props: { k: "a" } },
  },
  {
    name: "a function chosen by a condition",
    params: "props: { f?: boolean }",
    body: "const pick = props.f ? () => s.value : () => 0; const x = pick();",
    jsx: "{x}",
    token: "pick(",
    run: { props: { f: true } },
  },
  {
    name: "a reassigned local function",
    params: "props: { f?: boolean }",
    body: "let pick = () => 0; if (props.f) pick = () => s.value; const x = pick();",
    jsx: "{x}",
    token: "pick(",
    run: { props: { f: true } },
  },
  { name: "a callback passed to an imported function", body: "const x = ext(() => s.value);", jsx: "{x}" },
  {
    name: "an options object handed to an imported function",
    body: "const opts = { cb: () => s.value }; const x = ext(opts);",
    jsx: "{x}",
    token: "ext(opts)",
  },
  {
    name: "a local function in an array handed to an imported function",
    body: "const cb = () => s.value; const x = ext([cb]);",
    jsx: "{x}",
    token: "ext([cb])",
  },
  {
    name: "an imported call alone",
    body: "const x = ext(1);",
    jsx: "{x}",
    token: "ext(",
    expected: { ...precaution, why: "an imported helper body is not inspected to select" },
  },
  { name: "a signal passed to an imported function", body: "const x = ext(s.value);", jsx: "{x}" },
  {
    name: "a method of an imported object with a reading callback",
    body: "const x = extStore.map(() => s.value);",
    jsx: "{x}",
  },
  {
    name: ".call",
    module: "function now() { return s.value; }",
    body: "const x = now.call(null);",
    jsx: "{x}",
    token: "now.call(",
  },
  {
    name: ".apply",
    module: "function now() { return s.value; }",
    body: "const x = now.apply(null, []);",
    jsx: "{x}",
    token: "now.apply(",
  },
  {
    name: ".bind then call",
    module: "function now() { return s.value; }",
    body: "const f = now.bind(null); const x = f();",
    jsx: "{x}",
    token: "f(",
    expected: { ...precaution, why: "a bound function held in a variable is not a proven callee" },
    run: {
      exception: {
        rerenders: { "managed alone": false, "inject alone": false },
        stale: true,
        why: 'README.md:256: "A precautionary capture (an unresolved callee, a runtime-key member) does not select a function"',
      },
    },
  },
  {
    name: "an optional call",
    module: "function now() { return s.value; }",
    body: "const x = now?.();",
    jsx: "{x}",
    token: "now?.(",
  },
  {
    name: "an optional member call",
    body: "const api = { read: () => s.value }; const x = api?.read();",
    jsx: "{x}",
    token: "api?.read(",
  },
  // A call in the middle of an optional chain is captured with the rest of
  // the chain: `capture(() => a?.b()).length` would throw when `a` is nullish.
  {
    name: "a reading call in the middle of an optional chain",
    params: "props: { todos?: number[] }",
    body: "const x = props.todos?.filter(() => s.value > 0).length;",
    jsx: "{String(x)}",
    token: "s.value > 0).length",
    run: { props: {} },
  },
  {
    name: "a reading call in the middle of an optional chain, base present",
    params: "props: { todos?: number[] }",
    body: "const x = props.todos?.filter(() => s.value > 0).length;",
    jsx: "{String(x)}",
    token: "s.value > 0).length",
    run: { props: { todos: [1] } },
  },
  {
    name: "an optional call in the middle of a chain",
    params: "props: { f?: () => number[] }",
    body: "const x = props.f?.().length;",
    jsx: "{String(x)}",
    token: "props.f?.().length",
    expected: { ...precaution, why: "a parameter called as a function is not a proven callee" },
  },
  {
    name: "an imported optional call in the middle of a chain",
    body: "const x = ext?.(1).length;",
    jsx: "{String(x)}",
    token: "ext?.(1).length",
    expected: { ...precaution, why: "an imported helper body is not inspected to select" },
  },
  {
    name: "a method of a nullish prop in the middle of an optional chain",
    params: "props: { api?: { load(): number[] } }",
    body: "const x = props.api?.load().length;",
    jsx: "{String(x)}",
    token: "props.api?.load().length",
    expected: { ...precaution, why: "a method of a prop is not a proven callee" },
    run: { props: {} },
  },
  {
    name: "a tagged template whose tag reads",
    module: "const tag = (strings: TemplateStringsArray) => s.value + strings.length;",
    body: "const x = tag`a`;",
    jsx: "{x}",
    token: "tag`",
  },
  { name: "a read inside a tagged template", body: "const x = String.raw`${s.value}`;", jsx: "{x}" },
  {
    name: "a new expression whose class reads",
    module: "class Reader { v = s.value; }",
    body: "const x = new Reader().v;",
    jsx: "{x}",
    token: "new Reader(",
    expected: { ...precaution, why: "only a standard constructor is proven (`new C()`)" },
    run: {
      exception: {
        rerenders: { "managed alone": false, "inject alone": false },
        stale: true,
        why: 'README.md:256: "A precautionary capture (an unresolved callee, a runtime-key member) does not select a function"',
      },
    },
  },
  { name: "a Promise executor", body: "let x = 0; new Promise(() => { x = s.value; });", jsx: "{x}" },
  {
    name: "a named Promise executor",
    module: "function exec() { log(s.value); }",
    body: "new Promise(exec);",
    token: "new Promise(",
  },
  { name: "queueMicrotask", body: "queueMicrotask(() => log(s.value));" },
  { name: "requestAnimationFrame", body: "requestAnimationFrame(() => log(s.value));" },
  {
    name: "a named setTimeout callback",
    module: "function tick() { log(s.value); }",
    body: "setTimeout(tick, 0);",
    token: "setTimeout(",
  },
  { name: "a promise chain continuation", body: "Promise.resolve(1).then((v) => v).catch(() => log(s.value));" },
  { name: "replace with a reading callback", body: 'const x = "abc".replace("b", () => String(s.value));', jsx: "{x}" },
  {
    name: "filter on local data",
    body: "const local = [1, 2]; const x = local.filter(() => s.value > 0);",
    jsx: "{x}",
  },
  { name: "reduce with a reading callback", body: "const x = items.reduce((a) => a + s.value, 0);", jsx: "{x}" },
  {
    name: "map over useState data",
    body: "const [arr] = useState([1]); const x = arr.map(() => s.value);",
    jsx: "{x}",
  },
  {
    name: "a useReducer initializer",
    body: "const [x] = useReducer((a: number) => a, 0, () => s.value);",
    jsx: "{x}",
    run: {
      exception: {
        rerenders: { "managed alone": false, "managed companion": false, "inject alone": false },
        why: 'README.md:380-385: a function handed to any Hook call "runs outside the render, so its reads are not collected"; inject tracks it like the oracle once selected',
      },
    },
  },
  {
    name: "use()",
    body: "const x = use(Promise.resolve(s.value));",
    jsx: "{x}",
    run: { skip: "`use` of a promise made during render suspends every attempt, so the component never commits" },
  },
  { name: "untracked through a namespace", body: "const x = rfgs.untracked(() => s.value);", jsx: "{x}" },
  {
    name: "peek on a computed",
    module: "const doubled = computed(() => s.value * 2);",
    body: "const x = doubled.peek();",
    jsx: "{x}",
    token: "doubled.peek(",
  },
  {
    name: "peek on a useComputed result",
    body: "const c = useComputed(() => 1); const x = c.peek();",
    jsx: "{x}",
    token: "c.peek(",
  },

  // Read shapes.
  {
    name: "a destructured signal accessor",
    body: "const { value } = s;",
    jsx: "{value}",
    token: "} = s",
    run: {
      exception: {
        rerenders: { "managed alone": false, "managed companion": false, "inject alone": false },
        stale: true,
        why: 'README.md:243: "Destructured signal accessors are not tracked"',
      },
    },
  },
  {
    name: "a destructured signal value",
    body: "const { a } = st.value;",
    jsx: "{a}",
    token: "st.value",
    run: { write: "st.value = { a: 3 };" },
  },
  { name: "an optional member read", body: "const x = s?.value;", jsx: "{x}", token: "s?.value" },
  { name: "a non-null read", body: "const x = s!.value;", jsx: "{x}", token: "s!.value" },
  {
    name: "an in check",
    body: 'const x = "a" in st.value;',
    jsx: "{String(x)}",
    token: "st.value",
    run: { write: "st.value = { a: 3 };" },
  },
  { name: "a comma expression", body: "const x = (log(0), s.value);", jsx: "{x}" },
  { name: "a logical assignment", body: "let x: number | undefined; x ??= s.value;", jsx: "{x}" },
  { name: "a JSX attribute", jsx: "<b title={String(s.value)} />" },
  { name: "a key", jsx: "<b key={s.value} />" },
  { name: "a key in a map callback", jsx: "{items.map((i) => <b key={s.value + i} />)}" },
  {
    name: "spread props of a signal value",
    module: "const props = signal({ title: 'x' });",
    jsx: "<b {...props.value} />",
    token: "props.value",
    run: { write: 'props.value = { title: "y" };' },
  },
  { name: "spread props of an object literal", jsx: "<b {...{ title: s.value }} />" },
  {
    name: "for...of over a signal array",
    body: "let n = 0; for (const i of list.value) n += i;",
    jsx: "{n}",
    token: "list.value",
    run: { write: "list.value = [3, 4];" },
  },
  {
    name: "for...of over a reading generator",
    module: "function* gen() { yield s.value; }",
    body: "let n = 0; for (const v of gen()) n += v;",
    jsx: "{n}",
    token: "gen(",
  },
  {
    name: "for...in over a signal object",
    body: 'let k = ""; for (const key in st.value) k += key;',
    jsx: "{k}",
    token: "st.value",
    run: { write: "st.value = { a: 3 };" },
  },

  // Control flow.
  {
    name: "a read after an early return",
    params: "props: { f?: boolean }",
    body: "if (props.f) return null; const x = s.value;",
    jsx: "{x}",
  },
  {
    name: "a switch case",
    params: "props: { k?: number }",
    body: "let x = 0; switch (props.k) { case 1: x = s.value; break; default: break; }",
    jsx: "{x}",
    run: { props: { k: 1 } },
  },
  { name: "a labeled block", body: "let x = 0; done: { x = s.value; break done; }", jsx: "{x}" },
  { name: "a loop body", body: "let x = 0; for (let i = 0; i < 2; i++) x += s.value;", jsx: "{x}" },

  // Nested functions that own their own boundary.
  {
    name: "a nested component",
    body: "function Inner() { return <b>{s.value}</b>; }",
    jsx: "<Inner />",
    run: {
      // Inner subscribes on its own in every candidate, so the text updates;
      // only the oracle's still-open bare collector credits Inner's read to C.
      exception: {
        rerenders: {
          "managed alone": false,
          "managed companion": false,
          "inject alone": false,
          "inject companion": false,
        },
        why: 'use-signals-boundary-design.md:15: a bare collector "can still be open while a sibling or descendant ... reads a signal"',
      },
    },
  },
  {
    name: "a custom Hook called in render",
    module: "function useReadS() { return s.value; }",
    body: "const x = useReadS();",
    jsx: "{x}",
    token: "useReadS(",
  },
  {
    name: "a nested custom Hook",
    body: "function useInner() { return s.value; } const x = useInner();",
    jsx: "{x}",
    token: "useInner(",
  },
  {
    name: "a plain-called component",
    module: "function Title() { return <b>{s.value}</b>; }",
    jsx: "{Title()}",
    token: "Title(",
  },

  // Component shapes.
  { name: "an arrow component", shape: "arrow", jsx: "{s.value}" },
  { name: "a memo component", shape: "memo", jsx: "{s.value}" },
  { name: "a forwardRef component", shape: "forwardRef", params: "props: object, ref: unknown", jsx: "{s.value}" },
  { name: "a default export", shape: "default", jsx: "{s.value}" },
  {
    name: "a default export with a helper call",
    shape: "default",
    body: "const x = readS();",
    jsx: "{x}",
    token: "readS(",
  },
  // README "mode" and "Managed tracking contract": async and generator
  // functions are never selected, so neither side does anything.
  {
    name: "an async component",
    shape: "async",
    body: "await null; const x = s.value;",
    jsx: "{x}",
    run: {
      skip: "a client root cannot render an async component (README.md:538-542: hooks need a synchronous function)",
    },
  },

  // Deep signals. `signal()` is shallow, so a value taken out of `.value` and
  // read later needs no tracking of its own; a deep signal's nested objects
  // are proxies whose reads the runtime tracks wherever they happen. Each case
  // takes a nested object out of `state` (an alias; the inventory A1-A14 in
  // development/v0.4.0/managed-scope-options.ja.md §1.1) and reads it later.
  // The write changes only the nested property, so only a read through the
  // alias can re-render.
  ...deepCases(),

  // A file whose only `.value` follows a name like a DOM or ref field: the raw
  // text cannot tell these from `e.target.value`, so the pre-filter must pass them.
  {
    name: "a spread of a signal named like a DOM field",
    module: "const target = signal([1]);",
    body: "const x = [...target.value].length;",
    jsx: "{x}",
    token: "target.value",
    run: { write: "target.value = [1, 2];" },
  },
  {
    name: "a JSX spread of a signal named like a ref",
    module: "const current = signal({ title: 'x' });",
    jsx: "<b {...current.value} />",
    token: "current.value",
    run: { write: 'current.value = { title: "y" };' },
  },
  {
    name: "a read after a comment that ends in a period",
    module: "const current = signal(1);",
    body: "const x = // the one.\n current.value;",
    jsx: "{x}",
    token: "current.value",
    run: { write: "current.value = 5;" },
  },
  {
    name: "a read after a line comment ending in a carriage return",
    body: "const x = s. // note\r value;",
    jsx: "{x}",
    token: "value",
  },
  {
    name: "a read after a line comment ending in U+2028",
    body: "const x = s. // note\u2028 value;",
    jsx: "{x}",
    token: "value",
  },

  // Syntax that reads where it seems not to.
  // A write through a read: `st.value` is read before `.a` is written.
  {
    name: "a property write on a signal value",
    body: "st.value.a = 2;",
    token: "st.value",
    run: {
      write: "st.value = { a: 3 };",
      exception: {
        rerenders: { "managed alone": false, "managed companion": false, "inject alone": false },
        why: "README.md:247: a write during render is a side effect React rules out, so the read before it is not tracked; inject tracks it like the oracle once selected",
      },
    },
  },
  // A JSX member tag reads `theme.value`, which is not tracked there.
  {
    name: "a JSX member tag",
    module: "const theme = signal({ Icon: () => <b>a</b> });",
    jsx: "<theme.value.Icon />",
    token: "theme.value",
    run: {
      write: "theme.value = { Icon: () => <b>b</b> };",
      exception: {
        rerenders: { "managed alone": false, "managed companion": false, "inject alone": false },
        stale: true,
        why: "README.md:247: a signal read in a JSX tag name is not tracked (RFGS010); inject tracks it like the oracle once selected",
      },
    },
  },
  // A class field runs when the class is instantiated (instance fields) or
  // evaluated (static fields and blocks), not where it is written.
  {
    name: "an instance field of a class instantiated in an effect",
    body: "class Model { snapshot = s.value; } useEffect(() => { log(new Model().snapshot); }, []);",
  },
  {
    name: "an instance field of a class instantiated in render",
    body: "class Model { snapshot = s.value; } const x = new Model().snapshot;",
    jsx: "{x}",
    token: "new Model(",
    expected: { ...precaution, why: "only a standard constructor is proven (`new C()`)" },
    run: {
      exception: {
        rerenders: { "managed alone": false, "inject alone": false },
        stale: true,
        why: 'README.md:256: "A precautionary capture (an unresolved callee, a runtime-key member) does not select a function"',
      },
    },
  },
  {
    name: "a static field of a class declared in render",
    body: "class Model { static snapshot = s.value; } const x = Model.snapshot;",
    jsx: "{x}",
  },
  {
    name: "a static block of a class declared in render",
    body: "let x = 0; class Model { static { x = s.value; } } void Model;",
    jsx: "{x}",
  },
];

function deepCases(): Case[] {
  const name: Run = { write: 'state.value.user.name = "Grace";' };
  const title: Run = { write: 'state.value.items[0]!.title = "b";' };
  const tag: Run = { write: 'state.value.items[0]!.meta.tag = "y";' };
  const deep = (testCase: Case, run: Run = name): Case => ({
    jsx: "{x}",
    ...testCase,
    name: `deep: ${testCase.name}`,
    run: { ...run, ...testCase.run },
  });
  return [
    // A1
    deep({ name: "a const alias", body: "const user = state.value.user; const x = user.name;", token: "user.name" }),
    // A2
    deep({
      name: "an alias through a conditional",
      params: "props: { f?: boolean }",
      body: 'const user = state.value.user; const x = (props.f ? user : { name: "-" }).name;',
      token: "user :",
      run: { props: { f: true } },
    }),
    deep({
      name: "an alias through an as-expression",
      body: "const user = state.value.user; const x = (user as { name: string }).name;",
      token: "user as",
    }),
    deep({
      name: "an alias through an array literal",
      body: "const user = state.value.user; const x = [user][0]!.name;",
      token: "[user]",
    }),
    deep({
      name: "an alias passed to a local function",
      module: "function show(u: { name: string }) { return u.name; }",
      body: "const user = state.value.user; const x = show(user);",
      token: "show(user)",
    }),
    deep({
      name: "an alias through ??",
      body: 'const user = state.value.user; const x = (user ?? { name: "-" }).name;',
      token: "user ??",
    }),
    // A3
    deep({
      name: "a static const destructuring",
      body: "const { user } = state.value; const x = user.name;",
      token: "user.name",
    }),
    deep({
      name: "a nested static const destructuring",
      body: "const { user: { name: x } } = state.value;",
      token: "state.value",
    }),
    // A4
    deep(
      {
        name: "an array pattern",
        body: "const [first] = state.value.items; const x = first!.title;",
        token: "first!.title",
      },
      title,
    ),
    deep({
      name: "a pattern with a default",
      body: 'const { user = { name: "-" } } = state.value; const x = user.name;',
      token: "user.name",
    }),
    deep({ name: "a let pattern", body: "let { user } = state.value; const x = user.name;", token: "user.name" }),
    deep({
      name: "a rest pattern",
      body: "const { ...rest } = state.value; const x = rest.user.name;",
      token: "rest.user.name",
    }),
    // A5
    deep({
      name: "a destructuring assignment",
      body: "let user: { name: string }; ({ user } = state.value); const x = user.name;",
      token: "user.name",
    }),
    // A6
    deep({
      name: "a let alias assigned later",
      body: "let user: { name: string }; user = state.value.user; const x = user.name;",
      token: "user.name",
    }),
    deep({
      name: "a let alias assigned with ??=",
      body: "let user: { name: string } | undefined; user ??= state.value.user; const x = user.name;",
      token: "user.name",
    }),
    // A7
    deep({
      name: "a container element assignment",
      body: "const box: { name: string }[] = []; box[0] = state.value.user; const x = box[0]!.name;",
      token: "box[0]!.name",
    }),
    // A8
    deep({
      name: "an array push",
      body: "const box: { name: string }[] = []; box.push(state.value.user); const x = box[0]!.name;",
      token: "box[0]!.name",
    }),
    deep({
      name: "a Set add",
      body: "const box = new Set<{ name: string }>(); box.add(state.value.user); const x = [...box][0]!.name;",
      token: "box]",
    }),
    deep({
      name: "a Map set",
      body: 'const box = new Map<string, { name: string }>(); box.set("u", state.value.user); const x = box.get("u")!.name;',
      token: 'box.get("u")',
    }),
    deep(
      {
        name: "a push of a loop variable",
        body: "const box: { title: string }[] = []; for (const item of state.value.items) box.push(item); const x = box.map((i) => i.title).join();",
        token: "box.map(",
      },
      title,
    ),
    // A9
    deep(
      {
        name: "a for...of loop variable",
        body: 'let x = ""; for (const item of state.value.items) x += item.title;',
        token: "item.title",
      },
      title,
    ),
    deep(
      {
        name: "a for...of destructured loop variable",
        body: 'let x = ""; for (const { meta } of state.value.items) x += meta.tag;',
        token: "meta.tag",
      },
      tag,
    ),
    // A9, assignment-form loop heads.
    deep(
      {
        name: "a for...of loop head assigning a pattern",
        body: 'let meta: { tag: string }; let x = ""; for ({ meta } of state.value.items) x += meta.tag;',
        token: "meta.tag",
      },
      tag,
    ),
    deep(
      {
        name: "a for...of loop head assigning an existing binding",
        body: 'let item: { title: string }; let x = ""; for (item of state.value.items) x += item.title;',
        token: "item.title",
      },
      title,
    ),
    // A10
    deep({
      name: "a helper's return value",
      module: "function getUser() { return state.value.user; }",
      body: "const user = getUser(); const x = user.name;",
      token: "user.name",
    }),
    // A11
    deep({
      name: "an object getter returning a nested object",
      body: "const view = { get user() { return state.value.user; } }; const x = view.user.name;",
      token: "view.user.name",
    }),
    // A12
    deep({
      name: "a local helper reading the caller's alias",
      body: "const user = state.value.user; const text = () => user.name; const x = text();",
      token: "text(",
    }),
    // A13
    deep({
      name: "an alias handed to a Hook",
      body: "const user = state.value.user; const [held] = useState(user); const x = held.name;",
      token: "held.name",
    }),
    // A collection signal.
    deep(
      {
        name: "a Map entry of a collection signal",
        body: 'const user = store.value.users.get("u")!; const x = user.name;',
        token: "user.name",
      },
      { write: 'store.value.users.get("u")!.name = "Grace";' },
    ),
  ];
}

/** Marks the body of the function under test, so its output can be found again. */
export const marker = "const __subject = 0;";

export function component(
  { params = "", body = "", jsx = "", module = "", shape = "function" }: Case,
  companion: boolean,
): string {
  const block = `{\n${marker}\n${body}\nreturn <p>${jsx}${companion ? "<i>{o.value}</i>" : ""}</p>;\n}`;
  const declaration = {
    function: `export function C(${params}) ${block}`,
    arrow: `export const C = (${params}) => ${block};`,
    memo: `export const C = memo(function C(${params}) ${block});`,
    forwardRef: `export const C = forwardRef(function C(${params}) ${block});`,
    default: `export default function C(${params}) ${block}`,
    async: `export async function C(${params}) ${block}`,
  }[shape];
  return `${prelude}${module}\n${declaration}\n`;
}

export function hook({ params = "", body = "", module = "" }: Case, companion: boolean): string {
  return `${prelude}${module}\nexport function useX(${params}) {\n${marker}\n${body}\nreturn ${companion ? "o.value" : "0"};\n}\n`;
}

// The custom-Hook variant: no JSX, and the unrelated read is the Hook's return.
export const hookCases = cases.filter(
  (testCase) =>
    (testCase.shape ?? "function") === "function" &&
    (testCase.body !== undefined || testCase.params !== undefined) &&
    !(testCase.jsx ?? "").includes("<") &&
    !(testCase.module ?? "").includes("<") &&
    !(testCase.body ?? "").includes("<"),
);
