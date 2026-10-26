import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { readCurrentProject, summarizeDraft } from './current-project.js'

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'jianying-project-'))
  const drafts = join(root, '草稿'), selected = join(drafts, '当前工程'), stale = join(drafts, '更新但未打开')
  await mkdir(selected, { recursive: true }); await mkdir(stale)
  const source = join(root, '真实素材.mp4'); await writeFile(source, 'test')
  const content = { id: 'content-id', duration: 3000000, canvas_config: { width: 1280, height: 720 },
    materials: { videos: [{ id: 'material-1', path: source, material_name: '真实素材.mp4', type: 'video', duration: 3000000 }] },
    tracks: [{ id: 'track-1', type: 'video', segments: [0, 1].map(index => ({ id: 'clip-' + index, material_id: 'material-1', target_timerange: { start: index * 1000000, duration: 1000000 }, source_timerange: { start: index * 1000000, duration: 1000000 } })) }] }
  for (const directory of [selected, stale]) { await writeFile(join(directory, '.locked'), ''); await writeFile(join(directory, 'draft_content.json'), JSON.stringify(content)); await writeFile(join(directory, 'draft_meta_info.json'), JSON.stringify({ draft_id: 'native-draft-id', draft_name: '当前工程' })) }
  const binding = { active: true, target: { pid: 100, hwnd: 200, path: 'C:/Apps/JianyingPro.exe' }, panel: { hwnd: 300 } }
  let lockReads = 0, ambiguous = false, staleWindow = false, race = false
  const native = async (verb, argument) => {
    if (verb === 'family') return [{ ...binding.target, parent: staleWindow ? 999 : 300 }]
    assert.equal(verb, 'file-users'); lockReads++
    if (race && lockReads === 3) await writeFile(join(selected, 'draft_content.json'), JSON.stringify({ ...content, duration: 4000000 }))
    return argument.startsWith(selected) || ambiguous ? [{ pid: 100, path: binding.target.path, processStartFileTime: '12345' }] : [{ pid: 999, path: binding.target.path, processStartFileTime: '67890' }]
  }
  try { await run({ root, drafts, selected, stale, content, binding, native,
    config: { draftRoots: [drafts], snapshotDirectory: join(root, 'snapshots') },
    set(options) { ({ ambiguous = ambiguous, staleWindow = staleWindow, race = race } = options); lockReads = 0 } }) }
  finally { const path = relative(tmpdir(), root); assert.ok(path && !path.startsWith('..') && !isAbsolute(path)); await rm(root, { recursive: true }) }
}

test('current project is proven by attached PID lock, paginated and copied without editing the original', () => fixture(async data => {
  const original = await readFile(join(data.selected, 'draft_content.json'))
  const result = await readCurrentProject(data.config, () => data.binding, data.native, { limit: 1 })
  assert.equal(result.project.name, '当前工程'); assert.equal(result.draft_path, data.selected)
  assert.equal(result.evidence.method, 'attached_pid_holds_project_lock'); assert.equal(result.evidence.pid, 100)
  assert.equal(result.clips[0].clip_id, 'clip-0'); assert.equal(result.next_clip_offset, 1)
  assert.equal(result.materials[0].source_exists, true); assert.equal(result.clips[0].source_path, result.materials[0].source_path)
  assert.equal(result.state_source, 'last_saved_disk_snapshot'); assert.equal(result.unsaved_changes, 'unknown')
  assert.deepEqual(await readFile(join(data.selected, 'draft_content.json')), original)
  assert.deepEqual(await readFile(result.plain_content_path), original)
  const next = summarizeDraft(data.content, {}, { clip_offset: 1, limit: 1 }); assert.equal(next.clips[0].clip_id, 'clip-1'); assert.equal(next.next_clip_offset, null)
  const bin = summarizeDraft(data.content, { draft_materials:[{value:[{id:'bin-only',file_Path:join(data.root,'not-on-timeline.mp4'),metetype:'video'}]}] })
  assert.equal(bin.project.material_count,2);assert.equal(bin.materials[1].on_timeline,false);assert.equal(bin.materials[1].in_media_bin,true)
}))

test('unattached, changed and ambiguous editors fail instead of selecting a recent draft', () => fixture(async data => {
  data.binding.active = false; await assert.rejects(readCurrentProject(data.config, () => data.binding, data.native), { code: 'JIANYING_NOT_ATTACHED' })
  data.binding.active = true; data.set({ staleWindow: true }); await assert.rejects(readCurrentProject(data.config, () => data.binding, data.native), { code: 'EDITOR_CHANGED' })
  data.set({ staleWindow: false, ambiguous: true }); await assert.rejects(readCurrentProject(data.config, () => data.binding, data.native), { code: 'AMBIGUOUS_OPEN_DRAFT' })
  await assert.rejects(readCurrentProject(data.config, () => data.binding, async (verb, arg) => verb === 'file-users' ? [] : data.native(verb, arg)), { code: 'NO_OPEN_DRAFT' })
}))

test('autosave during reading and project junctions cannot silently change the selected snapshot', () => fixture(async data => {
  data.set({ race: true }); await assert.rejects(readCurrentProject(data.config, () => data.binding, data.native), { code: 'DRAFT_CHANGED_RETRY' })
  data.set({ race: false })
  const external = join(data.root, 'outside'); await mkdir(external); await writeFile(join(external, '.locked'), '')
  await symlink(external, join(data.drafts, 'linked-project'), process.platform === 'win32' ? 'junction' : 'dir')
  const result = await readCurrentProject(data.config, () => data.binding, data.native)
  assert.equal(result.draft_path, data.selected)
}))

test('main timeline wins over the stale root draft mirror', () => fixture(async data => {
  const timeline=join(data.selected,'Timelines','main');await mkdir(timeline,{recursive:true})
  await writeFile(join(data.selected,'Timelines','project.json'),JSON.stringify({main_timeline_id:'main',timelines:[{id:'main'}]}))
  const content=structuredClone(data.content);content.tracks[0].segments.push({...content.tracks[0].segments[0],id:'native-new-segment'})
  await writeFile(join(timeline,'draft_content.json'),JSON.stringify(content))
  const result=await readCurrentProject(data.config,()=>data.binding,data.native)
  assert.equal(result.project.clip_count,3);assert.equal(result.timeline_source,'main_timeline')
  assert.equal(result.native_content_path,join(timeline,'draft_content.json'));assert.equal(result.native_ref,'local://当前工程')
}))
