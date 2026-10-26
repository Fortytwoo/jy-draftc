/** Development-only peer links into an existing Harness checkout, outside every user profile. */
import { lstat, mkdir, readFile, readdir, realpath, symlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const plugin = fileURLToPath(new URL('../', import.meta.url))
const harness = resolve(process.argv[2] || '')
if (!process.argv[2]) throw new Error('Usage: node scripts/link-harness.mjs <Harness checkout>')
const manifest = JSON.parse(await readFile(join(plugin, 'package.json'), 'utf8'))
const wanted = new Set([...Object.keys(manifest.peerDependencies), '@deepseek-ai/dsh-agent-preset', '@deepseek-ai/dsh-agent-preset-registry', '@deepseek-ai/dsh-tool-skill', '@deepseek-ai/dsh-working-directory', '@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-app-boot', '@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/cordis-plugin-group'])
const found = new Map()
async function scan(root, depth = 0) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || ['node_modules', 'lib', 'dist', '.git'].includes(entry.name)) continue
    const path = join(root, entry.name)
    const pkg = await readFile(join(path, 'package.json'), 'utf8').then(JSON.parse, (error) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (pkg && wanted.has(pkg.name)) {
      if (manifest.peerDependencies[pkg.name] && !manifest.peerDependencies[pkg.name].split('||').map((version) => version.trim()).includes(pkg.version)) throw new Error(`Peer version mismatch: ${pkg.name}@${pkg.version}`)
      found.set(pkg.name, path)
    }
    if (!pkg && depth < 3) await scan(path, depth + 1)
  }
}
await scan(join(harness, 'packages'))
await scan(join(harness, 'vendor'))
const mcpRequire = createRequire(join(found.get('@deepseek-ai/dsh-mcp-client'), 'package.json'))
for (const [name, version] of Object.entries(manifest.dependencies || {})) {
  const target = dirname(dirname(mcpRequire.resolve(name)))
  const dependency = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
  if (dependency.name !== name || dependency.version !== version) throw new Error(`Dependency version mismatch: ${name}`)
  wanted.add(name)
  found.set(name, target)
}
for (const name of wanted) {
  const target = found.get(name)
  if (!target) throw new Error(`Harness package not found: ${name}`)
  const link = join(plugin, 'node_modules', name)
  await mkdir(dirname(link), { recursive: true })
  const present = await lstat(link).catch((error) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (present) {
    if (!present.isSymbolicLink() || await realpath(link) !== await realpath(target)) throw new Error(`Refusing to replace existing path: ${link}`)
  } else await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}
console.log(`Linked ${found.size} peer/test packages from ${harness}`)
