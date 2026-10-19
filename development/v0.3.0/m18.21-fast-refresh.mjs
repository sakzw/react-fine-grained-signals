import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const repo = resolve(import.meta.dirname, "../..");
const root = await mkdtemp(join(repo, ".m18.21-hmr-"));
const source = (factor) => `import { useState } from "react";
import { useComputed, useSignalEffect, useSignalValue } from "react-fine-grained-signals";
import { count } from "./signal-store";

const factor = ${factor};
export function Counter() {
  const [local, setLocal] = useState(0);
  const doubled = useComputed(() => count.value * factor, [factor]);
  const writable = useComputed({
    get: () => count.value * factor,
    set: (next) => {
      window.hmrMetrics.setterCalls += 1;
      count.value = next / factor;
      window.hmrMetrics.sourceAfterSetter = count.value;
    },
  }, [factor]);
  useSignalEffect(() => {
    count.value;
    window.hmrMetrics.effectSetups += 1;
    window.hmrMetrics.effectActive += 1;
    return () => {
      window.hmrMetrics.effectCleanups += 1;
      window.hmrMetrics.effectActive -= 1;
    };
  }, [factor]);
  const doubledValue = useSignalValue(doubled);
  const writableValue = useSignalValue(writable);
  window.hmrMetrics.renders += 1;
  return <section data-testid="counter">
    <output data-testid="local">{local}</output>
    <output data-testid="computed">{doubledValue}</output>
    <output data-testid="writable">{writableValue}</output>
    <button id="local-increment" onClick={() => setLocal((value) => value + 1)}>local +1</button>
    <button id="writable-set" onClick={() => { writable.value = 30; }}>set writable</button>
  </section>;
}

export default function App() {
  const [shown, setShown] = useState(true);
  return <main>
    <button id="toggle" onClick={() => setShown((value) => !value)}>toggle</button>
    <button id="signal-increment" onClick={() => { count.value += 1; }}>signal +1</button>
    {shown ? <Counter /> : <p data-testid="hidden">hidden</p>}
  </main>;
}
`;
const html = `<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`;
const main = `import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
window.hmrMetrics = { renders: 0, effectSetups: 0, effectCleanups: 0, effectActive: 0, setterCalls: 0, sourceAfterSetter: null, reactVersion: React.version };
createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);
`;

let server;
let browser;
try {
  await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, "src"), { recursive: true }));
  await writeFile(join(root, "index.html"), html);
  await writeFile(join(root, "src", "main.tsx"), main);
  await writeFile(join(root, "src", "App.tsx"), source(2));
  await writeFile(join(root, "src", "signal-store.ts"), `import { signal } from "react-fine-grained-signals";\nexport const count = signal(1);\n`);

  server = await createServer({
    configFile: false,
    root,
    appType: "spa",
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: true },
    optimizeDeps: { include: ["react", "react-dom/client"] },
    resolve: {
      dedupe: ["react", "react-dom"],
      alias: [{ find: "react-fine-grained-signals", replacement: join(repo, "dist", "index.js") }],
    },
    plugins: [react()],
  });
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === "string") throw new Error("Vite did not bind a local port");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") errors.push(`${message.type()}: ${message.text()}`);
  });
  const url = `http://127.0.0.1:${address.port}`;
  await page.goto(url, { waitUntil: "commit" });
  await page.getByTestId("counter").waitFor();
  await page.waitForFunction(() => window.hmrMetrics.effectActive === 1);
  if (await page.getByTestId("computed").textContent() !== "2") throw new Error("initial getter value mismatch");

  await page.locator("#local-increment").click();
  await page.locator("#writable-set").click();
  await page.waitForTimeout(100);
  const afterInitialWrite = await page.evaluate(() => ({
    computed: document.querySelector('[data-testid="computed"]')?.textContent,
    writable: document.querySelector('[data-testid="writable"]')?.textContent,
    metrics: { ...window.hmrMetrics },
  }));
  if (afterInitialWrite.computed !== "30") throw new Error(`initial writable setter did not update source: ${JSON.stringify({ ...afterInitialWrite, errors })}`);
  const beforeHmr = await page.evaluate(() => ({ ...window.hmrMetrics }));
  await writeFile(join(root, "src", "App.tsx"), source(3));
  await page.waitForFunction(() => document.querySelector('[data-testid="computed"]')?.textContent === "45");
  if (await page.getByTestId("writable").textContent() !== "45") throw new Error("HMR did not install the new writable getter");
  if (await page.getByTestId("local").textContent() !== "1") throw new Error("same-shape HMR failed to preserve component state");
  await page.waitForFunction(({ setups, cleanups }) =>
    window.hmrMetrics.effectSetups > setups
      && window.hmrMetrics.effectCleanups > cleanups
      && window.hmrMetrics.effectActive === 1,
  { setups: beforeHmr.effectSetups, cleanups: beforeHmr.effectCleanups });

  await page.locator("#writable-set").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="writable"]')?.textContent === "30");
  if (await page.getByTestId("computed").textContent() !== "30") throw new Error("HMR retained the old writable setter closure");
  const setupsBeforeSignal = await page.evaluate(() => window.hmrMetrics.effectSetups);
  await page.locator("#signal-increment").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="computed"]')?.textContent === "33");
  await page.waitForFunction((setups) => window.hmrMetrics.effectSetups === setups + 1, setupsBeforeSignal);
  if (await page.evaluate(() => window.hmrMetrics.effectActive) !== 1) throw new Error("Signal update duplicated the effect subscription");

  await page.locator("#toggle").click();
  await page.getByTestId("hidden").waitFor();
  await page.waitForFunction(() => window.hmrMetrics.effectActive === 0);
  const rendersAfterUnmount = await page.evaluate(() => window.hmrMetrics.renders);
  await page.locator("#signal-increment").click();
  await page.waitForTimeout(100);
  if (await page.evaluate(() => window.hmrMetrics.renders) !== rendersAfterUnmount) throw new Error("unmounted component rendered after Signal update");
  await page.locator("#toggle").click();
  await page.getByTestId("counter").waitFor();
  await page.waitForFunction(() => window.hmrMetrics.effectActive === 1);
  if (errors.length) throw new Error(`browser console errors: ${errors.join("\n")}`);
  console.log(JSON.stringify({
    status: "passed",
    vite: (await import("vite")).version,
    react: await page.evaluate(() => window.hmrMetrics.reactVersion),
    localStateAfterHmr: await page.getByTestId("local").textContent(),
    computedAfterHmr: await page.getByTestId("computed").textContent(),
    effectMetrics: await page.evaluate(() => ({ ...window.hmrMetrics })),
    consoleErrors: errors,
  }, null, 2));
  await page.close();
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  await rm(root, { recursive: true, force: true });
}
