/** Fail packaging when generated runtime assets are missing, stale, or include local state. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, lstat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const plugin = fileURLToPath(new URL('../', import.meta.url))
const runtime = join(plugin, 'runtime')
const manifest = JSON.parse(await readFile(join(runtime, 'manifest.json'), 'utf8'))
assert.equal(manifest.backend, 'jy-edit-mcp')
const actual = []
async function scan(directory) {
  for (const file of await readdir(directory)) {
    const path = join(directory, file)
    const info = await lstat(path)
    assert.ok(!info.isSymbolicLink(), `Runtime links cannot be packed: ${path}`)
    if (info.isDirectory()) await scan(path)
    else if (file !== 'manifest.json') actual.push(relative(runtime, path).replaceAll('\\', '/'))
  }
}
await scan(runtime)
assert.deepEqual(actual.sort(), manifest.files.map((entry) => entry.path).sort(), 'Unexpected runtime files; run prepare:runtime again')
for (const entry of manifest.files) {
  assert.match(entry.path, /^(?:\.python-version|pyproject\.toml|uv\.lock|docs\/jy-edit-mcp\.md|docs\/jy-edit-tools\.json|src\/jy_edit_mcp\/[a-z_]+\.py|native\/jy-draftc\.exe)$/)
  const hash = createHash('sha256').update(await readFile(join(runtime, entry.path))).digest('hex')
  assert.equal(hash, entry.sha256, `Runtime hash mismatch: ${entry.path}`)
}
for (const required of ['pyproject.toml', 'uv.lock', 'src/jy_edit_mcp/server.py', 'src/jy_edit_mcp/worker.py']) assert.ok(actual.includes(required), `Missing ${required}`)
for (const locale of ['en', 'zh']) {
  const data = JSON.parse(await readFile(join(plugin, 'locale', `${locale}.json`), 'utf8'))
  assert.ok(data.meta.title && data.meta.description)
}
for (const name of ['yoyoking-edit', 'yoyoking-montage', 'yoyoking-captions']) {
  assert.ok((await readFile(join(plugin, 'skills', name, 'SKILL.md'), 'utf8')).startsWith(`---\nname: ${name}\n`))
}
const douyinFiles = []
async function scanDouyin(directory) {
  for (const file of await readdir(directory)) {
    const path = join(directory, file)
    const info = await lstat(path)
    assert.ok(!info.isSymbolicLink(), `Douyin links cannot be packed: ${path}`)
    if (info.isDirectory()) await scanDouyin(path)
    else douyinFiles.push(relative(join(plugin, 'douyin'), path).replaceAll('\\', '/'))
  }
}
await scanDouyin(join(plugin, 'douyin'))
assert.deepEqual(douyinFiles.sort(), ['managed_server.py', 'skills/yoyoking-douyin/SKILL.md', 'tools.json'], 'Unexpected Douyin payload; SDK source, credentials and runtime state must not be bundled')
const douyin = JSON.parse(await readFile(join(plugin, 'douyin', 'tools.json'), 'utf8'))
assert.equal(douyin.backend, 'douyin-creator-mcp')
assert.equal(douyin.tools.length, 24)
assert.equal(new Set(douyin.tools.map(tool => tool.name)).size, 24)
for (const tool of douyin.tools) {
  assert.match(tool.name, /^douyin_(?:creator|web)_/)
  for (const key of Object.keys(tool.inputSchema.properties || {})) assert.doesNotMatch(key, /cookie|web_?id|token|authorization|signature/i)
}
assert.ok((await readFile(join(plugin, 'douyin', 'skills', 'yoyoking-douyin', 'SKILL.md'), 'utf8')).startsWith('---\nname: yoyoking-douyin\n'))
assert.ok((await readFile(join(plugin, 'icon.svg'), 'utf8')).includes('<svg'))
console.log(`yoyoking payload verified: ${actual.length} editing runtime files, 3 editing skills, 24 Douyin schemas, managed launcher and 1 authorization-gated skill, no SDK account state`)
