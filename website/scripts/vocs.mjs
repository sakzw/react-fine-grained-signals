import react from '@vitejs/plugin-react'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { createBuilder, createServer } from 'vite'
import path from 'node:path'
import { resolveConfig } from 'vocs/config'
import { vocs } from 'vocs/vite'
import signals from 'unplugin-react-fine-grained-signals/vite'

const command = process.argv[2]
const config = await resolveConfig()
const resolve = { dedupe: ['react', 'react-dom'] }
const plugins = [
  signals({ mode: 'auto', include: (id) => id.replaceAll('\\', '/').includes('/src/demos.tsx') }),
  react(),
  await vocs(),
]

if (command === 'dev') {
  const server = await createServer({
    configFile: false,
    plugins,
    resolve,
    optimizeDeps: { noDiscovery: true },
    server: { port: 5173 },
  })
  await server.listen()
  server.printUrls()
} else if (command === 'build') {
  const builder = await createBuilder({
    configFile: false,
    plugins,
    resolve,
    build: { outDir: config.outDir },
  })
  await builder.buildApp()
  const outputDirectory = path.resolve(config.outDir, 'public')
  const configuredBasePath = process.env.VOCS_BASE_PATH ?? '/react-fine-grained-signals/'
  await fixSkipLinks(outputDirectory, configuredBasePath, outputDirectory)
} else {
  throw new Error(`Unknown command: ${command}. Use dev or build.`)
}

async function fixSkipLinks(directory, basePath, outputDirectory) {
  const segments = basePath.split('/').filter(Boolean)
  const normalizedBasePath = segments.length > 0 ? `/${segments.join('/')}` : ''
  const files = await readdir(directory, { withFileTypes: true })

  for (const file of files) {
    const filename = path.join(directory, file.name)
    if (file.isDirectory()) {
      await fixSkipLinks(filename, basePath, outputDirectory)
    } else if (file.name.endsWith('.html')) {
      const relative = path.relative(outputDirectory, filename).replaceAll('\\', '/')
      const content = await readFile(filename, 'utf8')
      const route = relative === 'index.html'
        ? '/'
        : `/${relative.replace(/\/index\.html$/, '').replace(/\.html$/, '')}`
      const href = `${normalizedBasePath}${route === '/' ? '/' : route}#vocs-content`
      const updated = content.replace(
        /(<a\b[^>]*data-v-skip-to-content="true"[^>]*\bhref=")[^"]*("[^>]*>)/g,
        `$1${href}$2`,
      )
      if (updated !== content) await writeFile(filename, updated)
    }
  }
}
