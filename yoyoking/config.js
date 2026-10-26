/** Build a reproducible MCP launch configuration without changing a user's profile. */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { validateDouyinUrl } from './douyin-oauth.js'

export const Config = z.object({
  visualizationOnly: z.boolean().default(false).description('Media/browser registration only; no SDK process or tools.'),
  hostServicesOnly: z.boolean().default(false).description('Keep shared media and managed Douyin service alive for the Host; no agent tools.'),
  workspaceDirectory: z.string().required().description('Absolute writable directory for projects, jobs, and Python environment.'),
  mediaRoots: z.array(z.string()).required().description('Existing absolute directories allowed for input media.'),
  serverName: z.string().default('yoyoking').description('MCP tool namespace; unique in this preset.'),
  uvCommand: z.string().default('uv'),
  pythonVersion: z.string().default('3.12'),
  runtimeDirectory: z.string().default('').description('Optional absolute development override for the packaged Python project.'),
  nativeExecutable: z.string().default('').description('Optional absolute jy-draftc.exe override; otherwise use the packaged native binary.'),
  jyInstallDirectory: z.string().default('').description('Matching Jianying version directory containing videoeditor.dll.'),
  lyraInstallDirectory: z.string().default('').description('Optional native draft CLI directory; defaults to jyInstallDirectory. Requires vebun.exe and lyra-cli.exe.'),
  nativeDraftRoot: z.string().default('').description('Optional native project root override; otherwise use the local Jianying custom draft setting.'),
  ffmpeg: z.string().default('ffmpeg'),
  ffprobe: z.string().default('ffprobe'),
  toolCallTimeoutMs: z.number().default(180000),
  douyinEnabled: z.boolean().default(true).description('Start the managed local SDK with Harness and expose login controls.'),
  douyinSdkDirectory: z.string().default('').description('Optional SDK override; auto-detected from the current user Documents/DouyinCreatorSDK.'),
  douyinServerUrl: z.string().default('').description('Advanced external-service override; empty uses the automatically managed service.'),
  douyinServerName: z.string().default('yoyoking_douyin').description('Separate MCP namespace for authenticated Douyin tools.'),
  douyinToolCallTimeoutMs: z.number().default(300000).description('Bounded per-call timeout; complete-account exports may take longer and must be checked before retrying.'),
})

export function buildDouyinConfig(input) {
  const config = Config(input)
  if (config.visualizationOnly || !config.douyinEnabled) return null
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(config.douyinServerName) || config.douyinServerName === config.serverName) throw new Error('douyinServerName must be a valid namespace distinct from serverName')
  if (!Number.isInteger(config.douyinToolCallTimeoutMs) || config.douyinToolCallTimeoutMs < 1000 || config.douyinToolCallTimeoutMs > 1800000) throw new Error('douyinToolCallTimeoutMs must be an integer between 1000 and 1800000')
  const sdkDirectory = config.douyinSdkDirectory || join(homedir(), 'Documents', 'DouyinCreatorSDK')
  if (!isAbsolute(sdkDirectory)) throw new Error('douyinSdkDirectory must be an absolute path')
  return {
    serverName: config.douyinServerName, url: config.douyinServerUrl ? validateDouyinUrl(config.douyinServerUrl) : '',
    toolCallTimeoutMs: config.douyinToolCallTimeoutMs,
    sdkDirectory, workspaceDirectory: resolve(config.workspaceDirectory),
    uvCommand: config.uvCommand, pythonVersion: config.pythonVersion,
  }
}

function absoluteDirectory(value, label) {
  if (!value || !isAbsolute(value)) throw new Error(`${label} must be an absolute path`)
  if (!statSync(value).isDirectory()) throw new Error(`${label} must be a directory: ${value}`)
  return realpathSync(value)
}

/** Resolve packaged assets and validate configuration before registering capabilities. */
export function buildLaunch(input) {
  const config = Config(input)
  if (!isAbsolute(config.workspaceDirectory)) throw new Error('workspaceDirectory must be an absolute path')
  if (!config.mediaRoots.length) throw new Error('mediaRoots must contain at least one directory')
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(config.serverName)) throw new Error('serverName must match [A-Za-z0-9_-]{1,32}')
  if (!Number.isInteger(config.toolCallTimeoutMs) || config.toolCallTimeoutMs < 1000) throw new Error('toolCallTimeoutMs must be an integer >= 1000')
  for (const key of ['uvCommand', 'pythonVersion', 'ffmpeg', 'ffprobe']) {
    if (!config[key].trim()) throw new Error(`${key} must not be empty`)
  }
  const mediaRoots = config.mediaRoots.map((root) => absoluteDirectory(root, 'mediaRoots entry'))
  const runtime = absoluteDirectory(config.runtimeDirectory || fileURLToPath(new URL('./runtime/', import.meta.url)), 'runtimeDirectory')
  for (const file of ['pyproject.toml', 'uv.lock', 'src/jy_edit_mcp/server.py']) {
    if (!statSync(join(runtime, file)).isFile()) throw new Error(`Missing runtime payload: ${file}`)
  }
  const native = config.nativeExecutable || join(runtime, 'native', 'jy-draftc.exe')
  if (config.nativeExecutable && (!isAbsolute(native) || !statSync(native).isFile())) throw new Error('nativeExecutable must be an existing absolute file')
  const jyDirectory = config.jyInstallDirectory ? absoluteDirectory(config.jyInstallDirectory, 'jyInstallDirectory') : ''
  if (jyDirectory && !existsSync(join(jyDirectory, 'videoeditor.dll'))) throw new Error('jyInstallDirectory must contain videoeditor.dll')
  return {
    serverName: config.serverName,
    transport: 'stdio',
    command: config.uvCommand,
    args: ['run', '--project', runtime, '--directory', runtime, '--frozen', '--no-dev', '--python', config.pythonVersion, '-m', 'jy_edit_mcp.server'],
    cwd: runtime,
    env: {
      PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1',
      UV_PROJECT_ENVIRONMENT: join(resolve(config.workspaceDirectory), '.python-env'),
      JY_EDIT_WORKSPACE: resolve(config.workspaceDirectory),
      JY_EDIT_MEDIA_ROOTS: JSON.stringify(mediaRoots),
      JY_DRAFTC_EXE: existsSync(native) ? native : '',
      JY_INSTALL_DIR: jyDirectory,
      JY_LYRA_INSTALL_DIR: config.lyraInstallDirectory ? absoluteDirectory(config.lyraInstallDirectory, 'lyraInstallDirectory') : jyDirectory,
      ...(config.nativeDraftRoot ? { JY_EDIT_NATIVE_DRAFT_ROOT: absoluteDirectory(config.nativeDraftRoot, 'nativeDraftRoot') } : {}),
      JY_EDIT_FFMPEG: config.ffmpeg, JY_EDIT_FFPROBE: config.ffprobe,
    },
    toolCallTimeoutMs: config.toolCallTimeoutMs,
    failOnStartupError: true,
    reconnect: { enabled: true, initialDelayMs: 1000, maxDelayMs: 15000, maxAttempts: 3 },
  }
}
