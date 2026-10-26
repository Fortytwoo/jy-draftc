/** Test-only plugin mounted by the official dsh launcher in a disposable profile. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { agentEvents } from '@deepseek-ai/dsh-agent'

const exec = promisify(execFile)
export const name = 'yoyoking-profile-acceptance'
export const inject = ['loader', 'agentPresets', 'agents', 'tools', 'skills']

export function apply(ctx, config) {
  const abort = new AbortController()
  let task
  let finished = false
  ctx.effect(() => {
    const timer = setTimeout(() => {
      task = run(ctx, config, abort.signal).catch(async (error) => {
        await writeFile(join(config.directory, 'acceptance.json'), JSON.stringify({ passed: false, error: error.stack }, null, 2), 'utf8')
        ctx.logger.error(error)
        process.exitCode = 1
      }).finally(() => {
        finished = true
        // The official launcher's signal handler owns application shutdown.
        process.emit('SIGTERM')
      })
    }, 0)
    return async () => {
      clearTimeout(timer)
      abort.abort(new Error('Acceptance profile disposed'))
      if (task && !finished) await task
    }
  })
}

async function run(ctx, config, signal) {
  await ctx.loader.await()
  const roster = await ctx.agentPresets.list()
  const preset = roster.find((row) => row.id === 'yoyoking')
  assert.ok(preset && !preset.broken, JSON.stringify(roster))
  assert.ok(!ctx.tools.schemas().some((tool) => tool.name.startsWith('mcp__yoyoking__')), 'Editing tools leaked into host scope')
  assert.ok(!(await ctx.skills.list()).some((skill) => skill.name.startsWith('yoyoking-')), 'Skills leaked into host scope')
  const handle = await ctx.agents.create({
    sessionId: `yoyoking-acceptance-${crypto.randomUUID()}`,
    meta: { cwd: config.directory, agentPreset: 'yoyoking' },
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'yoyoking') },
  })
  try {
    const agent = handle.agent
    const transcript = []
    const execute = async (name, args = {}) => {
      const result = await ctx.tools.execute({ name, arguments: args, agent, callId: crypto.randomUUID(), signal })
      assert.equal(result.isError, false, JSON.stringify(result))
      transcript.push({ name, arguments: args, result: result.value })
      return result.value
    }
    const call = async (raw, args = {}) => {
      const value = await execute(`mcp__yoyoking__${raw}`, args)
      assert.equal(value.structuredContent.ok, true)
      return value.structuredContent
    }
    const toolNames = ctx.tools.schemas(agent).map((tool) => tool.name).sort()
    assert.equal(toolNames.filter((name) => name.startsWith('mcp__yoyoking__')).length, 71)
    for (const name of ['get_native_clip', 'remove_native_clip', 'set_native_clip_speed', 'add_native_subtitles', 'get_native_operation', 'list_native_operations']) {
      assert.ok(toolNames.includes(`mcp__yoyoking__${name}`))
    }
    assert.ok(toolNames.includes('mcp__yoyoking__split_native_clip'))
    assert.ok(toolNames.includes('mcp__yoyoking__prepare_native_copy'))
    const skills = (await ctx.skills.list({ scope: agent, cwd: config.directory })).filter((skill) => skill.name.startsWith('yoyoking-'))
    assert.deepEqual(skills.map((skill) => skill.name).sort(), ['yoyoking-captions', 'yoyoking-edit', 'yoyoking-montage'])
    const decision = await agentEvents(ctx, agent).waterfall('agent/pre-step', { messages: [], turn: 1, step: 1, signal }, () => Promise.resolve({ kind: 'enter', messages: [] }))
    assert.equal(decision.kind, 'enter')
    const catalog = decision.messages.find((message) => message.source?.kind === 'skill-catalog')
    assert.ok(catalog, 'No durable skill catalog was proposed')
    agent.session.append('user/message', catalog, { surfaceOp: 'append' })
    for (const skill of skills) {
      const loaded = await execute('skill', { name: skill.name })
      assert.ok(loaded.content.includes('yoyoking-edit') || loaded.content.includes('expected_revision'))
    }
    const caps = await call('get_capabilities', { check_native: true })
    assert.equal(caps.native.self_check_passed, true)
    const inputs = join(config.directory, 'input')
    await mkdir(inputs, { recursive: true })
    const source = join(inputs, 'source.mp4')
    await exec('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=1.5', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=1.5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source], { signal })
    await writeFile(join(inputs, 'captions.srt'), '1\n00:00:00,000 --> 00:00:00,900\nyoyoking 字幕\n\n2\n00:00:01,000 --> 00:00:01,900\n剪辑组合测试\n', 'utf8')
    const sourceHash = createHash('sha256').update(await readFile(source)).digest('hex')
    const probe = await call('probe_media', { path: source })
    assert.equal(probe.has_audio, true)
    const extracted = await execute('mcp__yoyoking__extract_frame', { path: source, at: 0.4 })
    assert.ok(extracted.content.some((block) => block.type === 'image' && block.mimeType === 'image/png'))
    const p = await call('create_project', { name: 'yoyoking Harness 原生验收', width: 320, height: 180, fps: 30 })
    let revision = p.revision
    const mutate = async (name, args) => {
      const result = await call(name, { project_id: p.project_id, expected_revision: revision, ...args })
      revision = result.revision
      return result
    }
    const video = await mutate('add_track', { name: '镜头', kind: 'video' })
    const audio = await mutate('add_track', { name: '声音', kind: 'audio' })
    const text = await mutate('add_track', { name: '字幕', kind: 'text' })
    const first = await mutate('add_video_clip', { track_id: video.track_id, path: source, source_in: 0.5, source_duration: 1, start: 0 })
    const second = await mutate('add_video_clip', { track_id: video.track_id, path: source, source_in: 1.5, source_duration: 1, start: 1 })
    await mutate('set_clip_audio', { clip_id: first.clip_id, volume: 0 })
    await mutate('set_clip_audio', { clip_id: second.clip_id, volume: 0 })
    const music = await mutate('add_audio_clip', { track_id: audio.track_id, path: source, source_duration: 2 })
    await mutate('set_clip_audio', { clip_id: music.clip_id, volume: 0.3, fade_in: 0.1, fade_out: 0.2 })
    await mutate('import_subtitles', { track_id: text.track_id, path: join(inputs, 'captions.srt') })
    const timeline = await call('get_project', { project_id: p.project_id })
    assert.equal(timeline.duration, 2)
    const draft = await call('save_draft', { project_id: p.project_id })
    let job = await call('export_video', { draft_id: draft.draft_id, timeout: 120 })
    const deadline = Date.now() + 150000
    while (['queued', 'running'].includes(job.status)) {
      assert.ok(Date.now() < deadline, 'Native export exceeded acceptance deadline')
      signal.throwIfAborted()
      await new Promise((resolve) => setTimeout(resolve, 1000))
      job = await call('get_job', { job_id: job.job_id })
    }
    assert.equal(job.status, 'succeeded', JSON.stringify(job))
    const validation = await call('validate_output', { job_id: job.job_id })
    assert.equal(validation.passed, true)
    assert.equal(validation.media.has_audio, true)
    const output = job.artifacts[0].path
    const frames = []
    for (const [at, channel] of [[0.4, 0], [1.4, 2]]) {
      const { stdout } = await exec('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', output, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', signal })
      const pos = (60 * 320 + 30) * 3
      assert.ok(stdout[pos + channel] > 150 && stdout[pos + (channel + 1) % 3] < 100, 'Unexpected edited frame color')
      const png = join(config.directory, `output-${at}.png`)
      await exec('ffmpeg', ['-v', 'error', '-y', '-ss', String(at), '-i', output, '-frames:v', '1', png], { signal })
      frames.push(png)
    }
    assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'), sourceHash)
    await writeFile(join(config.directory, 'tool-transcript.json'), JSON.stringify(transcript, null, 2), 'utf8')
    await writeFile(join(config.directory, 'skill-catalog.json'), JSON.stringify(catalog, null, 2), 'utf8')
    await writeFile(join(config.directory, 'session-events.json'), JSON.stringify(agent.session.snapshotEvents(), null, 2), 'utf8')
    await writeFile(join(config.directory, 'acceptance.json'), JSON.stringify({
      passed: true, host: 'deepseek-harness dsh profile', preset: 'yoyoking', profile: ctx.get('profileContext')?.name,
      toolNames, skills: skills.map((skill) => ({ name: skill.name, description: skill.description })),
      native: { selfCheckPassed: caps.native.self_check_passed, dllSha256: caps.native.dll_sha256 },
      projectId: p.project_id, draftId: draft.draft_id, jobId: job.job_id, output, validation, frames,
      sourceUnchanged: true, modelRequestSent: false, desktopUiVerified: false, jianyingUiVerified: false,
    }, null, 2), 'utf8')
    ctx.logger.info(`yoyoking acceptance passed: ${output}`)
  } finally { await handle.dispose() }
}
