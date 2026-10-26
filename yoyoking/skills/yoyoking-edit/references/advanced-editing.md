# 高级剪辑能力、资源与模板

以下工具名沿用 `mcp__<serverName>__` 命名空间。优先读取真实 schema，入参时间为秒，回读 `_us` 和模板 timerange 为微秒。

## 资源选择

- `list_resources()` 返回分类；按 category/query 分页检索名称、资源 ID、VIP 标记和参数。分类覆盖 font、video_intro/outro/group、text_intro/outro/loop、video_effect、character_effect、filter、mask、mix_mode、audio_scene、tone、speech_to_song、transition。
- 必须使用返回的准确 name。参数 params 按 index 排列，输入是 0..100 的归一化值；省略项或 null 使用 SDK 默认值。滤镜使用 intensity=0..100，不传 params。
- `check_resource_availability(category,name,cache_roots=...)` 在允许目录内有限扫描名称/ID，默认不扫描。candidate_found 只说明找到候选路径；not_found 只说明指定目录未找到。均不能证明资源可渲染或账号有使用权限。没有下载接口，也不是剪映在线完整资源库。
- 花字、气泡和贴纸 ID 从 `inspect_template_resources` 读取。效果资源可能仍需本机剪映已有缓存和相应权益；不能编造 ID 或将静态目录当成效果已经可用。

## 文字

`set_text_style` 增量修改下划线、竖排、透明度、字间距、行间距、自动换行、最大行宽、描边透明度及已有字号/颜色/粗斜体。字体用 `set_text_font(name)`，花字用 `set_text_effect(effect_id)`，气泡用 `set_text_bubble(effect_id,resource_id)`，背景和阴影分别用 `set_text_background`、`set_text_shadow`。这些独立设置传 null 清除；气泡 ID 要成对提供或同时清除。

文字入场/出场/循环使用 `set_clip_animation` 的 text_intro/text_outro/text_loop；duration 为片段内持续时间，循环未传 duration 时覆盖整段。不同文字时段分别建立文本片段，不把花字误认为字体。

## 画面与声音

| 需求 | 工具与选择 |
| --- | --- |
| 片段入场/出场/组合动画 | `set_clip_animation`，使用 video_intro/video_outro/video_group；组合动画与入出场动画互斥，name=null 清除指定分类 |
| 附加画面/人物特效、滤镜 | `add_clip_effect` 返回稳定 effect_id；`update_clip_effect` 完整替换该效果设置；`remove_clip_effect` 移除 |
| 独立时间段的全局效果 | effect/filter 轨道 + `add_effect_clip`；修改用 `update_clip_effect`，删除整段用 `remove_clip` |
| 形状蒙版 | `set_clip_mask`；center_x/y 为源素材像素，size/rect_width 为比例，rotation 为度，feather 为 0..100；矩形才可设置宽度与圆角 |
| 绿幕或指定颜色抠图 | `set_clip_chroma`，颜色为 #RRGGBBAA；不是智能人像分割 |
| 图层混合 | `set_clip_mix_mode`，先查询 mix_mode 分类 |
| 模糊/纯色画布背景 | `set_clip_background`；仅底层 video 轨道片段生效，颜色为 #RRGGBBAA |
| 精确裁剪源画面 | `set_clip_crop`，左上原点，left/top/right/bottom 为 0..1；与画布 transform 的中心原点不同 |
| 原生贴纸 | sticker 轨道 + `add_sticker_clip`；支持 transform、定长、移动、移除 |
| 场景音效、变声 | audio 片段 + `add_clip_effect`，分类 audio_scene/tone/speech_to_song；每类最多一个，视频需要先提取独立音轨 |
| 视频原声淡入淡出 | 直接 `set_clip_audio`，无需为了淡入淡出拆音轨 |
| 调色关键帧 | `set_keyframes` 的 brightness/contrast/saturation；仅视频/图片；插值仍为线性 |
| 等比缩放关键帧 | uniform_scale 与 scale_x/scale_y 互斥，先清除旧属性后再切换 |

新增画面设置传 null 可清除。带动画、关键帧、转场或淡入淡出的片段分割前需清除这些时间设置，分割后重新应用。改变时长后检查动画和关键帧是否仍在片段内。

## 本地模板

1. 输入为本地 draft_content JSON 文件，路径和引用的音视频素材必须在 mediaRoots 内。加密内容先 `convert_local_draft(operation="decrypt")`，使用返回的新文件；转换不会覆盖原始文件。
2. `import_local_template` 创建独立 template_id；`list_templates` / `get_template` 获取 revision、track_id 和 segment_id。普通工程 clip 工具不操作模板。需要多个版本时 `duplicate_template`。
3. `inspect_template_resources` 查看花字、气泡、贴纸、字体等资源 ID；分页读取所需部分。
4. 按名称全局换料用 `replace_template_material_by_name`，它保留源区间和片段时长，重名会拒绝。按片段换料用 `replace_template_segment`，支持明确的 shrink/extend 策略，默认裁尾/截断新素材；变速片段暂不支持。音频换料需要独立音频文件。
5. `replace_template_text` 替换文字；多段文字模板使用字符串列表。`recalc_style` 决定是否按新长度重分配样式范围。
6. `import_template_track` 从另一模板复制 video/audio/text 轨道，支持时间偏移和层级索引；保留 SDK ID，因此重复轨道或冲突素材 ID 会被拒绝。依赖素材随轨道保留。
7. `save_template_draft` 产生不可变 draft_id，再用 `export_video`。每次修改跟进 expected_revision。原模板、历史快照和输入素材均保留。

## 原生转换与导出

- `convert_local_draft` 支持 decrypt/encrypt/upgrade/downgrade，版本转换输出明文副本；downgrade 必须传 target_version。工具在 workspace 内保留转换产物和回执。失败时报告原生错误，不更改输入草稿。
- `check_local_draft` 是原生结构/运行时检查，不等于 UI 打开或画面验收。
- `export_local_draft` 对外部明文草稿创建快照并提交已有任务队列。与 `export_video` 一样，通过 get_job/cancel_job/validate_output 管理任务。
- 导出的 options 可覆盖 width/height/fps，并传递 hard_encode、quality、color_space、mp4 原生数值选项；省略尺寸/帧率沿用草稿。原生枚举数值依赖版本，默认 0 之外的组合必须单独验证。不要承诺尚未验证的 HDR、色彩标准或硬件加速结果。
- 导出 succeeded 后仍按需求抽帧/试听，确认选定字体、花字、抠图边缘、蒙版、滤镜和声音效果确实生效。无可用资源时说明缺失，继续完成其他已确定的剪辑动作，交付实际完成范围。
