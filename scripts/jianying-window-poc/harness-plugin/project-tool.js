/** Native Agent tool; the desktop supplies its public defineTool API. */
export function registerCurrentProjectTool(ctx, read, defineTool) {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'jianying_get_current_project',
    description: '只读获取 Harness 右侧正在接入的剪映工程。用户提到“当前项目”“这个视频”“时间线里的素材”时先调用，无需用户复制路径。通过剪映 PID 持有的工程锁确认项目，返回真实工程名、草稿目录、时间线轨道/片段、素材源文件绝对路径、是否存在及最近已保存快照。分页字段单位为微秒。它不等于 list_projects 的服务工程，也不会保存、修改或导出当前工程；未保存的内存修改、播放头和选中片段不可见。',
    parameters: {
      clip_offset: { type: 'integer', description: 'Clip pagination offset, default 0; non-negative.' },
      material_offset: { type: 'integer', description: 'Source material pagination offset, default 0; non-negative.' },
      limit: { type: 'integer', description: 'Page size 1..200, default 50.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, execution) {
      try { return await read(args, execution.signal) }
      catch (error) {
        if (execution.signal.aborted) throw error
        return { ok: false, error: { code: error.code || 'CURRENT_PROJECT_UNAVAILABLE', message: error.message, ...error.details } }
      }
    },
    presentCall: () => ({ card: 'generic', title: '读取当前剪映项目' }),
  })))
  ctx.effect(() => ctx.systemPrompt.section({ name: 'jianying-current-project', order: 21, interpolate: false,
    text: 'When the user refers to the current Jianying project or "this video" in the embedded editor, call native tool jianying_get_current_project first. It identifies the project held open by that editor process and supplies actual source paths. list_projects only lists service-created timelines and cannot answer this. Never invent an example source path or treat an unrelated service project as the open native draft. The tool reads the latest saved main timeline; unsaved in-memory edits are unknown. Native draft IDs are not service project IDs. For native splitting use MCP get_native_draft and split_native_clip with native_ref, returned segment ID, cut points in seconds, and the saved content hash. That tool makes a new native project copy; it does not patch the original or imply the new copy is open in the UI. Do not claim native drafts cannot be split merely because the template API lacks split.' }))
}
