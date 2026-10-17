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
// Uses Playwright's Chromium. Set CHROMIUM_PATH to use a browser binary that
// is already installed instead of `playwright install chromium`.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const port = Number(process.env.PORT ?? 4319)
const navigationTimeout = Number(process.env.SMOKE_NAVIGATION_TIMEOUT ?? 180_000)
const basePath = (process.env.SITE_BASE_PATH ?? '/react-fine-grained-signals').replace(/\/$/, '')
const urlIndex = process.argv.indexOf('--url')
const external = urlIndex === -1 ? undefined : process.argv[urlIndex + 1]?.replace(/\/$/, '')
const origin = external ?? `http://127.0.0.1:${port}`
const pages = [
  '/', '/installation', '/getting-started', '/core-signals', '/react-hooks',
  '/managed-transform', '/jsx-direct-binding', '/deep-signal', '/examples',
]

const server = external === undefined
  ? spawn(process.execPath, [fileURLToPath(new URL('serve-static.mjs', import.meta.url)), '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  : undefined
if (server !== undefined) {
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (chunk) => { if (String(chunk).includes('Static preview')) resolve() })
    server.on('exit', (code) => reject(new Error(`static server exited with ${code}`)))
  })
}

const text = async (locator) => (await locator.textContent())?.trim()

const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`)
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH })
try {
  const context = await browser.newContext()
  const problems = []
  context.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      problems.push(`${message.type()} ${message.location().url}: ${message.text()}`)
    }
  })
  context.on('weberror', (error) => problems.push(`uncaught: ${error.error().message}`))
  // A navigation cancels requests still in flight (net::ERR_ABORTED); that is not a failure.
  context.on('requestfailed', (request) => {
    if (!request.failure()?.errorText.includes('ERR_ABORTED')) problems.push(`request failed: ${request.url()}`)
  })
  context.on('response', (response) => {
    if (response.status() >= 400) problems.push(`HTTP ${response.status()}: ${response.url()}`)
  })
  const page = await context.newPage()

  // Direct access to every page, with and without the trailing slash.
  for (const path of pages) {
    for (const suffix of path === '/' ? [''] : ['', '/']) {
      const url = `${origin}${basePath}${path}${suffix}`
      const response = await page.goto(url, { waitUntil: 'networkidle', timeout: navigationTimeout })
      check(response?.ok() === true, `${path}${suffix} loads (${response?.status()})`)
      const styled = await page.evaluate(() => getComputedStyle(document.body).fontFamily !== '' && document.styleSheets.length > 0)
      check(styled, `${path}${suffix} has its stylesheet`)
      if (external === undefined) {
        const skipHref = await page.locator('[data-v-skip-to-content]').getAttribute('href')
        check(skipHref === `${basePath}${path}#vocs-content`, `${path}${suffix} skip link stays under the base path`)
      }
    }
  }
  const icon = await page.request.get(`${origin}${basePath}/favicon.svg`)
  check(icon.ok(), 'favicon loads under the base path')
  const before = problems.length
  if (external === undefined) {
  const missing = await page.goto(`${origin}${basePath}/no-such-page`, { waitUntil: 'networkidle' })
  check(missing?.status() === 404, 'an unknown path gets the 404 page')
  check((await page.locator('body').textContent())?.includes('404') === true, 'the 404 page renders')
  // The 404 itself is expected; anything else it causes is not.
  }
  problems.splice(before, problems.length - before, ...problems.slice(before).filter((problem) => !problem.includes('/no-such-page')))

  // Client-side navigation from the sidebar keeps the base path.
  await page.goto(`${origin}${basePath}/`, { waitUntil: 'networkidle' })
  await page.locator('[data-v-sidebar-container] a', { hasText: 'Core Signals' }).first().click()
  await page.waitForURL(`**${basePath}/core-signals`)
  check(await page.locator('h1', { hasText: 'Core Signals' }).isVisible(), 'sidebar navigation reaches Core Signals')

  await page.goto(`${origin}${basePath}/examples`, { waitUntil: 'networkidle' })
  const demo = (name) => page.locator(`[data-demo="${name}"]`).first()

  // Counter: managed transform on a component-local signal.
  await demo('counter').getByRole('button', { name: '+' }).click()
  await demo('counter').getByRole('button', { name: '+' }).click()
  check((await text(demo('counter').locator('output'))) === 'Count: 2', 'counter updates')

  // Computed.
  await demo('computed').getByRole('button', { name: '+' }).click()
  check((await text(demo('computed').getByTestId('total'))) === '48', 'computed total follows quantity')
  await demo('computed').getByRole('spinbutton').fill('30')
  check((await text(demo('computed').getByTestId('total'))) === '120', 'computed total follows price')

  // Deep signal: property writes, array push, Map update.
  await demo('deep').getByRole('checkbox').nth(1).check()
  check((await text(demo('deep').getByTestId('remaining'))) === '0 remaining', 'deepSignal property write re-renders')
  check((await text(demo('deep').locator('li').nth(1))).includes('toggled 1×'), 'reactive Map update re-renders')
  await demo('deep').getByLabel('New todo').fill('Ship the docs')
  await demo('deep').getByRole('button', { name: 'Add' }).click()
  check((await demo('deep').locator('li').count()) === 3, 'deepSignal array push adds a row')

  // Form binding.
  const form = demo('form')
  await form.getByRole('textbox').fill('Grace')
  await form.getByLabel('Pro').check()
  await form.getByLabel('Export').check()
  await form.getByLabel('Subscribe to updates').uncheck()
  check((await text(form.getByTestId('summary'))) === 'Grace · pro · search, export · not subscribed', 'form bindings write their signals')

  // For / Index.
  await demo('for-index').getByRole('button', { name: 'Add' }).click()
  await demo('for-index').getByRole('button', { name: 'Rotate' }).click()
  check((await text(demo('for-index').getByTestId('for').locator('li').first())) === 'Grace #2', 'For re-orders keyed rows')
  check((await text(demo('for-index').getByTestId('index').locator('li').first())) === '0: Grace', 'Index re-reads positions')
  check((await demo('for-index').getByTestId('for').locator('li').count()) === 4, 'For renders the added row')

  // JSX direct binding: DOM updates without re-rendering the component.
  const jsx = demo('jsx')
  await jsx.getByRole('button').click()
  await jsx.getByRole('button').click()
  check((await text(jsx.getByRole('button'))) === 'Clicks: 2', 'signal child updates')
  check((await jsx.getByRole('button').getAttribute('title')) === 'Clicked 2 times', 'bound title prop updates')
  check((await jsx.getByTestId('swatch').evaluate((node) => node.style.background)).includes('rgb'), 'signal style entry is written')
  check((await text(jsx.getByTestId('rendered'))) === '0', 'the component did not re-render')

  // Managed transform: the transformed component updates, the opted-out one keeps its first value.
  const managed = demo('managed')
  await managed.getByRole('button', { name: '+' }).click()
  await managed.getByRole('button', { name: '+' }).click()
  await managed.getByRole('button', { name: '+' }).click()
  await managed.getByRole('button', { name: '+' }).click()
  check((await text(managed.getByTestId('reading'))) === '25°C', 'transformed component tracks direct reads')
  check((await text(managed.getByTestId('feel'))) === 'warm', 'transformed component tracks a helper read')
  await managed.getByRole('button', { name: 'Show °F' }).click()
  check((await text(managed.getByTestId('reading'))) === '77°F', 'transformed component tracks a computed')
  check((await text(demo('untracked').getByTestId('stale'))) === '21°C', 'opted-out component is not subscribed')

  check(problems.length === 0, `no console errors, warnings, or failed requests${problems.length ? `:\n  ${problems.join('\n  ')}` : ''}`)
} finally {
  await browser.close()
  server?.kill()
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed.`)
  process.exit(1)
}
console.log('\nAll smoke checks passed.')
