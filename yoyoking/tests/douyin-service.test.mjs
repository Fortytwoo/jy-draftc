import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDouyinService } from '../douyin-service.js'

async function sdkFixture() {
  const root = await mkdtemp(join(tmpdir(), 'yoyoking-douyin-sdk-'))
  await mkdir(join(root, 'src', 'douyin_creator_mcp'), { recursive: true })
  for (const file of ['pyproject.toml', 'uv.lock', 'src/douyin_creator_mcp/oauth_server.py']) await writeFile(join(root, file), '')
  return root
}

test('SDK service stays loopback-only with isolated dependencies, output and no inherited credentials', async () => {
  const sdkDirectory = await sdkFixture()
  const workspaceDirectory = join(sdkDirectory, 'test-workspace')
  const launch = buildDouyinService({ sdkDirectory, workspaceDirectory, port: 18014 }, {
    PATH: 'synthetic-path', SYSTEMROOT: 'synthetic-system-root',
    DOUYIN_CREATOR_MCP_HOST: '0.0.0.0', DOUYIN_CREATOR_MCP_PUBLIC_BASE_URL: 'https://example.invalid',
    DOUYIN_CREATOR_CREDENTIAL_VAULT_PATH: 'do-not-import-vault',
    DOUYIN_CREATOR_CREDENTIAL_KEY_FILE: 'do-not-import-key',
    DOUYIN_COOKIE: 'synthetic-sensitive-value', douyin_web_cookie: 'another-sensitive-value',
    DEEPSEEK_API_KEY: 'synthetic-sensitive-value', DSH_HOST: 'synthetic-sensitive-value', NODE_OPTIONS: 'synthetic-sensitive-value',
    PYTHONPATH: 'other-source-tree', VIRTUAL_ENV: 'other-env', UV_PROJECT_ENVIRONMENT: 'other-env',
  })
  assert.equal(launch.command, 'uv')
  assert.ok(launch.args.includes('--frozen'))
  assert.equal(launch.args.at(-1), 'douyin_creator_mcp.oauth_server')
  assert.equal(launch.env.PATH, 'synthetic-path')
  assert.equal(launch.env.SYSTEMROOT, 'synthetic-system-root')
  assert.equal(launch.env.DOUYIN_CREATOR_MCP_HOST, '127.0.0.1')
  assert.equal(launch.env.DOUYIN_CREATOR_MCP_PUBLIC_BASE_URL, 'http://127.0.0.1:18014')
  assert.equal(launch.env.DOUYIN_CREATOR_DOWNLOAD_DIR, join(workspaceDirectory, 'douyin-downloads'))
  assert.equal(launch.env.UV_PROJECT_ENVIRONMENT, join(workspaceDirectory, '.douyin-python-env'))
  assert.doesNotMatch(JSON.stringify(launch), /do-not-import|sensitive-value|other-env|other-source-tree/)
  assert.equal(launch.env.PYTHONUTF8, '1')
})

test('SDK service rejects missing sources, relative paths and invalid ports before launch', async () => {
  const sdkDirectory = await sdkFixture()
  const base = { sdkDirectory, workspaceDirectory: join(sdkDirectory, 'test-workspace') }
  for (const change of [{ sdkDirectory: 'relative' }, { workspaceDirectory: 'relative' }, { sdkDirectory: tmpdir() }, { port: 80 }, { port: 1.5 }, { port: 65536 }, { uvCommand: '' }]) {
    assert.throws(() => buildDouyinService({ ...base, ...change }))
  }
})
