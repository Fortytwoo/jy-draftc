import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { buildDouyinService } from '../douyin-service.js'

const [sdkDirectory, workspaceDirectory, port = '8014', ...extra] = process.argv.slice(2)
if (!sdkDirectory || !workspaceDirectory || extra.length) {
  console.error('Usage: node scripts/start-douyin.mjs <absolute SDK directory> <absolute yoyoking workspace> [port]')
  process.exitCode = 1
} else {
  try {
    const launch = buildDouyinService({ sdkDirectory, workspaceDirectory, port: Number(port) })
    mkdirSync(launch.env.DOUYIN_CREATOR_DOWNLOAD_DIR, { recursive: true })
    console.log(`Douyin OAuth MCP: ${launch.env.DOUYIN_CREATOR_MCP_PUBLIC_BASE_URL}/mcp`)
    console.log(`Controlled output: ${launch.env.DOUYIN_CREATOR_DOWNLOAD_DIR}`)
    console.log('Memory-only credentials; login is initiated explicitly by the MCP client. Stop with Ctrl+C.')
    const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: 'inherit', shell: false })
    child.once('error', () => { console.error('Unable to launch Douyin SDK. Check uv and the SDK installation.'); process.exitCode = 1 })
    child.once('exit', (code) => { process.exitCode = code ?? 1 })
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
