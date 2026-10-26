/** Real Cordis lifecycle + real stdio MCP; no model key or proprietary media required. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Skills from '@deepseek-ai/dsh-skill'
import { pluginModule } from './plugin-target.mjs'
const Yoyoking = await pluginModule('index.js')

async function host() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(Skills)
  return ctx
}

export async function call(ctx, rawName, args = {}, scope) {
  const result = await ctx.tools.execute({
    name: `mcp__yoyoking__${rawName}`, arguments: args, scope,
    callId: `yoyoking-${crypto.randomUUID()}`, signal: AbortSignal.timeout(180000),
  })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(result.value.structuredContent.ok, true, JSON.stringify(result.value))
  return result.value.structuredContent
}

test('discovers tools and packaged skills, persists edits, and cleans up on disposal', { timeout: 180000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'yoyoking-host-'))
  const ctx = await host()
  try {
    const config = { workspaceDirectory: join(root, 'workspace'), mediaRoots: [root], douyinEnabled: false }
    const fiber = await ctx.plugin(Yoyoking, config)
    const catalog = ctx.tools.schemas().map((tool) => tool.name).sort()
    const expected = JSON.parse(await readFile(fileURLToPath(new URL('../../docs/jy-edit-tools.json', import.meta.url)), 'utf8'))
    assert.deepEqual(catalog, expected.tools.map((tool) => `mcp__yoyoking__${tool.name}`).sort())
    assert.deepEqual((await ctx.skills.list()).map((skill) => skill.name).sort(), ['yoyoking-captions', 'yoyoking-edit', 'yoyoking-montage'])
    const main = await ctx.skills.get('yoyoking-edit')
    assert.ok(main.content.includes('expected_revision'))
    assert.ok(renderPrompt(await ctx.systemPrompt.assemble()).includes('mcp__yoyoking__<name>'))
    const project = await call(ctx, 'create_project', { name: 'Harness 持久化测试', width: 320, height: 180 })
    const track = await call(ctx, 'add_track', { project_id: project.project_id, kind: 'text', name: '标题', expected_revision: project.revision })
    await call(ctx, 'add_text_clip', { project_id: project.project_id, track_id: track.track_id, text: 'yoyoking 测试', duration: 2, expected_revision: track.revision })
    const before = await call(ctx, 'get_project', { project_id: project.project_id })
    const bad = await ctx.tools.execute({ name: 'mcp__yoyoking__add_track', arguments: { project_id: project.project_id, kind: 'text', name: '冲突轨道', expected_revision: 0 }, callId: 'conflict', signal: AbortSignal.timeout(10000) })
    assert.equal(bad.isError, true)
    assert.equal((await call(ctx, 'get_project', { project_id: project.project_id })).revision, before.revision)
    await fiber.dispose()
    assert.deepEqual(ctx.tools.schemas(), [])
    assert.deepEqual(await ctx.skills.list(), [])
    assert.ok(!renderPrompt(await ctx.systemPrompt.assemble()).includes('yoyoking video editing plugin'))
    await ctx.plugin(Yoyoking, config)
    assert.equal((await call(ctx, 'get_project', { project_id: project.project_id })).clip_count, 1)
  } finally { await ctx.fiber.dispose() }
})

test('failed MCP startup publishes no tools or skills', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'yoyoking-broken-'))
  const ctx = await host()
  try {
    const fiber = ctx.plugin(Yoyoking, { workspaceDirectory: join(root, 'workspace'), mediaRoots: [root], uvCommand: join(root, 'missing-uv.exe') })
    await assert.rejects(Promise.resolve(fiber))
    assert.deepEqual(ctx.tools.schemas(), [])
    assert.deepEqual(await ctx.skills.list(), [])
    assert.ok(!renderPrompt(await ctx.systemPrompt.assemble()).includes('yoyoking video editing plugin'))
  } finally { await ctx.fiber.dispose() }
})
