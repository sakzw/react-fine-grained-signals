// Recheck whether an unmounted form host is retained by JSDOM, React, or RFSG.
// Run from the repository root with: node --expose-gc development/v0.3.0/m16-jsdom-host-retention-recheck.mjs
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { jsx, jsxs } from "../../dist/jsx-runtime.js";
import { signal } from "../../dist/index.js";

if (typeof globalThis.gc !== "function") {
  throw new Error("Run this script with node --expose-gc");
}

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
});
Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
Object.defineProperty(globalThis, "MutationObserver", {
  configurable: true,
  value: dom.window.MutationObserver,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function createElementFor(kind, variant) {
  if (kind === "input") {
    return variant === "react"
      ? React.createElement("input", { value: "text", onChange() {} })
      : jsx("input", { bindValue: signal("text") });
  }

  const options = [
    jsx("option", { value: "a", children: "A" }),
    jsx("option", { value: "b", children: "B" }),
    jsx("option", { value: "c", children: "C" }),
  ];
  return variant === "react"
    ? React.createElement("select", { multiple: true, value: ["a", "c"], onChange() {} }, ...options)
    : jsxs("select", { multiple: true, bindValue: signal(["a", "c"]), children: options });
}

async function collectHosts(kind, variant) {
  const refs = [];
  for (let index = 0; index < 12; index++) {
    const container = document.createElement("div");
    document.body.append(container);
    let root = createRoot(container);
    await act(() => flushSync(() => root.render(createElementFor(kind, variant))));
    let host = container.firstElementChild;
    if (host === null) throw new Error(`${variant} ${kind} host did not mount`);
    refs.push(new WeakRef(host));
    await act(() => flushSync(() => root.unmount()));
    container.remove();
    host = null;
    root = null;
  }

  for (let pass = 0; pass < 6; pass++) {
    globalThis.gc();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { total: refs.length, survivors: refs.filter((ref) => ref.deref() !== undefined).length };
}

for (const kind of ["input", "select"]) {
  for (const variant of ["react", "rfsg"]) {
    console.log(`${variant} ${kind}`, await collectHosts(kind, variant));
  }
}
dom.window.close();
