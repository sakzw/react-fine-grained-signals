import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  mightTransform,
  transformReactFineGrainedSignals,
  type ReactFineGrainedSignalsMode,
  type ReactFineGrainedSignalsTransform,
} from "../src/internal/transform.js";
import { cases, component, hook } from "./read-shapes.js";

// `prefilter-guard.ts` (a setup file) checks every transform any test runs:
// when `mightTransform` drops a module, the transform without the screen must
// neither change it nor report anything. This file adds the corpora no other
// test transforms in every mode -- the examples and the read shapes -- and
// pins the screen's rule on its own.

const modes: ReactFineGrainedSignalsMode[] = ["auto", "all", "manual"];
const transforms: ReactFineGrainedSignalsTransform[] = ["managed", "inject"];

function transformEverywhere(code: string, id: string): void {
  for (const mode of modes) {
    for (const transform of transforms) {
      try {
        transformReactFineGrainedSignals(code, id, {
          importSource: "react-fine-grained-signals",
          mode,
          transform,
          reactCompiler: "opt-out",
          reactImportSource: "react",
          warn: () => {},
        });
      } catch (error) {
        // Only the guard's own failure matters here; a module a mode cannot
        // handle (an annotated async function, say) throws by design.
        if (String(error).includes("mightTransform rejected")) throw error;
      }
    }
  }
}

// The tracked sources only: build output under the examples is ignored.
const root = fileURLToPath(new URL("../../..", import.meta.url));
const examples = execFileSync("git", ["ls-files", "examples"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((path) => /\.[cm]?[jt]sx?$/.test(path) && !path.endsWith(".d.ts"));

describe("the raw-text screen never drops a module the transform acts on", () => {
  it.each(examples)("%s", (path) => {
    expect(() => transformEverywhere(readFileSync(join(root, path), "utf8"), path)).not.toThrow();
  });

  it.each(cases)("read shape: $name", (testCase) => {
    for (const source of [component(testCase, false), component(testCase, true), hook(testCase, false)]) {
      expect(() => transformEverywhere(source, "Shape.tsx")).not.toThrow();
    }
  });
});

describe("a module whose only .value follows a name like a DOM or ref field", () => {
  // Nothing else in the file may read `value`: the screen is judging these alone.
  const module = (declaration: string, body: string, jsx: string): string =>
    `import { signal } from "react-fine-grained-signals";
${declaration}
export function A() { ${body} return <p>${jsx}</p>; }
`;
  it.each([
    ["a spread", module("const target = signal([1]);", "const x = [...target.value].length;", "{x}")],
    ["a JSX spread", module("const current = signal({});", "", "<b {...current.value} />")],
    ["a call spread", module("const current = signal([1]);", "const x = Math.max(...current.value);", "{x}")],
    [
      "a read after a comment that ends in a period",
      module("const current = signal(1);", "const x = // the one.\n current.value;", "{x}"),
    ],
    ["a read after a line comment", module("const s = signal(1);", "const x = s. // note\n value;", "{x}")],
    ["a line comment ending in CR", module("const s = signal(1);", "const x = s. // note\r value;", "{x}")],
    ["a line comment ending in U+2028", module("const s = signal(1);", "const x = s. // note\u2028 value;", "{x}")],
  ])("selects a component whose only read is %s", (_kind, source) => {
    expect(source.match(/value/g)).toHaveLength(1);
    expect(mightTransform(source, "auto")).toBe(true);
    const output = transformReactFineGrainedSignals(source, "A.tsx", {
      importSource: "react-fine-grained-signals",
      mode: "auto",
      transform: "managed",
      reactCompiler: "off",
      reactImportSource: "react",
      warn: () => {},
    })?.code;
    expect(output).toContain("useSignalCapture()");
    expect(output).toContain("_signals.capture(");
  });
});

describe("mightTransform", () => {
  it.each([
    ["a member read", "x.value"],
    ["an optional member read", "x?.value"],
    ["whitespace after the dot", "x.\n  value"],
    ["a block comment after the dot", "x./* note */value"],
    ["a line comment after the dot", "x. // note\n  value"],
    ["a computed string key", 'x["value"]'],
    ["a single-quoted key", "x['value']"],
    ["a template key", "x[`value`]"],
    ["a constant key", 'const key = "value"; x[key]'],
    ["a JSX member tag", "<theme.value.Icon />"],
    ["a DOM field after a signal read", "holder.value.current.value"],
    ["an identifier named target", "target.value"],
    ["a unicode escape", "x.v\\u0061lue"],
    ["an identity escape in a key", 'x["v\\alue"]'],
    ["a line comment ending in CR", "x. // note\r  value"],
    ["a line comment ending in CRLF", "x. // note\r\n  value"],
    ["a line comment ending in U+2028", "x. // note\u2028value"],
    ["a line comment ending in U+2029", "x. // note\u2029value"],
    ["a spread of a name like a DOM field", "[...target.value]"],
    ["a JSX spread of a name like a ref", "<p {...current.value} />"],
    ["a call spread of a name like a ref", "f(...current.value)"],
    ["a comment ending in a period before a name", "const x = // the one.\n current.value;"],
    ["an event target", "onChange={(e) => set(e.target.value)}"],
    ["an optional event target", "e?.target?.value"],
    ["a current target", "e.currentTarget.value"],
    ["a ref", "ref.current.value"],
    ["an opt-in call", "useSignalTracking();"],
    ["an annotation", "/** @signalTracking */"],
    ["an opt-out annotation", "/** @noSignalTracking */"],
    ["a server directive", '"use server";'],
  ])("passes %s", (_kind, code) => {
    expect(mightTransform(code, "auto")).toBe(true);
  });

  it.each([
    ["an object key", "const o = { value: 1 };"],
    ["a shorthand key and a destructuring", "const { value } = o; f({ value });"],
    ["a JSX attribute", "<input value={text} />"],
    ["longer names", "x.values; x.valueOf(); x.defaultValue; valueKey"],
    ["a string that only contains the word", '"a value here"'],
    ["a private field", "this.#value"],
  ])("drops %s", (_kind, code) => {
    expect(mightTransform(code, "auto")).toBe(false);
  });

  it("keeps the mode rules", () => {
    expect(mightTransform("x.value", "manual")).toBe(false);
    expect(mightTransform("<p />", "all")).toBe(true);
    expect(mightTransform("<p />", "auto")).toBe(false);
    expect(mightTransform('"use server";', "manual")).toBe(false);
  });

  it("passes a manual-mode opt-in spelled with an escape, and keeps the fast path otherwise", () => {
    expect(mightTransform('import { use\\u0053ignalTracking } from "x";', "manual")).toBe(true);
    expect(mightTransform('import { use\\u{53}ignalTracking } from "x";', "manual")).toBe(true);
    expect(mightTransform('import { "use\\x53ignalTracking" as t } from "x";', "manual")).toBe(true);
    const ordinary = 'const text = "line\\n\\ttab\\"quote\\\\"; const re = /\\d+\\s/; x.value; <p />;';
    expect(mightTransform(ordinary, "manual")).toBe(false);
  });

  it("transforms that opt-in in manual mode, as written without the escape", () => {
    const opts = {
      importSource: "react-fine-grained-signals",
      mode: "manual",
      transform: "managed",
      reactCompiler: "opt-out",
      reactImportSource: "react",
    } as const;
    const source = (name: string): string =>
      `import { ${name} as track } from "react-fine-grained-signals";\nexport function A({ s }) { track(); return <p>{s.value}</p>; }`;
    const escaped = transformReactFineGrainedSignals(source("use\\u0053ignalTracking"), "A.tsx", opts)?.code;
    const plain = transformReactFineGrainedSignals(source("useSignalTracking"), "A.tsx", opts)?.code;
    expect(plain).toContain('"use no memo"');
    expect(escaped).toContain('"use no memo"');
  });
});
