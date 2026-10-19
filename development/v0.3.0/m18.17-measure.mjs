import react from '@vitejs/plugin-react'
import { build } from 'vite'
import { gzipSync, brotliCompressSync, constants } from 'node:zlib'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, resolve, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const dist = join(repo, 'dist')
const buildRoot = mkdtempSync(join(tmpdir(), 'rfsg-m18-17-'))
const results = []

function resolvePnpmInvocation() {
  const packageManagerScript = process.env.npm_execpath
  if (packageManagerScript !== undefined && /pnpm/i.test(packageManagerScript)) {
    if (/\.(?:cjs|mjs|js)$/i.test(packageManagerScript)) {
      return { command: process.execPath, prefixArguments: [packageManagerScript] }
    }
    if (/\.exe$/i.test(packageManagerScript) && existsSync(packageManagerScript)) {
      return { command: packageManagerScript, prefixArguments: [] }
    }
  }
  if (process.platform === 'win32') {
    for (const pathEntry of (process.env.PATH ?? '').split(delimiter)) {
      if (!pathEntry) continue
      const executable = join(pathEntry, 'pnpm.exe')
      if (existsSync(executable)) return { command: executable, prefixArguments: [] }
      const commandShim = join(pathEntry, 'pnpm.cmd')
      if (!existsSync(commandShim)) continue
      const shimDirectory = dirname(commandShim)
      const launchLine = readFileSync(commandShim, 'utf8').split(/\r?\n/).find((line) => /%\*/.test(line))
      const launchArguments = launchLine?.match(/"([^"]+)"(?:\s+"([^"]+)")?.*%\*/i)
      if (!launchArguments) continue
      const resolveShimPath = (value) => resolve(value.replace(/%~dp0/ig, `${shimDirectory}\\`))
      const launcher = resolveShimPath(launchArguments[1])
      const cliScript = launchArguments[2] === undefined ? undefined : resolveShimPath(launchArguments[2])
      if (/\.exe$/i.test(launcher) && existsSync(launcher)) {
        const adjacentCli = [join(dirname(launcher), 'pnpm.mjs'), join(dirname(launcher), 'bin', 'pnpm.mjs')]
          .find((candidate) => existsSync(candidate))
        if (adjacentCli) return { command: process.execPath, prefixArguments: [adjacentCli] }
        return { command: launcher, prefixArguments: cliScript === undefined ? [] : [cliScript] }
      }
      if (cliScript !== undefined && existsSync(cliScript)) {
        return { command: process.execPath, prefixArguments: [cliScript] }
      }
    }
  }
  return { command: 'pnpm', prefixArguments: [] }
}

const pnpmInvocation = resolvePnpmInvocation()

const reactPath = (path) => join(repo, 'node_modules', 'react', path)
const aliases = [
  { find: /^react\/jsx-runtime$/, replacement: reactPath('jsx-runtime.js') },
  { find: /^react\/jsx-dev-runtime$/, replacement: reactPath('jsx-dev-runtime.js') },
  { find: /^react$/, replacement: reactPath('index.js') },
  { find: /^react-dom\/client$/, replacement: join(repo, 'node_modules/react-dom/client.js') },
  { find: /^react-fine-grained-signals\/jsx-runtime$/, replacement: join(dist, 'jsx-runtime.js') },
  { find: /^react-fine-grained-signals\/jsx-dev-runtime$/, replacement: join(dist, 'jsx-dev-runtime.js') },
  { find: /^react-fine-grained-signals\/lite\/jsx-runtime$/, replacement: join(dist, 'lite/jsx-runtime.js') },
  { find: /^react-fine-grained-signals\/lite\/jsx-dev-runtime$/, replacement: join(dist, 'lite/jsx-dev-runtime.js') },
  { find: /^react-fine-grained-signals\/lite$/, replacement: join(dist, 'lite.js') },
  { find: /^react-fine-grained-signals$/, replacement: join(dist, 'index.js') },
]

const jsxConsumer = `
import { createRoot } from "react-dom/client";
import { signal } from "react-fine-grained-signals";
export const count = signal(0);
export function App() {
  return <main><button onClick={() => count.value++}>increment</button><output data-testid="value">{count}</output></main>;
}
createRoot(document.getElementById("root")).render(<App />);
`

const hookConsumer = `
import { createRoot } from "react-dom/client";
import { signal, useSignalValue } from "react-fine-grained-signals";
const count = signal(0);
function App() {
  const value = useSignalValue(count);
  return <main><button onClick={() => count.value++}>increment</button><output data-testid="value">{value}</output></main>;
}
createRoot(document.getElementById("root")).render(<App />);
`

function runPnpm(args, cwd) {
  const result = spawnSync(pnpmInvocation.command, [...pnpmInvocation.prefixArguments, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

async function buildConsumer(name, jsxImportSource, source, useInstalledPackage = false) {
  const project = useInstalledPackage ? join(buildRoot, 'packed-consumer') : join(buildRoot, name)
  const outDir = join(project, 'dist')
  mkdirSync(project, { recursive: true })
  const entry = join(project, 'entry.tsx')
  writeFileSync(entry, source)
  await build({
    configFile: false,
    root: project,
    plugins: [react({ jsxImportSource })],
    resolve: {
      alias: useInstalledPackage ? aliases.filter(({ find }) => !String(find).includes('react-fine-grained-signals')) : aliases,
      dedupe: ['react', 'react-dom'],
    },
    build: {
      outDir,
      emptyOutDir: true,
      minify: 'esbuild',
      sourcemap: false,
      rollupOptions: { input: entry, output: { entryFileNames: 'app.js' } },
    },
  })
  writeFileSync(join(outDir, 'index.html'), '<!doctype html><div id="root"></div><script type="module" src="./app.js"></script>')
  const files = readdirSync(outDir).filter((fileName) => fileName.endsWith('.js'))
    .map((fileName) => ({ name: fileName, bytes: readFileSync(join(outDir, fileName)) }))
  const code = Buffer.concat(files.map(({ bytes }) => bytes))
  const metrics = {
    name,
    raw: code.byteLength,
    gzip: gzipSync(code, { level: 9 }).byteLength,
    brotli: brotliCompressSync(code, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength,
    files: files.map(({ name: fileName }) => fileName),
    markers: {
      selectBindingValidation: code.includes(Buffer.from('Invalid select bindValue.')),
      textBindingValidation: code.includes(Buffer.from('bindValue: text-like, number, or range input/textarea/select only.')),
      checkboxGroupValidation: code.includes(Buffer.from('Checkbox group bindValue requires an array of strings.')),
      unsupportedBindingDiagnostic: code.includes(Buffer.from('form bindings require the default JSX runtime')),
      unsupportedAttributeDiagnostic: code.includes(Buffer.from('The lite JSX runtime does not support Signal-valued')),
    },
  }
  return { metrics, outDir }
}

try {
  const packedRoot = join(buildRoot, 'packed-consumer')
  mkdirSync(packedRoot, { recursive: true })
  runPnpm(['pack', '--pack-destination', packedRoot], repo)
  const tarball = readdirSync(packedRoot).find((fileName) => fileName.endsWith('.tgz'))
  if (!tarball) throw new Error('pnpm pack did not create a package tarball.')
  writeFileSync(join(packedRoot, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    dependencies: {
      'react-fine-grained-signals': `file:./${tarball}`,
      react: '19.3.0',
      'react-dom': '19.3.0',
      '@types/react': '19.3.0',
    },
  }, null, 2))
  runPnpm(['install', '--lockfile=false', '--ignore-scripts'], packedRoot)
  const typeFixture = `import { signal } from "react-fine-grained-signals";\nconst source = signal("x");\nconst child = <output>{source}</output>;\n// @ts-expect-error Lite rejects Signal-valued attributes.\nconst attr = <button title={source} />;\n// @ts-expect-error Lite rejects direct form bindings.\nconst binding = <input bindValue={source} />;\nvoid [child, attr, binding];\n`
  writeFileSync(join(packedRoot, 'consumer-types.tsx'), typeFixture)
  writeFileSync(join(packedRoot, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      jsx: 'react-jsx',
      jsxImportSource: 'react-fine-grained-signals/lite',
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ['consumer-types.tsx'],
  }, null, 2))
  const typecheck = spawnSync(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'), '--project', join(packedRoot, 'tsconfig.json')], {
    cwd: repo,
    encoding: 'utf8',
  })
  if (typecheck.status !== 0) throw new Error(`Packed consumer typecheck failed:\n${typecheck.stdout}\n${typecheck.stderr}`)

  const outputs = []
  outputs.push(await buildConsumer('full-runtime', 'react-fine-grained-signals', jsxConsumer))
  outputs.push(await buildConsumer('lite-runtime', 'react-fine-grained-signals/lite', jsxConsumer))
  outputs.push(await buildConsumer('react-jsx-hooks', 'react', hookConsumer))
  outputs.push(await buildConsumer('lite-packed-consumer', 'react-fine-grained-signals/lite', jsxConsumer, true))

  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/^\/+/, '')
    const path = resolve(buildRoot, pathname)
    if (!path.startsWith(buildRoot)) { response.writeHead(403).end(); return }
    try {
      const content = readFileSync(path)
      response.writeHead(200, { 'content-type': path.endsWith('.html') ? 'text/html' : 'text/javascript' }).end(content)
    } catch { response.writeHead(404).end('not found') }
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  const browser = await chromium.launch()
  try {
    for (const output of outputs) {
      const page = await browser.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
      const route = relative(buildRoot, output.outDir).replaceAll('\\', '/')
      await page.goto(`http://127.0.0.1:${address.port}/${route}/index.html`)
      await page.getByRole('button', { name: 'increment' }).click()
      const value = await page.getByTestId('value').textContent()
      if (value !== '1') throw new Error(`${output.metrics.name} rendered ${value}, expected 1`)
      if (errors.length > 0) throw new Error(`${output.metrics.name} browser errors: ${errors.join('; ')}`)
      await page.close()
    }
  } finally {
    await browser.close()
    await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()))
  }

  for (const output of outputs) {
    console.log(JSON.stringify(output.metrics))
    results.push(output.metrics)
  }
  writeFileSync(join(repo, 'development/v0.3.0/m18.17-consumer-bundles.json'), `${JSON.stringify(results, null, 2)}\n`)
} finally {
  rmSync(buildRoot, { recursive: true, force: true })
}
