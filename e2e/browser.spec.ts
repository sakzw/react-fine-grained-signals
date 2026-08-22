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

test("hydrates without warnings and updates leaf subscribers", async ({ page }) => {
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
