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

test("preserves bound form reset behavior in the production bundle", async ({
  page,
}) => {
  const errors = await openApp(page);
  const form = page.locator("#bound-reset-form");
  const input = page.locator("#bound-reset-text");
  const checkbox = page.locator("#bound-reset-checkbox");
  const signals = page.locator("#bound-reset-signals");

  await page.locator("#bound-reset-submit").click();
  await expect(input).toHaveValue("signal updated");
  await expect(checkbox).toBeChecked();
  await form.locator("button[type=reset]").click();
  await expect(input).toHaveValue("signal updated");
  await expect(checkbox).toBeChecked();

  await page.locator("#bound-reset-action").click();
  await expect(input).toHaveValue("action value");
  await expect(checkbox).toBeChecked();
  await expect(signals).toHaveAttribute("data-text", "action value");
  await expect(signals).toHaveAttribute("data-checked", "true");

  await input.fill("accepted edit");
  await checkbox.uncheck();
  await expect(signals).toHaveAttribute("data-text", "accepted edit");
  await expect(signals).toHaveAttribute("data-checked", "false");
  await form.locator("button[type=reset]").click();
  await expect(input).toHaveValue("reset initial");
  await expect(checkbox).not.toBeChecked();
  await expect(signals).toHaveAttribute("data-text", "accepted edit");
  await expect(signals).toHaveAttribute("data-checked", "false");
  expect(errors).toEqual([]);
});

test("paints a signal-bound style prop in the production bundle", async ({
  page,
}) => {
  const errors = await openApp(page);
  const styledBox = page.locator("#styled-box");

  await expect(styledBox).toHaveCSS("width", "80px");
  await expect(styledBox).toHaveCSS("height", "40px");
  await expect(styledBox).toHaveCSS("background-color", "rgb(70, 130, 180)");

  const initialBox = await styledBox.boundingBox();
  expect(initialBox?.width).toBeCloseTo(80, 0);
  expect(initialBox?.height).toBeCloseTo(40, 0);

  await page.locator("#toggle-style").click();
  await expect(styledBox).toHaveCSS("width", "160px");
  await expect(styledBox).toHaveCSS("background-color", "rgb(46, 139, 87)");

  const updatedBox = await styledBox.boundingBox();
  expect(updatedBox?.width).toBeCloseTo(160, 0);
  expect(errors).toEqual([]);
});
