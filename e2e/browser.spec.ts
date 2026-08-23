import { expect, test, type Page } from "@playwright/test";

async function openHydrated(page: Page) {
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

test("serves deterministic React SSR markup", async ({ request }) => {
  const response = await request.get("/");
  expect(response.ok()).toBe(true);
  const html = await response.text();

  expect(html).toContain('id="signal-child">0</output>');
  expect(html).toContain('id="bound-button" title="initial title"');
  expect(html).toContain('data-status="idle"');
  expect(html).not.toContain("data-hydrated");
});

test("hydrates without warnings and updates automatic component subscribers", async ({ page }) => {
  const errors = await openHydrated(page);

  await expect(page.locator("#signal-child")).toHaveText("0");
  await expect(page.locator("#parent-renders")).toHaveText("1");
  await page.locator("#increment-signal-child").click();
  await expect(page.locator("#signal-child")).toHaveText("1");
  await expect(page.locator("#parent-renders")).toHaveText("1");

  const customValue = page.locator("#custom-value");
  await expect(customValue).toHaveAttribute("data-received-signal", "true");
  await expect(customValue).toHaveText("custom initial");
  await page.locator("#update-custom-component").click();
  await expect(customValue).toHaveText("custom updated");
  await expect(page.locator("#parent-renders")).toHaveText("1");
  expect(errors).toEqual([]);
});

test("updates allowlisted host properties without a React rerender", async ({ page }) => {
  const errors = await openHydrated(page);
  const boundButton = page.locator("#bound-button");

  await expect(boundButton).toBeVisible();
  await expect(boundButton).toBeEnabled();
  await expect(boundButton).toHaveAttribute("title", "initial title");
  await expect(boundButton).toHaveAttribute("data-status", "idle");

  await page.locator("#toggle-bindings").click();
  await expect(boundButton).toBeHidden();
  await expect(boundButton).toBeDisabled();
  await expect(boundButton).toHaveAttribute("title", "updated title");
  await expect(boundButton).toHaveAttribute("data-status", "active");
  await expect(page.locator("#parent-renders")).toHaveText("1");
  expect(errors).toEqual([]);
});

test("cleans a StrictMode host binding after unmount", async ({ page }) => {
  const errors = await openHydrated(page);
  const binding = page.locator("#detached-binding");
  const detachedHandle = await binding.elementHandle();
  expect(detachedHandle).not.toBeNull();
  await expect(binding).toHaveAttribute("title", "lifecycle initial");

  await page.locator("#update-detached-signal").click();
  await expect(binding).toHaveAttribute("title", "lifecycle updated");

  await page.locator("#unmount-binding").click();
  await expect(binding).toHaveCount(0);
  await page.locator("#update-detached-signal").click();

  const detachedTitle = await detachedHandle?.evaluate((element) =>
    element.getAttribute("title"),
  );
  expect(detachedTitle).toBe("lifecycle updated");
  expect(errors).toEqual([]);
});

test("paints a signal-bound style prop with real computed layout", async ({ page }) => {
  const errors = await openHydrated(page);
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

test("keeps real-browser IME composition text intact across an external signal write", async ({ page }) => {
  const errors = await openHydrated(page);
  const input = page.locator("#ime-field");

  await expect(input).toHaveValue("initial");
  await input.focus();

  await input.evaluate((el: HTMLInputElement, text) => {
    el.dispatchEvent(new CompositionEvent("compositionstart"));
    // The browser renders composing IME candidates directly into `.value`
    // without necessarily running them through `onChange` on every keystroke.
    el.value = text;
  }, "こんに");
  await expect(input).toHaveValue("こんに");

  // Another subscriber of the same signal writing back mid-composition —
  // not the input's own onChange — must not stomp the composing text.
  await page.locator("#external-ime-write").click();
  await expect(input).toHaveValue("こんに");

  await input.evaluate((el: HTMLInputElement) => {
    el.dispatchEvent(new CompositionEvent("compositionend"));
  });
  await expect(input).toHaveValue("external update");
  expect(errors).toEqual([]);
});
