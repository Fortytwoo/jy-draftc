import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildLaunch } from '../config.js'

test('rejects invalid paths, empty roots, and invalid namespaces before startup', () => {
  const base = { workspaceDirectory: join(tmpdir(), 'yoyoking-config'), mediaRoots: [tmpdir()] }
  for (const patch of [
    { workspaceDirectory: 'relative' }, { mediaRoots: [] }, { serverName: 'invalid name' },
    { toolCallTimeoutMs: 0 }, { runtimeDirectory: 'relative' }, { uvCommand: '' },
    { nativeExecutable: 'relative.exe' }, { jyInstallDirectory: tmpdir() },
  ]) assert.throws(() => buildLaunch({ ...base, ...patch }), undefined, JSON.stringify(patch))
  const launch = buildLaunch({ ...base, serverName: 'custom_editor' })
  assert.equal(launch.serverName, 'custom_editor')
  assert.equal(launch.env.PYTHONUTF8, '1')
  assert.equal(launch.failOnStartupError, true)
  assert.ok(launch.args.includes('--frozen'))
  assert.ok(launch.env.UV_PROJECT_ENVIRONMENT.startsWith(base.workspaceDirectory))
})
