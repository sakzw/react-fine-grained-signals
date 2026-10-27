#!/usr/bin/env node
// Browser smoke check of the static build, served the way GitHub Pages serves
// the site (see serve-static.mjs). Opens every page by direct URL, checks that
// styles, scripts, and the icon load under the base path, drives each live
// demo, and fails on any console error or warning (hydration mismatches and
// Hook violations included) or failed request.
//
//   pnpm build && pnpm smoke
//   pnpm smoke --url http://127.0.0.1:5173   # against a running `pnpm dev`
//
// Uses Chromium by default. Set SMOKE_BROWSER=firefox or webkit to run the same
// checks in those engines; CHROMIUM_PATH can select an installed Chromium.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";

const port = Number(process.env.PORT ?? 4319);
const navigationTimeout = Number(process.env.SMOKE_NAVIGATION_TIMEOUT ?? 180_000);
const basePath = (process.env.SITE_BASE_PATH ?? "/react-fine-grained-signals").replace(/\/$/, "");
const urlIndex = process.argv.indexOf("--url");
const external = urlIndex === -1 ? undefined : process.argv[urlIndex + 1]?.replace(/\/$/, "");
const origin = external ?? `http://127.0.0.1:${port}`;
const pages = [
  "/",
  "/installation",
  "/getting-started",
  "/core-signals",
  "/react-hooks",
  "/managed-transform",
  "/jsx-direct-binding",
  "/deep-signal",
  "/examples",
  "/control-flow",
  "/global-state",
  "/rendering-optimization",
  "/migration",
];

const server =
  external === undefined
    ? spawn(process.execPath, [fileURLToPath(new URL("serve-static.mjs", import.meta.url)), "--port", String(port)], {
        stdio: ["ignore", "pipe", "inherit"],
      })
    : undefined;
if (server !== undefined) {
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (chunk) => {
      if (String(chunk).includes("Static preview")) resolve();
    });
    server.on("exit", (code) => reject(new Error(`static server exited with ${code}`)));
  });
}

const text = async (locator) => (await locator.textContent())?.trim();

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
  console.log(`${condition ? "ok  " : "FAIL"} ${message}`);
};

const browserTypes = { chromium, firefox, webkit };
const browserName = process.env.SMOKE_BROWSER ?? "chromium";
const browserType = browserTypes[browserName];
if (browserType === undefined) throw new Error(`Unknown SMOKE_BROWSER: ${browserName}`);
const browser = await browserType.launch({
  executablePath: browserName === "chromium" ? process.env.CHROMIUM_PATH : undefined,
});
try {
  const context = await browser.newContext();
  const problems = [];
  context.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      problems.push(`${message.type()} ${message.location().url}: ${message.text()}`);
    }
  });
  context.on("weberror", (error) => problems.push(`uncaught: ${error.error().message}`));
  // Navigation aborts have different error names across engines; these are not failed loads.
  context.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "unknown browser request failure";
    if (!/ERR_ABORTED|NS_BINDING_ABORTED|ERR_CANCELED|ERR_CANCELLED/i.test(failure)) {
      problems.push(`request failed (${failure}): ${request.url()}`);
    }
  });
  context.on("response", (response) => {
    if (response.status() >= 400) problems.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  const page = await context.newPage();

  // Direct access to every page, with and without the trailing slash.
  for (const path of pages) {
    for (const suffix of path === "/" ? [""] : ["", "/"]) {
      const url = `${origin}${basePath}${path}${suffix}`;
      const response = await page.goto(url, { waitUntil: "networkidle", timeout: navigationTimeout });
      check(response?.ok() === true, `${path}${suffix} loads (${response?.status()})`);
      const styled = await page.evaluate(
        () => getComputedStyle(document.body).fontFamily !== "" && document.styleSheets.length > 0,
      );
      check(styled, `${path}${suffix} has its stylesheet`);
      if (external === undefined) {
        const skipHref = await page.locator("[data-v-skip-to-content]").getAttribute("href");
        check(skipHref === `${basePath}${path}#vocs-content`, `${path}${suffix} skip link stays under the base path`);
      }
    }
  }
  const icon = await page.request.get(`${origin}${basePath}/favicon.svg`);
  check(icon.ok(), "favicon loads under the base path");
  if (external === undefined) {
    const nojekyll = await page.request.get(`${origin}${basePath}/.nojekyll`);
    check(nojekyll.ok(), ".nojekyll is present in the static Pages output");
  }
  const before = problems.length;
  if (external === undefined) {
    const missing = await page.goto(`${origin}${basePath}/no-such-page`, { waitUntil: "networkidle" });
    check(missing?.status() === 404, "an unknown path gets the 404 page");
    check((await page.locator("body").textContent())?.includes("404") === true, "the 404 page renders");
    // The 404 itself is expected; anything else it causes is not.
  }
  problems.splice(
    before,
    problems.length - before,
    ...problems.slice(before).filter((problem) => !problem.includes("/no-such-page")),
  );

  // Client-side navigation from the sidebar keeps the base path.
  await page.goto(`${origin}${basePath}/`, { waitUntil: "networkidle" });
  await page.locator("[data-v-sidebar-container] a", { hasText: "Core Signals" }).first().click();
  await page.waitForURL(`**${basePath}/core-signals`);
  check(await page.locator("h1", { hasText: "Core Signals" }).isVisible(), "sidebar navigation reaches Core Signals");

  await page.goto(`${origin}${basePath}/examples`, { waitUntil: "networkidle" });
  const demo = (name) => page.locator(`[data-demo="${name}"]`).first();

  // Counter: managed transform on a component-local signal.
  await demo("counter").getByRole("button", { name: "+" }).click();
  await demo("counter").getByRole("button", { name: "+" }).click();
  check((await text(demo("counter").locator("output"))) === "Count: 2", "counter updates");

  // Computed.
  await demo("computed").getByRole("button", { name: "+" }).click();
  check((await text(demo("computed").getByTestId("total"))) === "48", "computed total follows quantity");
  await demo("computed").getByRole("spinbutton").fill("30");
  check((await text(demo("computed").getByTestId("total"))) === "120", "computed total follows price");

  // Deep signal: property writes, array push, Map update.
  await demo("deep").getByRole("checkbox").nth(1).check();
  check((await text(demo("deep").getByTestId("remaining"))) === "0 remaining", "deepSignal property write re-renders");
  check((await text(demo("deep").locator("li").nth(1))).includes("toggled 1×"), "reactive Map update re-renders");
  await demo("deep").getByLabel("New todo").fill("Ship the docs");
  await demo("deep").getByRole("button", { name: "Add" }).click();
  check((await demo("deep").locator("li").count()) === 3, "deepSignal array push adds a row");

  // Form binding.
  const form = demo("form");
  await form.getByRole("textbox").fill("Grace");
  await form.getByLabel("Pro").check();
  await form.getByRole("checkbox", { name: "Export" }).check();
  await form.getByLabel("Subscribe to updates").uncheck();
  const amount = form.getByLabel("Amount");
  await amount.fill("2.25");
  check(
    (await text(form.getByTestId("numeric-summary"))) === "Amount text: 2.25 · parsed: 2.25",
    "number input writes its string signal and derived numeric display",
  );
  check(
    (await amount.evaluate((node) => node.validity.stepMismatch)) === false,
    "number input honors its native step constraint",
  );
  await amount.fill("2.3");
  check(
    (await text(form.getByTestId("numeric-summary"))) === "Amount text: 2.3 · parsed: 2.3",
    "number input keeps a step-mismatched value without rounding",
  );
  check(await amount.evaluate((node) => node.validity.stepMismatch), "step mismatch remains browser validity state");
  await amount.fill("");
  check(
    (await text(form.getByTestId("numeric-summary"))) === "Amount text:  · parsed: empty",
    "number input preserves the empty string",
  );
  check(await amount.evaluate((node) => node.validity.valueMissing), "required empty number uses native validity");
  const level = form.getByLabel("Level");
  await level.fill("73");
  check(
    (await text(form.getByTestId("range-summary"))) === "Level text: 73",
    "range interaction writes the string signal",
  );
  const nativeRangeEvents = await level.evaluate((node) => {
    const events = [];
    for (const type of ["input", "change"]) node.addEventListener(type, () => events.push(type), true);
    window.__m18_14RangeEvents = events;
    return true;
  });
  check(nativeRangeEvents, "native range event observers are installed");
  await form.getByText("Range edge cases").click();
  const rangeBox = await level.boundingBox();
  if (rangeBox === null) throw new Error("The range input has no bounding box.");
  await page.mouse.click(rangeBox.x + rangeBox.width * 0.9, rangeBox.y + rangeBox.height / 2);
  const mouseValue = Number(await level.inputValue());
  check(
    mouseValue > 73 && mouseValue <= 100,
    `real mouse track interaction moves the range slider (value ${mouseValue})`,
  );
  check(
    (await text(form.getByTestId("range-summary"))) === `Level text: ${mouseValue}`,
    "mouse interaction updates Signal and rendered output",
  );
  await page.mouse.move(rangeBox.x + rangeBox.width * 0.25, rangeBox.y + rangeBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(rangeBox.x + rangeBox.width * 0.4, rangeBox.y + rangeBox.height / 2);
  await form.getByRole("button", { name: "Set external signal" }).evaluate((button) => button.click());
  check(
    (await level.inputValue()) === "55" && (await text(form.getByTestId("range-summary"))) === "Level text: 55",
    "external Signal write synchronizes the slider during an active pointer drag",
  );
  await page.mouse.move(rangeBox.x + rangeBox.width * 0.65, rangeBox.y + rangeBox.height / 2);
  await page.mouse.up();
  check(
    (await text(form.getByTestId("range-summary"))) === `Level text: ${await level.inputValue()}`,
    "range continues to accept pointer movement after an external Signal write",
  );
  await level.focus();
  await level.press("End");
  check((await level.inputValue()) === "100", "End moves the range to native max");
  await level.press("Home");
  check((await level.inputValue()) === "0", "Home moves the range to native min");
  await level.press("ArrowRight");
  check((await level.inputValue()) === "1", "ArrowRight follows native step");
  check(
    (await text(form.getByTestId("range-summary"))) === "Level text: 1",
    "keyboard input updates Signal and rendered output",
  );
  check(
    (await text(form.getByTestId("range-event-summary"))).includes("React input:1:1"),
    "React onInput observes the already-updated Signal",
  );
  const nativeEventOrder = await page.evaluate(() => window.__m18_14RangeEvents);
  check(
    nativeEventOrder.includes("input") &&
      nativeEventOrder.includes("change") &&
      nativeEventOrder.indexOf("input") < nativeEventOrder.indexOf("change"),
    "native input precedes native change on committed slider interaction",
  );
  check(
    (await text(form.getByTestId("form-owner-renders"))) === "Form owner renders: 1",
    "mouse and keyboard range updates do not re-render the owner",
  );
  await form.getByRole("button", { name: "Apply Signal preset" }).click();
  check((await level.inputValue()) === "75", "programmatic signal write updates the range input");
  check(
    (await text(form.getByTestId("form-owner-renders"))) === "Form owner renders: 1",
    "range binding does not re-render the form owner",
  );
  await form.getByRole("button", { name: "Set signal above max" }).click();
  check(
    (await text(form.getByTestId("range-summary"))) === "Level text: 120" && (await level.inputValue()) === "100",
    "out-of-range Signal stays unchanged while the browser clamps the DOM value",
  );
  await form.getByRole("button", { name: "Change min/max/step" }).click();
  await form.getByRole("button", { name: "Set signal above max" }).click();
  check((await level.inputValue()) === "80", "updated React max is applied through native range semantics");
  await form.getByRole("button", { name: "Set signal off step" }).click();
  check(
    (await text(form.getByTestId("range-summary"))) === "Level text: 73" && (await level.inputValue()) === "75",
    "step-mismatched Signal stays unchanged while the browser snaps the DOM value",
  );
  await form.getByRole("button", { name: "Switch range/text type" }).click();
  const switchedTextType = await level.getAttribute("type");
  const switchedTextValue = await level.inputValue();
  check(
    switchedTextType === "text" && switchedTextValue === "75",
    `switching type preserves the browser's current value until the Signal changes (type ${switchedTextType}, DOM ${switchedTextValue}, Signal ${await text(form.getByTestId("range-summary"))})`,
  );
  await form.getByRole("button", { name: "Switch range/text type" }).click();
  check(
    (await level.getAttribute("type")) === "range" && (await level.inputValue()) === "75",
    "switching back lets the browser normalize the range value",
  );
  await form.getByRole("button", { name: "Set external signal" }).click();
  check(
    (await level.inputValue()) === "55" && (await text(form.getByTestId("range-summary"))) === "Level text: 55",
    "external Signal update synchronizes the slider and output",
  );
  const formOwnerBeforeProgrammatic = await text(form.getByTestId("form-owner-renders"));
  await form.getByLabel("Region").selectOption("apac");
  await form.getByLabel("Export formats").selectOption(["csv", "xml"]);
  check(
    (await text(form.getByTestId("summary"))) === "Grace · pro · apac · csv+xml · search, export · not subscribed",
    "form DOM changes write text, checkbox, single-select, and multi-select signals",
  );
  await form.getByRole("button", { name: "Apply Signal preset" }).click();
  check(
    (await text(form.getByTestId("summary"))) === "Grace · pro · us · csv+json · search, export · not subscribed",
    "programmatic signal writes update bound form controls",
  );
  check((await amount.inputValue()) === "42.5", "programmatic numeric signal write updates the number input");
  check(
    (await text(form.getByTestId("numeric-summary"))) === "Amount text: 42.5 · parsed: 42.5",
    "derived numeric display follows programmatic signal writes",
  );
  check(
    (await text(form.getByTestId("form-owner-renders"))) === formOwnerBeforeProgrammatic,
    "number binding does not re-render the form owner",
  );
  check((await form.getByLabel("Region").inputValue()) === "us", "single select reflects a programmatic signal write");
  check(
    (await form
      .getByLabel("Export formats")
      .evaluate((node) => [...node.selectedOptions].map((option) => option.value).join(","))) === "csv,json",
    "multiple select reflects a programmatic signal write",
  );

  // For / Index.
  const lists = demo("for-index");
  check(
    (await text(lists.getByTestId("list-owner-renders"))) === "List owner renders: 1",
    "list owner starts at one render",
  );
  await lists.getByRole("button", { name: "Add" }).click();
  check((await lists.getByTestId("for").locator("li").count()) === 4, "For renders the appended row");
  await lists.getByRole("button", { name: "Rotate" }).click();
  check(
    (await text(lists.getByTestId("for").locator("li").first())).startsWith("Grace #2"),
    "For re-orders keyed rows",
  );
  check(
    (await text(lists.getByTestId("index").locator("li").first())).startsWith("0: Grace"),
    "Index re-reads positions",
  );
  await lists.getByRole("button", { name: "Remove first" }).click();
  check((await lists.getByTestId("for").locator("li").count()) === 3, "For removes a row");
  const deepFirst = lists.getByTestId("deep-row-3");
  const deepBefore = Number((await text(deepFirst)).match(/row renders: (\d+)/)?.[1]);
  const deepOtherBefore = Number((await text(lists.getByTestId("deep-row-4"))).match(/row renders: (\d+)/)?.[1]);
  await lists.getByRole("button", { name: "Deep edit first score" }).click();
  check((await text(deepFirst)).includes("score 31"), "nested deepSignal write updates the selected row");
  check(
    Number((await text(deepFirst)).match(/row renders: (\d+)/)?.[1]) === deepBefore + 1,
    "nested deepSignal write re-renders that row once",
  );
  check(
    Number((await text(lists.getByTestId("deep-row-4"))).match(/row renders: (\d+)/)?.[1]) === deepOtherBefore,
    "nested deepSignal write leaves other rows stable",
  );
  check(
    (await text(lists.getByTestId("list-owner-renders"))) === "List owner renders: 1",
    "collection operations do not re-render the list owner",
  );
  const keyedBefore = Number(
    (await text(lists.getByTestId("for").locator("li").first())).match(/row renders: (\d+)/)?.[1],
  );
  await lists.getByRole("button", { name: "Immutable replacement +1" }).click();
  check(
    (await text(lists.getByTestId("for").locator("li").first())).includes("row renders: " + (keyedBefore + 1)),
    "immutable replacement re-runs For callback output and row renders",
  );

  // Utilities and shared state.
  const flow = demo("control-flow");
  check((await text(flow.getByTestId("show-state"))) === "Please sign in.", "Show starts with its fallback");
  check(
    (await text(flow.getByTestId("control-flow-parent-renders"))) === "Parent renders: 1",
    "control flow parent starts with one render",
  );
  await flow.getByRole("button", { name: "Toggle signed-in" }).click();
  await flow.getByRole("button", { name: "Details" }).click();
  check((await text(flow.getByTestId("show-state"))) === "Signed in: true", "Show updates its selected branch");
  check((await text(flow.getByTestId("switch-state"))) === "User details", "Switch selects its first equal Match");
  check(
    (await text(flow.getByTestId("control-flow-parent-renders"))) === "Parent renders: 1",
    "Show and Match signal updates do not re-render the parent",
  );
  await flow.getByRole("button", { name: "Empty" }).click();
  check((await text(flow.getByTestId("switch-state"))) === "User empty", "Match switches again after a Signal update");
  check(
    (await text(flow.getByTestId("control-flow-parent-renders"))) === "Parent renders: 1",
    "repeated Match updates stay within Switch",
  );
  const shared = demo("shared-state");
  await shared.getByRole("button", { name: "+" }).click();
  check(
    (await text(shared.getByTestId("managed-reader"))).startsWith("Managed reader: 1"),
    "managed reader subscribes to shared state",
  );
  check(
    (await text(shared.getByTestId("hook-reader"))).startsWith("Hook reader: 1"),
    "Hook reader subscribes to shared state",
  );
  check(
    (await text(shared.getByTestId("shared-owner-renders"))) === "Demo owner renders: 1",
    "shared state updates do not re-render the common owner",
  );

  // JSX direct binding: DOM updates without re-rendering the component.
  const jsx = demo("jsx");
  await jsx.getByRole("button").click();
  await jsx.getByRole("button").click();
  check((await text(jsx.getByRole("button"))) === "Clicks: 2", "signal child updates");
  check((await jsx.getByRole("button").getAttribute("title")) === "Clicked 2 times", "bound title prop updates");
  check(
    (await jsx.getByTestId("swatch").evaluate((node) => node.style.background)).includes("rgb"),
    "signal style entry is written",
  );
  check((await text(jsx.getByTestId("rendered"))) === "0", "the component did not re-render");

  // Managed transform: the transformed component updates, the opted-out one keeps its first value.
  const managed = demo("managed");
  await managed.getByRole("button", { name: "+" }).click();
  await managed.getByRole("button", { name: "+" }).click();
  await managed.getByRole("button", { name: "+" }).click();
  await managed.getByRole("button", { name: "+" }).click();
  check((await text(managed.getByTestId("reading"))) === "25°C", "transformed component tracks direct reads");
  check((await text(managed.getByTestId("feel"))) === "warm", "transformed component tracks a helper read");
  await managed.getByRole("button", { name: "Show °F" }).click();
  check((await text(managed.getByTestId("reading"))) === "77°F", "transformed component tracks a computed");
  check((await text(demo("untracked").getByTestId("stale"))) === "21°C", "opted-out component is not subscribed");

  check(
    problems.length === 0,
    `no console errors, warnings, or failed requests${problems.length ? `:\n  ${problems.join("\n  ")}` : ""}`,
  );
} finally {
  await browser.close();
  server?.kill();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll smoke checks passed.");
