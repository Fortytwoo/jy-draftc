---
name: yoyoking-captions
description: 使用 yoyoking 导入 SRT、制作可编辑字幕和标题，选择字体、花字、气泡、阴影背景和文字动画，或替换本地模板文字；服务不含语音识别，先加载 yoyoking-edit 获取工程与交付约定。
---

# 标题与字幕

先加载 `yoyoking-edit`。确认用户提供的字幕来源：已有 UTF-8 SRT 或明确的文字与时间段。工具没有 ASR，不把抽帧或音轨存在当作已识别语音；缺少转写和时间轴时说明缺项，继续可独立完成的工程准备。

已有原生工程不必重建：先 `get_native_draft`，再 `add_native_subtitles(ref, cues, expected_content_sha256)`。每句明确提供 text/start/duration（时间线秒），返回新副本的 output_ref 和实际字幕段 ID；每批最多 200 句，不允许重叠。下一批使用该新 ref/hash，失败先查询操作回执。该接口只添加已有文字，不做语音识别、翻译或自动源时间映射。

1. `get_project` 确认当前画幅、视频区间和已有文本；创建或复用 text 轨道。
2. 已有 SRT 用 `import_subtitles`，文件必须在允许的 mediaRoots 内。按实际 schema 提供 offset 等参数。SRT 时间是原字幕时间轴，视频发生裁切/重排后需要重新对齐；不能假定源字幕天然匹配新时间线。
3. 短标题或明确逐条字幕使用 `add_text_clip` 设置 text、start、duration。重叠字幕不能放在同一轨道；确有同时显示需要时使用不同 text 轨道。
4. `set_text_style` 增量修改文字及字号、颜色、粗斜体、下划线、竖排、字行间距、换行、透明度和描边。size 是剪映原生单位，不是像素；颜色使用工具要求的格式。字体、花字、气泡、文字背景/阴影、入出场和循环动画，按需读取 yoyoking-edit 的 `references/advanced-editing.md`，先查询资源再应用。花字不是字体，资源 ID 不凭名称猜测。
5. `set_clip_transform` 设置字幕位置；+y 向上。下方字幕通常需要负 y，实际位置根据素材观察调整，避免挡住关键主体。
6. 用 `move_clip` 修改 start，用 `set_clip_duration` 修改文本时长。跟进 revision 并持续传 expected_revision。

复用剪映模板样式时使用 `import_local_template` → `get_template` → `replace_template_text` → `save_template_draft`；多段模板传文字列表，保留原模板文件。检查每段文字的样式范围、动画时长和可用资源，不将模板操作混用为普通工程 clip 操作。

导出前回读文本、起止时间、轨道和样式。按字幕开始/结束点和代表性长句检查成片，记录实际看到的文字、遮挡和溢出问题。没有查看成片时只报告已写入草稿的文本与参数，不声称已完成可读性验收。保存和导出沿用 `yoyoking-edit` 的快照与任务流程。
