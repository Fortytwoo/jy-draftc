import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cp, mkdir, mkdtemp, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

test('packaging refuses altered runtime bytes and accidental local configuration', async () => {
  const source = fileURLToPath(new URL('../', import.meta.url))
  const fixture = await mkdtemp(join(tmpdir(), 'yoyoking-package-'))
  for (const path of ['runtime', 'skills', 'douyin', 'locale', 'icon.svg']) await cp(join(source, path), join(fixture, path), { recursive: true })
  await mkdir(join(fixture, 'scripts'))
  const script = join(fixture, 'scripts', 'check-package.mjs')
  await cp(join(source, 'scripts', 'check-package.mjs'), script)
  assert.equal(spawnSync(process.execPath, [script]).status, 0)
  const state = join(fixture, 'douyin', 'account-state.json')
  await writeFile(state, '{"fixture":"synthetic"}\n', 'utf8')
  const accountState = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  assert.notEqual(accountState.status, 0)
  assert.ok(accountState.stderr.includes('Unexpected Douyin payload'))
  await unlink(state)
  await writeFile(join(fixture, 'runtime', 'src', 'jy_edit_mcp', 'server.py'), '# altered\n', 'utf8')
  const altered = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  assert.notEqual(altered.status, 0)
  assert.ok(altered.stderr.includes('Runtime hash mismatch'))
  await cp(join(source, 'runtime', 'src', 'jy_edit_mcp', 'server.py'), join(fixture, 'runtime', 'src', 'jy_edit_mcp', 'server.py'))
  await writeFile(join(fixture, 'runtime', '.env'), 'LOCAL_SETTING=synthetic\n', 'utf8')
  const local = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  assert.notEqual(local.status, 0)
  assert.ok(local.stderr.includes('Unexpected runtime files'))
})
