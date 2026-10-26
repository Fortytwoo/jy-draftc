import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = join(root, 'cherry-studio', 'resources', 'yoyoking')
await mkdir(dirname(output), { recursive: true })
const checkout = await realpath(join(root, 'cherry-studio'))
const parent = await realpath(dirname(output))
if (relative(checkout, parent) !== 'resources' || resolve(output) !== join(parent, 'yoyoking')) throw new Error('Unsafe runtime destination')
const existing = await lstat(output).catch(error => { if (error.code !== 'ENOENT') throw error })
if (existing?.isSymbolicLink()) throw new Error('Runtime destination must not be a directory link')
await rm(output, { recursive: true, force: true })
const files = []
async function save(name, bytes) {
  const target = join(output, name)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, bytes)
  files.push({ path: name, sha256: createHash('sha256').update(bytes).digest('hex') })
}
async function copy(source, target = source) {
  await save(target, await readFile(join(root, source)))
}
for (const file of ['pyproject.toml', 'uv.lock', '.python-version', 'LICENSE', 'docs/jy-edit-mcp.md']) {
  await copy(file, `backend/${file}`)
}
for (const file of await readdir(join(root, 'src/jy_edit_mcp'))) {
  if (file.endsWith('.py')) await copy(`src/jy_edit_mcp/${file}`, `backend/src/jy_edit_mcp/${file}`)
}
for (const [source, target] of [
  ['build/jy-draftc.exe', 'bin/jy-draftc.exe'],
  ['build/jianying-window-poc/window-host.exe', 'bin/window-host.exe']
]) await copy(source, target)

await save('adapters/package.json', JSON.stringify({ private: true, type: 'module' }) + '\n')
for (const file of ['douyin-host.js', 'douyin-process.js', 'douyin-service.js', 'douyin-oauth.js']) {
  let text = await readFile(join(root, 'yoyoking', file), 'utf8')
  if (file === 'douyin-oauth.js') {
    text = text.replace("import { auth } from '@modelcontextprotocol/client'\n", '')
      .replace('createDouyinOAuth({ url,', 'createDouyinOAuth({ auth, url,')
  }
  if (file === 'douyin-host.js') text = text.replace('Harness 已关闭抖音服务。', 'Yoyoking Studio 已关闭抖音服务。')
  await save(`adapters/${file}`, text)
}
await copy('yoyoking/douyin/managed_server.py', 'adapters/douyin/managed_server.py')
for (const file of ['selection.js', 'current-project.js']) {
  await copy(`scripts/jianying-window-poc/harness-plugin/${file}`, `adapters/${file}`)
}
async function copySkills(source, prefix) {
  for (const entry of await readdir(join(root, source), { withFileTypes: true })) {
    const path = `${source}/${entry.name}`, target = `${prefix}/${entry.name}`
    if (entry.isDirectory()) await copySkills(path, target)
    else if (entry.name.endsWith('.md')) {
      let text = await readFile(join(root, path), 'utf8')
      text = text.replaceAll('Harness', 'Yoyoking Studio')
        .replaceAll('jianying_get_current_project', 'yoyoking_current_project')
        .replaceAll('yoyoking_preview_video', 'yoyoking_preview_video')
        .replace('工具名在本文中不带前缀，调用时使用插件系统提示给出的 `mcp__<serverName>__` 命名空间。',
          '本文工具名不带前缀。先发现当前 Agent 实际工具目录，使用 Cherry Studio 提供的完整名称，不手拼命名空间。')
      text = text.replaceAll('（无 MCP 前缀）', '（使用当前 MCP 目录中的完整名称）')
        .replace('系统提示给出实际命名空间；默认调用 `mcp__yoyoking_douyin__<原始工具名>`。', '使用当前 Agent 工具目录中的完整名称，不手拼 MCP 命名空间。')
        .replace('Yoyoking Studio 会把超过 64 字符的名称截短并添加哈希，不要手拼这类名称。', '不要根据旧宿主的截短规则猜测工具名称。')
        .replace('用户可在侧栏“抖音账号”点击“登录抖音”，再点击“打开官方登录”完成确认；无需配置参数。', '用户可在剪辑工作台的“抖音账号”页签点击“官方登录”，在官方窗口完成确认；无需填写凭据或端口。')
        .replace('`<namespace>_connect`、`<namespace>_status`\n  和 `<namespace>_disconnect`', '`yoyoking_douyin_connect`、`yoyoking_douyin_status`\n  和 `yoyoking_douyin_disconnect` 的实际完整工具名')
      const preview = text.indexOf('## 页面播放素材')
      if (preview >= 0) {
        const next = text.indexOf('\n## ', preview + 3)
        text = text.slice(0, preview) + '## 页面播放素材\n\n交付素材或已成功导出的成片时，显式调用当前 MCP 目录中的 `yoyoking_preview_video(path)`，使用允许素材目录或 workspace 内的真实绝对路径。工具通知剪辑工作台显示视频；仅在回复里写路径不会自动播放。当前宿主该工具只接受 path，不沿用旧宿主的 title/start 参数。\n\n用户可在工作台或剪辑会话右侧的剪辑工作台面板播放、暂停、拖动进度、调节音量和全屏。页面预览不证明模型已看过内容；没有打开工作台时不能声称播放器已经展示。\n' + (next >= 0 ? text.slice(next) : '')
      }
      await save(target, text)
    }
  }
}
await copySkills('yoyoking/skills', 'skills')
await copySkills('yoyoking/douyin/skills', 'skills')
await save('LICENSE.jy-draftc', await readFile(join(root, 'LICENSE')))
files.sort((a, b) => a.path.localeCompare(b.path))
await mkdir(output, { recursive: true })
await writeFile(join(output, 'manifest.json'), JSON.stringify({ version: 1, files }, null, 2) + '\n', 'utf8')
console.log(`Prepared ${files.length} pinned resources at ${output}`)
