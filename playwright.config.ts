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
const devPort = process.env.RFSG_E2E_DEV_PORT ?? "4173";
const productionPort = process.env.RFSG_E2E_PRODUCTION_PORT ?? "4174";
const reactRouterPort = process.env.RFSG_E2E_REACT_ROUTER_PORT ?? "4175";

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
    baseURL: `http://127.0.0.1:${devPort}`,
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
        baseURL: `http://127.0.0.1:${productionPort}`,
      },
      testMatch: productionBuildSpec,
      testIgnore: reactRouterSpec,
    },
    {
      name: "react-router",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `http://127.0.0.1:${reactRouterPort}`,
      },
      testMatch: reactRouterSpec,
    },
  ],
  webServer: [
    {
      // `test:browser` builds the plugin before Playwright starts any web
      // servers. Keeping builds out of these commands prevents concurrent
      // webServer startup from replacing the shared transform dist directory.
      command: "node examples/browser/server.mjs",
      url: `http://127.0.0.1:${devPort}`,
      env: { PORT: devPort, HMR_PORT: process.env.RFSG_E2E_HMR_PORT ?? String(Number(devPort) + 1000) },
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    },
    {
      // Real `vite build` (bundling/tree-shaking/minification) followed by a
      // static `vite preview` server, as opposed to the dev-mode/middleware
      // server above.
      command: `node node_modules/vite/bin/vite.js preview --config examples/browser/vite.config.ts --host 127.0.0.1 --port ${productionPort} --strictPort`,
      url: `http://127.0.0.1:${productionPort}`,
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
      // The build is completed by the `test:browser` preflight, so this
      // server only starts the already-built app. The cwd is necessary for
      // the server-build path that start.mjs passes to @react-router/serve.
      command: "node scripts/start.mjs",
      cwd: "examples/react-router",
      env: { PORT: reactRouterPort, HOST: "127.0.0.1" },
      url: `http://127.0.0.1:${reactRouterPort}`,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
      // Start a whole separate workspace. The install runs
      // beforehand (see `pnpm prepare:e2e` for local use, or the e2e.yml CI
      // step for CI).
      timeout: 180_000,
    },
  ],
});
