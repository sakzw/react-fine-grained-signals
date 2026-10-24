import { expect, test, type Page } from "@playwright/test";

async function openHydrated(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  // The first Firefox navigation may include Vite's cold dependency optimizer
  // startup, which has exceeded Playwright's 30s default on fresh workers.
  await page.goto("/", { timeout: 60_000 });
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
  expect(html).toContain('id="number-bound-input"');
  expect(html).toContain('value="1.5"');
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

test("keeps React input and change events when a writable computed rejects text", async ({ page }) => {
  const errors = await openHydrated(page);
  const input = page.locator("#computed-form-input");

  await expect(input).toHaveValue("123");
  await input.press("End");
  await input.press("x");
  await expect(input).toHaveValue("123");
  await expect(page.locator("#computed-form-source")).toHaveText("123");
  await expect(page.locator("#computed-form-input-count")).toHaveText("1");
  await expect(page.locator("#computed-form-change-count")).toHaveText("1");

  await input.press("4");
  await expect(input).toHaveValue("1234");
  await expect(page.locator("#computed-form-source")).toHaveText("1234");
  await expect(page.locator("#computed-form-input-count")).toHaveText("2");
  await expect(page.locator("#computed-form-change-count")).toHaveText("2");
  expect(errors).toEqual([]);
});

test("binds number input strings while leaving sanitization and constraints to the browser", async ({ page }) => {
  const errors = await openHydrated(page);
  const input = page.locator("#number-bound-input");
  const signalValue = page.locator("#number-bound-signal");
  const parsed = page.locator("#number-bound-parsed");
  const validity = async () => input.evaluate((node: HTMLInputElement) => ({
    badInput: node.validity.badInput,
    rangeUnderflow: node.validity.rangeUnderflow,
    rangeOverflow: node.validity.rangeOverflow,
    stepMismatch: node.validity.stepMismatch,
    valueMissing: node.validity.valueMissing,
  }));

  await expect(input).toHaveValue("1.5");
  await expect(signalValue).toHaveText("1.5");
  await expect(parsed).toHaveText("1.5");
  await expect(page.locator("#number-bound-owner-renders")).toHaveText("1");

  await input.fill("2.25");
  await expect(input).toHaveValue("2.25");
  await expect(signalValue).toHaveText("2.25");
  await expect(parsed).toHaveText("2.25");
  expect((await validity()).stepMismatch).toBe(true);

  await input.fill("-1");
  expect((await validity()).rangeUnderflow).toBe(true);
  await expect(signalValue).toHaveText("-1");
  await input.fill("11");
  expect((await validity()).rangeOverflow).toBe(true);
  await expect(signalValue).toHaveText("11");

  await input.fill("");
  expect((await validity()).valueMissing).toBe(true);
  await expect(signalValue).toHaveText("");
  await expect(parsed).toHaveText("empty");

  await page.locator("#number-bound-write").click();
  await expect(input).toHaveValue("3.5");
  await expect(signalValue).toHaveText("3.5");
  await input.fill("4.5");
  await expect(signalValue).toHaveText("4.5");

  // stepUp/stepDown mutate the native value but do not dispatch input by
  // themselves. An input event brings an application-driven step change into
  // the binding just like the user's native spinner interaction does.
  await input.evaluate((node: HTMLInputElement) => node.stepUp());
  await expect(input).toHaveValue("5");
  await expect(signalValue).toHaveText("4.5");
  await input.dispatchEvent("input");
  await expect(signalValue).toHaveText("5");
  await input.evaluate((node: HTMLInputElement) => node.stepDown());
  await input.dispatchEvent("input");
  await expect(signalValue).toHaveText("4.5");

  await page.locator("#number-bound-reset").click();
  await expect(input).toHaveValue("4.5");
  await expect(signalValue).toHaveText("4.5");
  await expect(page.locator("#number-bound-owner-renders")).toHaveText("1");
  expect(errors).toEqual([]);
});

test("cancels a rejected input correction when onChange rebinds the same node", async ({ page }) => {
  const errors = await openHydrated(page);
  const input = page.locator("#rebound-form-input");

  await expect(input).toHaveValue("123");
  await input.press("End");
  await input.press("x");
  await expect(page.locator("#rebound-form-current-value")).toHaveText("123x");
  await expect(input).toHaveValue("123x");
  expect(errors).toEqual([]);
});

test("synchronizes radio and checkbox groups through explicit value bindings", async ({ page }) => {
  const errors = await openHydrated(page);
  const radioA = page.locator("#group-radio-a");
  const radioB = page.locator("#group-radio-b");
  const checkboxA = page.locator("#group-checkbox-a");
  const checkboxB = page.locator("#group-checkbox-b");

  await expect(radioA).toBeChecked();
  await expect(radioB).not.toBeChecked();
  await radioA.focus();
  await page.keyboard.press("ArrowRight");
  await expect(radioB).toBeChecked();
  await expect(page.locator("#group-choice-value")).toHaveText("b");

  await expect(checkboxA).toBeChecked();
  await expect(checkboxB).not.toBeChecked();
  await checkboxB.check();
  await expect(checkboxB).toBeChecked();
  await expect(page.locator("#group-selected-values")).toHaveText("a,b");
  await checkboxA.uncheck();
  await expect(page.locator("#group-selected-values")).toHaveText("b");

  const data = await page.locator("#input-value-groups").evaluate((form) => Object.fromEntries(new FormData(form as HTMLFormElement).entries()));
  expect(data).toEqual({ "group-choice": "b", "group-features": "b" });
  await page.locator("#input-value-groups").evaluate((form) => (form as HTMLFormElement).reset());
  await expect(radioB).toBeChecked();
  await expect(checkboxA).not.toBeChecked();
  await expect(checkboxB).toBeChecked();
  expect(errors).toEqual([]);
});

test("keeps same-name radios independent when their native form owners differ", async ({ page }) => {
  const errors = await openHydrated(page);
  const first = page.locator("#independent-radio-a");
  const second = page.locator("#independent-radio-b");
  const signals = page.locator("#independent-radio-signals");

  await expect(first).toBeChecked();
  await expect(second).toBeChecked();
  await expect(signals).toHaveText("a|b");

  await first.click();

  await expect(first).toBeChecked();
  await expect(second).toBeChecked();
  await expect(signals).toHaveText("a|b");
  expect(errors).toEqual([]);
});

test("keeps bound form reset defaults synchronized with accepted edits", async ({ page }) => {
  const errors = await openHydrated(page);
  const form = page.locator("#bound-reset-form");
  const input = page.locator("#bound-reset-text");
  const checkbox = page.locator("#bound-reset-checkbox");
  const single = page.locator("#bound-reset-choice");
  const multiple = page.locator("#bound-reset-choices");
  const signals = page.locator("#bound-reset-signals");

  await page.locator("#bound-reset-submit").click();
  await expect(input).toHaveValue("signal updated");
  await expect(checkbox).toBeChecked();
  await expect(single).toHaveValue("c");
  await expect(multiple.locator("option:checked")).toHaveCount(2);
  await form.locator("button[type=reset]").click();
  await expect(input).toHaveValue("signal updated");
  await expect(checkbox).toBeChecked();
  await expect(single).toHaveValue("c");
  await expect(multiple.locator("option:checked")).toHaveCount(2);

  await page.locator("#bound-reset-action").click();
  await expect(input).toHaveValue("action value");
  await expect(checkbox).toBeChecked();
  await expect(signals).toHaveAttribute("data-text", "action value");
  await expect(signals).toHaveAttribute("data-checked", "true");
  await expect(single).toHaveValue("b");
  await expect(multiple.locator("option:checked")).toHaveText(["B", "C"]);
  await expect(signals).toHaveAttribute("data-choice", "b");
  await expect(signals).toHaveAttribute("data-choices", "b,c");

  await input.fill("accepted edit");
  await checkbox.uncheck();
  await single.selectOption("a");
  await multiple.selectOption(["a", "c"]);
  await expect(signals).toHaveAttribute("data-text", "accepted edit");
  await expect(signals).toHaveAttribute("data-checked", "false");
  await expect(signals).toHaveAttribute("data-choice", "a");
  await expect(signals).toHaveAttribute("data-choices", "a,c");
  await form.locator("button[type=reset]").click();

  // Accepted edits update the signal, which also updates the reset defaults.
  await expect(input).toHaveValue("accepted edit");
  await expect(checkbox).not.toBeChecked();
  await expect(signals).toHaveAttribute("data-text", "accepted edit");
  await expect(signals).toHaveAttribute("data-checked", "false");
  await expect(single).toHaveValue("a");
  await expect(multiple.locator("option:checked")).toHaveText(["A", "C"]);
  await expect(signals).toHaveAttribute("data-choice", "a");
  await expect(signals).toHaveAttribute("data-choices", "a,c");
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

interface ConcurrentRecord {
  commits: string[][];
  screens: string[];
  renders: string[];
}

// A transition mount yields after row A while a signal is written, so the rows
// rendered later read the new value. React must redo the render before it
// commits, so no commit shows A0 beside B1. The jsdom suite pins the same with
// React's real scheduler; this pins it against each engine's task scheduling.
for (const kind of ["tracking", "deep", "value"] as const) {
  test(`${kind}: a signal written while a transition mount yields commits no mixed snapshot`, async ({ page }) => {
    const errors = await openHydrated(page);
    const read = () =>
      page.evaluate(
        (name) => {
          const model = (globalThis as { rfgsConcurrent?: Record<string, ConcurrentRecord> }).rfgsConcurrent?.[name];
          return model && { commits: model.commits, screens: model.screens, renders: model.renders };
        },
        kind,
      );

    await page.locator(`#mount-concurrent-${kind}`).click();
    await expect.poll(async () => (await read())?.screens.at(-1)).toBe("1111");
    // A mixed first commit would be followed by a repair commit shortly after.
    await page.waitForTimeout(100);

    const record = (await read()) as ConcurrentRecord;
    // The write landed mid-render, so a pass is not vacuous.
    expect(record.renders[0]).toBe("A0");
    expect(record.renders).toContain("B1");
    for (const commit of record.commits) {
      const values = new Set(commit.map((entry) => entry.slice(1)));
      expect(values.size, `mixed commit ${JSON.stringify(record.commits)}`).toBe(1);
    }
    expect(record.commits).toEqual([["A1", "B1", "C1", "D1"]]);
    expect(errors).toEqual([]);
  });
}
