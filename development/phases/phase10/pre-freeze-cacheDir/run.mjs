import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const configFile = fileURLToPath(new URL("./vite.config.mjs", import.meta.url));
const sourceFile = new URL("./app/src/main.jsx", import.meta.url);
const cacheMetadata = new URL("./.vite-cache/deps/_metadata.json", import.meta.url);
const initialSource = await readFile(sourceFile, "utf8");
const server = await createServer({ configFile });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const browserErrors = [];
page.on("pageerror", (error) => browserErrors.push(error.message));

try {
  await server.listen();
  await page.goto("http://127.0.0.1:4189/", { waitUntil: "networkidle" });
  await page.getByText("cacheDir-HMR-A").waitFor();

  let metadata;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      metadata = JSON.parse(await readFile(cacheMetadata, "utf8"));
      if (Object.keys(metadata.optimized ?? {}).length >= 3) break;
    } catch {}
    await delay(250);
  }
  assert.ok(metadata, "Vite should write optimized dependency metadata to external cacheDir");
  const optimized = Object.keys(metadata.optimized ?? {});
  assert.ok(optimized.includes("react"), `react should be optimized; saw ${optimized.join(", ")}`);
  assert.ok(optimized.some((id) => id.startsWith("react-dom")), `react-dom should be optimized; saw ${optimized.join(", ")}`);
  assert.ok(optimized.some((id) => id.startsWith("alien-signals/system")), `alien-signals/system should be optimized; saw ${optimized.join(", ")}`);

  await page.locator("#local").click();
  await page.getByText("local:1").waitFor();

  const oldSource = await readFile(sourceFile, "utf8");
  await writeFile(sourceFile, oldSource.replace("cacheDir-HMR-A", "cacheDir-HMR-B"));
  await page.getByText("cacheDir-HMR-B").waitFor({ timeout: 15000 });
  assert.deepEqual(browserErrors, [], `browser errors: ${browserErrors.join(" | ")}`);

  const transformed = await server.transformRequest("/src/main.jsx");
  assert.ok(transformed, "Vite should serve a transformed source module");
  const warningTransform = await server.transformRequest("/src/warning.jsx");
  assert.ok(warningTransform, "Vite dev transform should report the diagnostic without throwing");
  console.log(JSON.stringify({
    vite: server.config.version,
    cacheDir: server.config.cacheDir,
    optimizedDependencies: optimized,
    hmrRevision: await page.locator("#revision").textContent(),
    signalValueAfterHmr: await page.locator("#signal").textContent(),
    reactStateAfterHmr: await page.locator("#local").textContent(),
    browserErrors,
    viteDevWarningTransform: "completed",
    transformedModuleServed: true,
  }, null, 2));
} finally {
  await writeFile(sourceFile, initialSource);
  await browser.close();
  await server.close();
  await rm(new URL("./.vite-cache/", import.meta.url), { recursive: true, force: true });
}
