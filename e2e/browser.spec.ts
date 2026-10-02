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
  // Detaching hands the node back to the value React rendered, and the
  // binding no longer follows the signal.
  expect(detachedTitle).toBe("lifecycle initial");
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

/**
 * The page logged React's report of the error the boundary caught, and
 * nothing else. Chromium includes the error's message in that report while
 * Firefox only prints `Error`, so the boundary's rendered message is what
 * shows the original error reached React.
 */
function expectOnlyBoundaryReport(errors: string[], expected: string) {
  expect(errors.some((message) => message.includes("RefErrorBoundary"))).toBe(true);
  expect(
    errors.filter(
      (message) => !message.includes(expected) && !message.includes("RefErrorBoundary"),
    ),
  ).toEqual([]);
}

test("stops following a signal after a user ref cleanup throws on unmount", async ({ page }) => {
  const errors = await openHydrated(page);
  const target = page.locator("#ref-cleanup-target");
  const handle = await target.elementHandle();
  await expect(target).toHaveAttribute("title", "ref initial");

  await page.locator("#unmount-ref-cleanup-target").click();
  // React still receives the user's error, through the error boundary.
  await expect(page.locator("#ref-cleanup-error")).toHaveText("ref cleanup boom");
  await page.locator("#write-ref-error-signal").click();

  expect(await handle?.evaluate((element) => element.getAttribute("title"))).toBe("ref initial");
  expectOnlyBoundaryReport(errors, "ref cleanup boom");
});

test("stops following a signal after a user ref throws while attaching", async ({ page }) => {
  const errors = await openHydrated(page);
  // The element is gone again by the time the boundary renders; keep it.
  await page.evaluate(() => {
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && node.id === "ref-attach-target") {
            (window as unknown as { attachTarget: Element }).attachTarget = node;
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });

  await page.locator("#mount-ref-attach-target").click();
  await expect(page.locator("#ref-attach-error")).toHaveText("ref attach boom");
  await page.locator("#write-ref-error-signal").click();

  const title = await page.evaluate(
    () => (window as unknown as { attachTarget?: Element }).attachTarget?.getAttribute("title"),
  );
  expect(title).toBe("ref initial");
  expectOnlyBoundaryReport(errors, "ref attach boom");
});

test("clears a style key dropped while an Activity boundary hid the element", async ({ page }) => {
  const errors = await openHydrated(page);
  const box = page.locator("#activity-box");
  await expect(box).toHaveCSS("outline-style", "solid");

  await page.locator("#hide-activity-box").click();
  await expect(box).toBeHidden();
  await page.locator("#drop-activity-key").click();
  await page.locator("#reveal-activity-box").click();

  await expect(box).toBeVisible();
  await expect(box).toHaveCSS("outline-style", "none");
  await expect(box).toHaveCSS("width", "80px");
  expect(await box.getAttribute("style")).toBe("width: 80px; height: 40px;");
  expect(errors).toEqual([]);
});

test("clears a style key dropped while a Suspense boundary hid the element", async ({ page }) => {
  const errors = await openHydrated(page);
  const box = page.locator("#suspense-box");
  await expect(box).toHaveCSS("display", "flex");

  await page.locator("#suspend-box").click();
  await expect(page.locator("#suspense-box-fallback")).toBeVisible();
  await expect(box).toBeHidden();
  await page.locator("#drop-suspense-display").click();
  await page.locator("#resume-box").click();

  await expect(page.locator("#suspense-box-fallback")).toHaveCount(0);
  await expect(box).toBeVisible();
  await expect(box).toHaveCSS("display", "block");
  await expect(box).toHaveCSS("color", "rgb(0, 128, 0)");
  expect(errors).toEqual([]);
});
