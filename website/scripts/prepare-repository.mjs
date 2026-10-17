import { mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const website = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const repo = path.dirname(website)
const destination = path.join(website, '.repo-packages')
await mkdir(destination, { recursive: true })

function pack(cwd) {
  const result = spawnSync('pnpm', ['pack', '--pack-destination', destination], { cwd, stdio: 'inherit', shell: true })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

pack(repo)
pack(path.join(repo, 'packages', 'unplugin-react-fine-grained-signals'))
