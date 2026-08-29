import { expect, test, type Page } from "@playwright/test";

// This spec exercises examples/react-router — a React Router v8 SSR proof of
// concept — served by its own production server (`@react-router/serve`, via
// examples/react-router's `build`/`start` scripts) on port 4175, as
// configured by the "react-router" project/webServer entry in
// playwright.config.ts. It is an entirely separate app/workspace from
// examples/browser (see examples/react-router/pnpm-workspace.yaml), so this
// spec is self-contained rather than importing anything from
// e2e/browser.spec.ts.
//
// Unlike examples/browser, this app has no `data-hydrated` DOM marker, so
// hydration completion is instead detected via root.tsx's useSignalEffect,
// which only runs after the client mounts and rewrites `document.title` to
// include the live "残り" (remaining tasks) count.

async function openHydrated(page: Page, path = "/") {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(path);
  await page.waitForFunction(() => document.title.includes("残り"));
  expect(errors).toEqual([]);
  return errors;
}

test("serves deterministic React SSR markup for the task board", async ({ request }) => {
  const response = await request.get("/");
  expect(response.ok()).toBe(true);
  const html = await response.text();

  expect(html).toContain("<title>タスクボード — react-alien-signals React Router PoC</title>");
  expect(html).toContain("<h1>タスクボード</h1>");
  expect(html).toContain('<a aria-current="page" class="active" href="/"');
  expect(html).toContain('<a class="" href="/activity"');
  expect(html).toContain('placeholder="新しいタスク"');

  // Seeded, deterministic task list: 2 done, 1 not done (see
  // app/lib/task-store.ts's seedState), so the nav badge reads "残り 1".
  expect(html).toContain('<span class="badge">残り <!-- -->1</span>');
  expect(html).toContain("Read the README");
  expect(html).toContain("Try the browser PoC");
  expect(html).toContain("Try this React Router PoC");

  // The post-hydration document.title rewrite (see openHydrated above) must
  // not have happened server-side.
  expect(html).not.toContain("タスク(残り");
});

test("hydrates without console errors and responds to a real click", async ({ page }) => {
  const errors = await openHydrated(page);

  const badge = page.locator("nav .badge");
  await expect(badge).toHaveText("残り 1");

  const lastTask = page.locator(".task-list li").last();
  await expect(lastTask).toHaveClass(/task-row(?! done)/);
  await expect(lastTask.locator("input[type=checkbox]")).not.toBeChecked();

  // A real signals-driven interaction: only works end-to-end if hydration
  // actually wired up the click handler and the signal graph.
  await page.getByRole("button", { name: "すべて完了にする" }).click();

  await expect(badge).toHaveText("残り 0");
  await expect(lastTask).toHaveClass(/task-row done/);
  await expect(lastTask.locator("input[type=checkbox]")).toBeChecked();
  expect(errors).toEqual([]);
});

test("streams the activity route's Suspense fallback before its resolved insight", async ({
  request,
}) => {
  // A raw streamed fetch, not `page`: Chromium's own load pipeline can
  // easily outrun InsightPanel's short simulated delay (see
  // InsightPanel.tsx), so a browser-side poll for the fallback text is
  // racy. Reading the response body in arrival order instead observes
  // exactly what renderToPipeableStream flushed, and when.
  const response = await request.get("/activity");
  expect(response.ok()).toBe(true);
  const body = await response.body();
  const text = body.toString("utf8");

  const fallbackAt = text.indexOf("insight-loading");
  const resolvedAt = text.indexOf("記録された操作");
  expect(fallbackAt).toBeGreaterThanOrEqual(0);
  expect(resolvedAt).toBeGreaterThan(fallbackAt);
});

test("navigates to the activity route client-side, without a full page reload", async ({
  page,
}) => {
  const errors = await openHydrated(page);

  let fullPageLoads = 0;
  page.on("load", () => {
    fullPageLoads += 1;
  });

  await expect(page.locator("h1")).toHaveText("タスクボード");
  await page.getByRole("link", { name: "アクティビティ" }).click();

  await page.waitForURL(/\/activity$/);
  await expect(page.locator("h1")).toHaveText("アクティビティログ");
  await expect(page.locator(".activity-list")).toContainText("ボードを開きました");
  await expect(page.getByRole("link", { name: "アクティビティ" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  // No `load` event fired after the initial one from openHydrated's
  // page.goto — this was a client-side (SPA) navigation, not a full
  // document reload.
  expect(fullPageLoads).toBe(0);
  expect(errors).toEqual([]);
});
