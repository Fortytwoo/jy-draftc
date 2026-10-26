/** Copy the authoritative backend into an installable package; never bundle local media or .env. */
import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const plugin = fileURLToPath(new URL('../', import.meta.url))
const source = dirname(plugin.replace(/[\\/]$/, ''))
const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice('--output='.length)
const runtime = output ? resolve(output) : join(plugin, 'runtime')
const allowedRoot = output ? join(source, 'build') : plugin
const contained = (root, target) => { const rel = relative(root, target); return rel && !rel.startsWith('..') && !isAbsolute(rel) }
if (!contained(allowedRoot, runtime) || basename(runtime) !== 'runtime') throw new Error('Runtime output must be a runtime child directory inside plugin or repository build')
await mkdir(dirname(runtime), { recursive: true })
if (!contained(await realpath(allowedRoot), join(await realpath(dirname(runtime)), basename(runtime)))) throw new Error('Runtime parent escapes the intended workspace')
// This directory is generated and ignored. Never follow a substituted directory link.
const previous = await lstat(runtime).catch((error) => {
  if (error.code === 'ENOENT') return undefined
  throw error
})
if (previous?.isSymbolicLink()) throw new Error('Unsafe runtime destination')
await rm(runtime, { recursive: true, force: true })
await mkdir(join(runtime, 'src', 'jy_edit_mcp'), { recursive: true })
await mkdir(join(runtime, 'docs'), { recursive: true })
for (const file of ['pyproject.toml', 'uv.lock', '.python-version']) await copyFile(join(source, file), join(runtime, file))
await copyFile(join(source, 'docs', 'jy-edit-mcp.md'), join(runtime, 'docs', 'jy-edit-mcp.md'))
await copyFile(join(source, 'docs', 'jy-edit-tools.json'), join(runtime, 'docs', 'jy-edit-tools.json'))
for (const file of await readdir(join(source, 'src', 'jy_edit_mcp'))) {
  if (file.endsWith('.py')) await copyFile(join(source, 'src', 'jy_edit_mcp', file), join(runtime, 'src', 'jy_edit_mcp', file))
}
await copyFile(join(source, 'LICENSE'), join(plugin, 'LICENSE'))
const native = process.argv.find((arg) => arg.startsWith('--native='))?.slice('--native='.length)
if (native) {
  await mkdir(join(runtime, 'native'), { recursive: true })
  await cp(native, join(runtime, 'native', 'jy-draftc.exe'))
}
const entries = []
async function scan(dir) {
  for (const file of (await readdir(dir)).sort()) {
    const path = join(dir, file)
    if ((await stat(path)).isDirectory()) await scan(path)
    else if (file !== 'manifest.json') entries.push({ path: relative(runtime, path).replaceAll('\\', '/'), sha256: createHash('sha256').update(await readFile(path)).digest('hex') })
  }
}
await scan(runtime)
const backendVersion = (await readFile(join(source, 'src', 'jy_edit_mcp', '__init__.py'), 'utf8')).match(/__version__ = "([^"]+)"/)[1]
await writeFile(join(runtime, 'manifest.json'), JSON.stringify({ backend: 'jy-edit-mcp', version: backendVersion, files: entries }, null, 2) + '\n', 'utf8')
console.log(`Prepared ${entries.length} runtime files. Native binary: ${entries.some((entry) => entry.path.startsWith('native/'))}`)
