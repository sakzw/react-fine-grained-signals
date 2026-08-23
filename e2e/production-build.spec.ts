import { expect, test, type Page } from "@playwright/test";

// This spec exercises the *production* build path — a real `vite build`
// (bundling, tree-shaking, minification) served statically via
// `vite preview` on port 4174 — as opposed to e2e/browser.spec.ts, which
// only ever runs against Vite's dev/middleware-mode server. It proves the
// built/minified bundle's Proxy/WeakMap-based signal runtime and custom JSX
// transform still work correctly outside of dev mode.
//
// This build is client-only (see examples/browser/vite.config.ts and
// entry-production.tsx), so there is no SSR markup to assert on and no
// hydration step — the app mounts fresh into an empty `#root`.

async function openApp(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
  expect(errors).toEqual([]);
  return errors;
}

test("mounts the production bundle and updates a signal-driven counter", async ({
  page,
}) => {
  const errors = await openApp(page);

  await expect(page.locator("#signal-child")).toHaveText("0");
  await page.locator("#increment-signal-child").click();
  await expect(page.locator("#signal-child")).toHaveText("1");
  await page.locator("#increment-signal-child").click();
  await expect(page.locator("#signal-child")).toHaveText("2");
  expect(errors).toEqual([]);
});

test("updates allowlisted host properties directly in the minified bundle", async ({
  page,
}) => {
  const errors = await openApp(page);
  const boundButton = page.locator("#bound-button");

  await expect(boundButton).toHaveAttribute("title", "initial title");
  await expect(boundButton).toHaveAttribute("data-status", "idle");

  await page.locator("#toggle-bindings").click();

  await expect(boundButton).toHaveAttribute("title", "updated title");
  await expect(boundButton).toHaveAttribute("data-status", "active");
  await expect(boundButton).toBeHidden();
  await expect(boundButton).toBeDisabled();
  expect(errors).toEqual([]);
});
