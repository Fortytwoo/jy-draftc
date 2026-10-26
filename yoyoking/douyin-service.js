/** Launch the user's SDK separately; neither its source nor account state is bundled. */
import { statSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function buildManagedDouyinService(config, ambient = process.env) {
  const launch = buildDouyinService(config, ambient)
  launch.args.splice(-2, 2, 'python', '-B', fileURLToPath(new URL('./douyin/managed_server.py', import.meta.url)))
  return launch
}

export function buildDouyinService({ sdkDirectory, workspaceDirectory, port = 8014, uvCommand = 'uv', pythonVersion = '3.12' }, ambient = process.env) {
  if (!sdkDirectory || !isAbsolute(sdkDirectory) || !statSync(sdkDirectory).isDirectory()) throw new Error('sdkDirectory must be an existing absolute SDK directory')
  if (!workspaceDirectory || !isAbsolute(workspaceDirectory)) throw new Error('workspaceDirectory must be an absolute path')
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Douyin service port must be an integer between 1024 and 65535')
  if (!uvCommand.trim() || !pythonVersion.trim()) throw new Error('uvCommand and pythonVersion must not be empty')
  const sdk = realpathSync(sdkDirectory)
  for (const file of ['pyproject.toml', 'uv.lock', 'src/douyin_creator_mcp/oauth_server.py']) {
    if (!statSync(join(sdk, file)).isFile()) throw new Error(`Missing SDK entry: ${file}`)
  }
  const workspace = resolve(workspaceDirectory)
  // Do not inherit an existing account vault, alternate host, or Python environment.
  const env = Object.fromEntries(Object.entries(ambient).filter(([name]) => !/KEY|PASSWORD|SECRET|TOKEN/i.test(name) && !/^(?:DOUYIN_|DSH_|ELECTRON_|NODE_OPTIONS$|NODE_PATH$|UV_PROJECT|UV_WORKING_DIRECTORY$|VIRTUAL_ENV$|PYTHONPATH$|PYTHONHOME$)/i.test(name)))
  Object.assign(env, {
    PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1',
    UV_PROJECT_ENVIRONMENT: join(workspace, '.douyin-python-env'),
    DOUYIN_CREATOR_MCP_HOST: '127.0.0.1',
    DOUYIN_CREATOR_MCP_PORT: String(port),
    DOUYIN_CREATOR_MCP_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    DOUYIN_CREATOR_DOWNLOAD_DIR: join(workspace, 'douyin-downloads'),
  })
  return {
    command: uvCommand,
    args: ['run', '--project', sdk, '--directory', sdk, '--frozen', '--no-dev', '--python', pythonVersion, '-m', 'douyin_creator_mcp.oauth_server'],
    cwd: sdk,
    env,
  }
}
