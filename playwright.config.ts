import { defineConfig, devices } from "@playwright/test";

// The production-build spec targets its own preview server (port 4174) and
// must not also run against the dev-mode server (port 4173) used by the
// other projects, and vice versa.
const productionBuildSpec = /production-build\.spec\.ts$/;

// The react-router spec targets the examples/react-router SSR app's own
// production server (port 4175) — an entirely separate app/workspace from
// examples/browser — and must not run against, or be run by, any of the
// other projects/servers above, and vice versa.
const reactRouterSpec = /react-router\.spec\.ts$/;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never" }]]
    : "line",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: [productionBuildSpec, reactRouterSpec],
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
      testIgnore: [productionBuildSpec, reactRouterSpec],
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testIgnore: [productionBuildSpec, reactRouterSpec],
    },
    {
      name: "production-build",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: "http://127.0.0.1:4174",
      },
      testMatch: productionBuildSpec,
      testIgnore: reactRouterSpec,
    },
    {
      name: "react-router",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: "http://127.0.0.1:4175",
      },
      testMatch: reactRouterSpec,
    },
  ],
  webServer: [
    {
      command: "pnpm dev:browser",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    },
    {
      // Real `vite build` (bundling/tree-shaking/minification) followed by a
      // static `vite preview` server, as opposed to the dev-mode/middleware
      // server above.
      command: "pnpm build:browser && pnpm preview:browser",
      url: "http://127.0.0.1:4174",
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 180_000,
    },
    {
      // examples/react-router is its own isolated pnpm workspace (own
      // lockfile, independent dependency versions — see its
      // pnpm-workspace.yaml), so its dependencies must be installed beforehand
      // (see `pnpm prepare:e2e` for local use, or the e2e.yml CI step for CI).
      // Everything here must be scoped to run inside that directory rather
      // than via a root package.json script. A real `react-router build`
      // (client + server bundles) served by `@react-router/serve`, as opposed
      // to `react-router dev`.
      command:
        "pnpm --dir examples/react-router run build && pnpm --dir examples/react-router run start",
      url: "http://127.0.0.1:4175",
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
      // Build and start a whole separate workspace. The install runs
      // beforehand (see `pnpm prepare:e2e` for local use, or the e2e.yml CI
      // step for CI).
      timeout: 180_000,
    },
  ],
});
