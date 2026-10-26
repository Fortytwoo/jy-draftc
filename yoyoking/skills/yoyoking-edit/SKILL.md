---
name: yoyoking-edit
description: 使用 yoyoking MCP 组合视频剪辑、画面特效、蒙版、抠色、配乐、模板换料、草稿转换和原生 MP4 交付；适用于新建剪辑工程、复用本地剪映模板或定点返修，混剪和字幕任务再加载对应 Skill。
---

# yoyoking 剪辑与交付

工具名在本文中不带前缀，调用时使用插件系统提示给出的 `mcp__<serverName>__` 命名空间。先读实际工具 schema，使用真实返回的 ID。一次工具调用完成一个明确剪辑动作，按用户目标组合动作。

## 建立素材与工程上下文

1. `get_capabilities` 确认当前环境、可用功能和限制。需要原生导出时使用 `check_native=true`。未就绪时仍可编辑和保存草稿，准确说明原生导出的缺项。
2. `probe_media` 检查指定素材的时长、画幅、音轨和哈希；`extract_frame` 抽取候选源时间点并实际观察图像，再描述内容和选择镜头。未知内容保留为未知。
3. 用户说“当前工程/这个视频”时先调用原生 `jianying_get_current_project`（无 MCP 前缀）获取 native_ref 和当前有效时间线。现有原生草稿分割用 `get_native_draft(ref)` → `split_native_clip(ref, seg_id, points, expected_content_sha256)`；points 为秒，默认相对片段起点，absolute=true 为时间线绝对时间。分割会生成新的原生工程副本，保留原稿；回读输出路径、片段源区间/时间线区间和 warnings，不能只看命令退出码。没有注册当前项目工具时可用 `list_native_projects` 定位。不要因模板接口没有 split 而说原生草稿不能分割。
4. 现有服务工程先 `get_project`，新工程用 `create_project`。原生草稿的其他模板操作仍读取 [高级能力与模板](references/advanced-editing.md)；native draft_id、template_id、project_id 不可互换。不要把原生工程重建成服务工程当作默认分割方案。
5. 根据用户已有要求确定画幅、时长和输出。能从素材和上下文判断时直接推进；缺失信息实质影响结果时才询问。

`split_native_clip` 仅将副本放入剪映工程目录，不自动切换、重开或刷新当前正在显示的工程。分割完成后，在用户完全退出剪映时调用 `prepare_native_copy(ref=output_ref, expected_content_sha256=output_sha256)`，校正该副本的名称/ID/路径、同步有效主时间线到根目录镜像，并登记其首页条目；工具保留备份，只接受本服务成功分割且尚未被修改的副本。`NATIVE_EDITOR_RUNNING` 表示需要先退出剪映，不能绕过检查写入。Harness 可以保持打开。

首页有条目、分割回读成功，都不代表剪映已能打开。`prepare_native_copy` 成功后仍要由用户重开剪映验证该副本，确认可打开再继续后续批次；准备操作不自动打开 UI。若 warnings 含 -100140，保留历史警告并用准备结果报告当前登记状态，不盲目重复分割。分割失败保留 operation_id、output_ref 和 receipt_path；先检查回执，不用试错副本替换原稿或擅自删除。

传回的片段范围是整数微秒，入参 points 仍为秒；严格在片段内部切分。供应商落盘有时会产生 1 微秒舍入差，工具按真实回读的 `effective_points_us` 报告；不得称其为“一帧”误差或要求用户改小数位规避。校验仍要求片段严格连续、原始源范围及总时长不变。

Harness 仅在当前模型路由明确支持 image 输入且有 attachment store 时将图像提供给模型。如果返回 image unavailable 等诊断，不能声称已经看过画面；可按明确时间点继续剪辑，内容选择需要可用的视觉路由或用户说明。

## 原生工程扩展编辑

- 用 `get_native_clip(ref, seg_id)` 查询完整片段、文字内容、速度曲线、关联素材及缺失引用；入参编辑时间仍是秒，详情中的时间区间是微秒。
- `set_native_clip_speed` 三选一：恒速 speed、预设 curve_name、自定义 curve_points。预设为 Hero/Montage/Bullet/JumpCut/FlashIn/FlashOut；曲线点 x 从 0 到 1 严格递增，y 是倍速。保持源区间/时间线起点，不自动移动后续镜头；不能把曲线落盘称为观感验收。
- `add_native_subtitles(ref, cues)` 将明确的文字与时间逐句写入原生副本；cues 的 start/duration 为时间线秒，不执行 ASR，也不接受把源字幕未经换算直接当作剪辑后的时间线。
- `remove_native_clip(..., ripple=true)` 仅移动同轨后续片段，其他轨道应保持不变。供应商磁吸主轨若产生摘要与落盘时间不一致，工具会拒绝验收；不能忽略失败强行交付副本。
- 这些写操作每次都复制成新工程。下一步用上次返回的 output_ref/output_sha256，不能继续对旧 ref 操作却期待新副本累积变化。`prepare_native_copy` 也支持这些成功回执。
- 失败或超时先用 `list_native_operations` → `get_native_operation`，查看原生错误码、completed/skipped/command_count 和回执；started 不证明仍在运行，不盲目重复提交。多句字幕中途失败保留未验收副本，不称为批量成功。

## 页面播放素材

Web/Desktop 默认在回复正文下方自动显示视频快速预览。交付成片或介绍已知素材时，在最终回复中用行内代码或 Markdown 链接写出其真实绝对路径即可，交付表中的 MP4 路径也会被识别；不用另调预览工具，不要求用户再说“打开视频”。历史回复打开或刷新后也会恢复预览，每条回复最多显示三个不重复的视频。

原生 `yoyoking_preview_video` 工具（**不加 MCP 前缀**）仍可用于用户明确指定某个素材起播时间的操作。`path` 为已知素材或成功产物路径，`title` 可选，`start` 为起播秒数且必须小于视频时长。可播放允许素材目录和 workspace 内的视频，相对路径从第一个素材目录解析；自动回复预览使用绝对路径。

播放器支持播放/暂停、拖动进度、音量和全屏；不自动播放、不转码。默认优先 H.264 / AAC MP4，其他格式取决于当前浏览器编码支持。文件失效或无法解码会显示错误和重新加载按钮。纯 CLI/headless 宿主没有此页面播放器。页面播放不等于模型已经观察内容，仍用 `extract_frame` 做实际画面观察；预览也不代替 `validate_output`。

## 组合剪辑动作

- `add_track` 创建 video/audio/text/sticker/effect/filter 轨道；视觉轨道列表中后面的轨道位于前面的上方，`reorder_track` 调整层级。
- `add_video_clip` / `add_audio_clip` 用源区间和时间线 `start` 定位；`add_image_clip` / `add_text_clip` 显式设置时长。可从视频添加派生音频轨道。
- `trim_clip` 裁切源区间，`split_clip.at` 为时间线绝对位置，`move_clip` 重排，`remove_clip` 删除。编辑默认不自动推移后续片段；`remove_clip(ripple=true)` 可原子完成同轨删除与后续平移，其他空隙需自行移动。主轨禁止重叠；跨轨可以重叠。
- `set_clip_transform` 增量设置画面位置、缩放、旋转、透明度与 contain/cover。中心原点、归一化 x/y、+y 向上，缩放为倍数，旋转为度。画中画使用额外上层 video 轨道。
- `set_clip_speed` 设置恒定速度；时间线时长=源时长/speed。其后片段位置需要重新计算。
- `set_clip_audio` 完整设置 volume/fade_in/fade_out，省略分别恢复 1/0/0；修改单项时带上需要保留的其余值。支持独立音频和视频原声淡入淡出。
- `set_keyframes` 替换一个属性的全部线性关键帧，`time` 相对片段起点；空数组清除。转场先 `list_transitions` 获取准确名称，再 `set_transition`。

字体、花字、动画、滤镜、特效、蒙版、色度抠图、混合模式、贴纸、音效或模板任务，按需读取 [高级能力与模板](references/advanced-editing.md)。先发现资源和参数，再应用效果；不要凭名称猜 effect_id。`get_project` 可回读所有新增设置，附加效果用 effect_id 单独修改或移除。

工具时间入参均为秒；返回字段 `_us` 是微秒，除以 1000000 后才能传回秒参数。每次编辑跟进返回的 revision，后续传 `expected_revision`。冲突时重新读取工程并调整；超时或连接中断时先查工程/任务，添加、分割、导出不能盲目重试。错误操作不提交部分工程。

## 检查与交付

1. `get_project` 检查镜头位置、总时长、字幕范围、层级和音轨；分页读取完整所需范围。
2. `save_draft` 得到新的不可变 `draft_id`。快照引用本机素材路径，源文件不能改写或移动。返修生成新快照，保留旧版本。
3. 用户要求 MP4 时 `export_video(draft_id=...)`，记录 `job_id`，按合理间隔 `get_job` 到终态。queued/running 不是完成；取消请求后也要读取终态。
4. succeeded 后检查产物和 `validate_output`。报告实际文件路径、工程/快照/任务 ID、技术检查结果及内容观察范围。技术校验不代表节奏、审美或字幕内容已验收。
5. Windows 宿主退出可能结束导出子进程；interrupted 时保留日志与回执，检查后从同一 draft_id 提交新的任务。任务记录持久化不等于后台任务能跨 Host 退出运行。

分别说明工程编辑、草稿生成、原生渲染、成片观察、剪映 UI 打开/保存/重开状态。资源目录、缓存线索和导出成功都不等于具体效果已被视觉或听觉确认。ASR、云端发布、AI 生成、智能人像抠图、目标跟踪、光流补帧和服务工程曲线变速尚不属于这些工具；已有原生工程曲线变速、原生形状蒙版和色度抠图。
