# jy edit MCP 使用与开发

`jy-edit-mcp` 0.4.0 提供 71 个可组合的本地剪辑工具。Skill 负责理解需求、观察素材、安排镜头和选择操作；MCP 提供素材、轨道、片段、字幕、声音、画面、特效、模板换料和导出能力，不把某种视频流程固化成一个大工具。

工程状态独立于剪映草稿。编辑操作先修改服务自己的工程；`save_draft` 生成新草稿快照；`export_video` 使用当前仓库的 `jy-draftc` 原生引擎导出 MP4。后续编辑不会修改已经保存的快照，源素材不被改写。

0.3.0 新增已有原生工程的独立链路：`list_native_projects` 查询真实剪映草稿，`get_native_draft(ref)` 读取有效主时间线和段 ID/hash，`split_native_clip(ref, seg_id, points, expected_content_sha256)` 使用本机 `vebun.exe → lyra-cli.exe` 先复制工程再分割。points 入参为秒，默认相对片段起点；absolute=true 使用时间线绝对时间；严格在内部切分。它不把原生工程重建成服务 project，也不会覆盖用户原工程。

原生读取跟随 `Timelines/project.json` 的 main_timeline_id；根目录 draft_content.json 可能是旧镜像。多时间线没有明确选择器时拒绝猜测。原生拆分后会回读真正落盘的时间线，验证原 ID 保留、区间连续、素材内容一致、未选择内容不变及源稿哈希。供应商可能为新片段复制素材并分配新 material ID，不能以 ID 相等作为素材未变的唯一判断。

副本位于剪映草稿根目录，返回 output_ref/path、operation_id、receipt_path、warnings 和 desktop_catalog_updated。它不会自动打开或重载 UI；加密 root_meta_info.json 可能导致供应商首页登记警告 -100140，此时 desktop_catalog_updated=false，不能称为首页已显示。失败可能保留未验收副本，收到错误后先检查回执，不自动重试。原生 CLI 错误保留 native_error_code（如 -100110）和 recovery。get_capabilities 的 available 只验证可执行文件存在，session_checked=false 不表示登录已验证。

`prepare_native_copy(ref, expected_content_sha256)` 在完全退出剪映后，修复本服务成功编辑副本的元数据身份、根目录草稿镜像和它自己的首页登记条目。已存在的副本登记 ID 保留，缺失时分配独立 ID；原项目文件、其他登记条目及不透明全局索引字段保留。写前备份原始字节，写失败在没有并发更改时回滚。转换器仅对草稿内容 schema 加密，元数据可能以明文 JSON 输出；工具验证解码后对象一致，并明确返回 metadata_input/output_encrypted、catalog_input/output_encrypted，不把明文输出称为加密成功。拒绝无成功回执的工程、分割后改变的副本、重复身份、路径链接和正在运行的剪映。副本主时间线字节不变；准备成功仍不等于 UI 打开验收，元数据明文兼容性由真实打开验收确认。

原生分割对供应商的整数微秒舍入最多允许 1us 边界差，仍严格要求连续区间和首尾/源总时长完全相同。回执同时给出请求 `points_us` 和落盘 `effective_points_us`，不是帧对齐策略。

新增配置：`JY_LYRA_INSTALL_DIR`（默认 JY_INSTALL_DIR）、`JY_EDIT_NATIVE_DRAFT_ROOT`（默认读取本机剪映 currentCustomDraftPath）。不分发剪映程序，不扩展媒体白名单，也不将模板 ID、原生 ref 与服务 project_id 混用。

## 0.4.0 原生编辑扩展

参考 `E:/VMs/Shared/jianying` 的已实现案例，新增 6 个工具；复用本仓库的原生调用器，不依赖共享目录的 Python 包，也不复制或分发剪映程序。

| 工具 | 契约 |
| --- | --- |
| `get_native_clip(ref, seg_id)` | 回读完整片段、关联素材（文字、速度曲线、效果）、缺失引用和当前哈希；不打开素材文件 |
| `set_native_clip_speed` | 原生视频恒速、6 种预设曲线、自定义曲线；`speed` / `curve_name` / `curve_points` 必须三选一 |
| `add_native_subtitles` | 一次提交 1..200 句 `{text,start,duration}`；秒级时间线坐标，逐句原生可编辑字幕，不执行 ASR |
| `remove_native_clip` | 删除副本中的片段；`ripple=true` 只平移同轨后续片段，默认保留空隙 |
| `list_native_operations` | 分页查询最近的原生操作，包含失败和未确认副本 |
| `get_native_operation` | 按 operation_id 回读持久化进度、原生错误码、输出 ref、验证结果和回执路径 |

新增写工具和原有分割共用“锁定 → 检查源哈希 → 供应商复制 → 修改 → 有效时间线回读 → 复核源稿”链路。成功不只依赖命令退出码：逐项核对未选片段、关联素材、总时长、画布和请求结果。曲线/字幕/删除的副本名为 `mcp-edit-<operation_id>`，分割仍为 `mcp-split-<operation_id>`。`prepare_native_copy` 接受两类成功回执，仍要求完全退出剪映。

- **曲线**：预设为 `Hero/Montage/Bullet/JumpCut/FlashIn/FlashOut`。自定义点 `x` 为归一化源位置 0..1，`y` 为 0.01..100 倍速；2..50 点，严格递增，首尾必须为 0 和 1。保留素材源区间和时间线起点，不自动移动后续片段；曲线导致重叠时拒绝验收并保留未确认副本。服务工程的 `set_clip_speed` 仍只支持恒速。
- **字幕**：入参不允许空文本、NUL、零微秒时长或重叠；工具按开始时间排序。供应商选择字幕轨道，返回实际 track_id/segment_id。任何一句失败都不返回部分成功；原稿不变，但副本可能已有部分字幕，必须先查回执，不盲目重放。
- **波纹删除**：只减去被删片段时长，保留其他原有空隙，不做跨轨联动。供应商可能隐式移动主轨关联字幕：工具回读后仅恢复符合该已知位移的片段，并重新严格校验；其他结构变化拒绝验收。已到目标位置的 move 跳过，避免供应商将无变化操作报错。服务工程的 `remove_clip` 同样新增 `ripple=false` 可选参数，在一次 revision 事务内完成。
- **磁吸主轨限制**：本机真实成功验收覆盖独立视频轨道（flag=2）。磁吸主轨可能出现原生摘要起点与保存的 target_timerange 不一致，或删除时联动其他轨道；无法满足严格保留契约时返回失败，不把这种副本当成功结果，不宣称已支持所有主轨磁吸组合。
- **回执**：记录 `command_count/completed_commands/skipped_commands`，错误保留 `native_error_code/recovery`。`started` 只是最后持久化状态，不证明进程仍存活。失败副本不自动删除、不当作可打开或可导出的成功成果。
- **验收边界**：`structure_verified` 与 `render_verified/ui_opened` 分开报告。曲线落盘不等于变速观感验证；字幕入轨不等于语音识别；这轮未加入登录、在线素材下载、ASR、AI 抠像和跟踪。

建议调用：`get_native_draft` → 可选 `get_native_clip` → 编辑工具（带 `expected_content_sha256`）→ 使用返回的 `output_ref/output_sha256` 继续下一次编辑。每一步都会再生成副本，不能继续对旧 ref 编辑却期待累积到新副本。超时后用 `list_native_operations` 定位回执，再 `get_native_operation` 查询。

## 安装与启动

开发和本次验证使用 Windows x64、Python 3.12、剪映 `11.6.0.14552` 及对应的 `build/jy-draftc.exe`。需要 FFmpeg / ffprobe 在 PATH，或用环境变量指定绝对路径。

```powershell
cd G:\project\jy-draftc
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
uv sync --frozen --extra dev
uv run --no-sync jy-edit-mcp
```

最后一条命令启动 stdio MCP 服务，等待客户端的协议输入。它不是交互式命令行。未配置原生引擎时，工程编辑和草稿生成仍可使用，原生导出会明确返回不可用。

依赖锁定在 [uv.lock](../uv.lock)。剪映 SDK 固定到 `GuanYixuan/pyJianYingDraft` 的 `1e228479dda361e312e85f6037002346cf6dca9a`，当前版本为 `0.3.1`；MCP SDK 使用 `1.30.0`，依赖范围限制在 `<2`，避免混用 v2 的接口。

## 客户端配置

可参考 [当前 Windows 工作目录的配置样例](../examples/jy-edit-mcp.windows.json)。样例不会自动修改任何客户端配置；更换目录时修改其中的绝对路径。

| 环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `JY_EDIT_WORKSPACE` | 工程、快照、缓存、任务和产物目录 | 当前工作目录下 `.jy-edit-workspace` |
| `JY_EDIT_MEDIA_ROOTS` | 允许读取素材的目录，JSON 字符串数组 | 当前工作目录；相对素材路径相对第一个目录 |
| `JY_DRAFTC_EXE` | `jy-draftc.exe` 绝对路径 | 当前工作目录的 `build/jy-draftc.exe`，存在时使用 |
| `JY_INSTALL_DIR` | 包含匹配 `videoeditor.dll` 的剪映版本目录 | 未设置时读取 native exe 同目录 `.env` 的同名值 |
| `JY_EDIT_FFMPEG` | FFmpeg 可执行文件 | PATH 中的 `ffmpeg` |
| `JY_EDIT_FFPROBE` | ffprobe 可执行文件 | PATH 中的 `ffprobe` |

`JY_EDIT_MEDIA_ROOTS` 不是多个路径拼起来的分号字符串。例如 JSON 配置中的值为 `"[\"D:/素材\",\"E:/配乐\"]"`。输入文件必须位于配置目录内；符号链接按真实路径检查。

## 工具目录

完整参数契约见 [工具 schema JSON](jy-edit-tools.json)，由实际 `tools/list` 导出，不单独手写参数副本。

| 能力 | 工具 | 作用 |
| --- | --- | --- |
| 能力探测 | `get_capabilities` | 版本、依赖、运行时指纹、限制；可执行 native 自检 |
| 素材观察 | `probe_media`、`extract_frame` | 流信息、时长、哈希；返回实际画面图像供 Agent 观察 |
| 工程管理 | `create_project`、`list_projects`、`get_project` | 创建、查询、分页读取工程与稳定 ID |
| 轨道管理 | `add_track`、`reorder_track` | 视频、音频、文本轨道及层级调整 |
| 素材入轨 | `add_video_clip`、`add_audio_clip`、`add_image_clip` | 源区间、时间线位置、静态图片时长；支持从视频提取音频 |
| 文本与字幕 | `add_text_clip`、`import_subtitles`、`set_text_style` | 原生可编辑文本、UTF-8 SRT、样式和文字修改 |
| 片段剪辑 | `trim_clip`、`split_clip`、`move_clip`、`remove_clip`、`set_clip_duration` | 源区间裁切、分割、移动、移除、图片/文字定长 |
| 画面与速度 | `set_clip_transform`、`set_clip_speed` | 位置、缩放、旋转、透明度、翻转、contain/cover、恒定变速 |
| 声音 | `set_clip_audio` | 音量、静音和音频淡入淡出 |
| 转场 | `list_transitions`、`set_transition` | 发现名称、设置相邻画面片段的出场转场、清除转场 |
| 关键帧 | `set_keyframes` | 位置、缩放、旋转、透明度、音量的线性关键帧 |
| 草稿交付 | `save_draft` | 校验素材后编译新的草稿快照 |
| 原生导出 | `export_video`、`get_job`、`cancel_job`、`validate_output` | 异步渲染、状态查询、取消请求、成片重新验证 |

### 0.2.0 新增工具（31 个）

| 能力 | 工具 | 语义 |
| --- | --- | --- |
| 资源目录与缓存线索 | `list_resources`、`check_resource_availability` | 16 类静态 SDK 目录、分页、参数、VIP 标记；指定允许目录内有限扫描缓存候选，不下载资源、不宣称渲染可用 |
| 字体、花字、气泡 | `set_text_font`、`set_text_effect`、`set_text_bubble` | 名称来自目录，花字/气泡 ID 可从本地模板读取；null 清除 |
| 文字装饰 | `set_text_background`、`set_text_shadow` | 背景色块、圆角、偏移、阴影设置；null 清除 |
| 原生动画 | `set_clip_animation` | 视频/图片入出场及组合动画、文字入出场及循环动画；按分类设置或清除 |
| 附加效果 | `add_clip_effect`、`update_clip_effect`、`remove_clip_effect` | 视频/人物特效、滤镜、音频场景/音色/声音成曲；稳定 effect_id，参数输入 0..100 |
| 画面合成 | `set_clip_mask`、`set_clip_chroma`、`set_clip_mix_mode`、`set_clip_background`、`set_clip_crop` | 原生形状蒙版、色度抠图、混合模式、底层轨道背景填充、源画面矩形裁剪；null 清除 |
| 资源入轨 | `add_sticker_clip`、`add_effect_clip` | sticker/effect/filter 新轨道；贴纸、独立全局特效/滤镜片段，沿用移动、定长和移除工具 |
| 本地模板管理 | `import_local_template`、`list_templates`、`get_template`、`duplicate_template`、`inspect_template_resources` | 复制明文草稿到独立模板状态；回读稳定轨道/片段 ID、分页资源 |
| 模板编辑 | `replace_template_material_by_name`、`replace_template_segment`、`replace_template_text`、`import_template_track` | 同名换料、单片段换料、普通/多段模板文字、跨模板轨道复制；revision 与失败回滚 |
| 模板交付 | `save_template_draft` | 从模板状态生成不可变快照，继续用 export_video |
| 原生维护与外部导出 | `convert_local_draft`、`check_local_draft`、`export_local_draft` | 加解密、结构版本升降级、原生检查；外部草稿经快照后使用已有异步导出任务 |

已有工具同时扩展：`add_track` 增加 sticker/effect/filter；`set_text_style` 增加 underline/vertical/alpha/border_alpha/letter_spacing/line_spacing/auto_wrapping/max_line_width；`set_clip_audio` 支持视频原声淡入淡出；`set_keyframes` 增加 brightness/contrast/saturation/uniform_scale；`set_clip_duration` 支持贴纸和独立效果；`export_video` 增加 options。

### 高级功能契约

- mask.center_x/y 是源素材像素，size/rect_width 是比例；crop 是左上原点的 0..1 范围；transform 仍是中心原点。蒙版矩形宽度/圆角仅用于矩形，色度抠图颜色为 `#RRGGBBAA`，背景填充仅底层视频轨道生效。
- 资源目录是锁定 SDK 的快照，不是剪映全部在线资源。花字、气泡、贴纸通过模板取得 ID。缓存候选、VIP 标记、成功序列化或导出成功均不等于具体效果已经视觉/听觉确认。声音成曲可能依赖剪映后续处理，不能承诺无头引擎已完成生成。
- 组合动画与视频入出场动画互斥；每类音频效果最多一个。动画时长必须在片段内；分割前清除动画。uniform_scale 与 scale_x/scale_y 关键帧互斥。
- effect/filter 片段在其对应轨道上，附加的效果有独立 effect_id。修改使用 update_clip_effect 完整替换效果，移除独立效果片段使用 remove_clip。
- 模板输入是明文 `draft_content.json` 文件，所有引用的音视频文件也须在 mediaRoots 内。源文件不被修改，模板状态在 `templates/<template_id>.json`。普通 clip 工具不直接操作模板。按名称换料保留源区间并拒绝素材过短；按片段换料允许指定 shrink/extend，变速片段拒绝。跨模板导入保留 SDK ID，重复和冲突 ID 拒绝。
- 原生版本转换以 workspace 内的副本进行，返回新产物与回执；不会改写原草稿。加密输入需先解密才能导入模板。版本转换输出明文，必要时再独立 encrypt。
- export options 可覆盖 width/height/fps，并传入 hard_encode/quality/color_space/mp4；后几项是引擎数值，不预设枚举含义。已验证默认数值 0；其他数值依赖引擎版本，需独立验收。不把数值设置当成 HDR、色彩或硬件编码已生效。
- 外部模板导出无法从原始效果链可靠推断是否应有音轨，回执标记 audio_expectation，不宣称自动完成该部分验收。

## 时间与修改语义

工具入参时间统一为**秒**，结束点不包含。`get_project` 返回的原始计划字段以 `_us` 结尾，单位为整数微秒，读取后不要直接作为秒传回工具。

`start` 和 `split_clip.at` 是时间线绝对位置；`source_in` / `source_out` 是素材原始位置；添加视频和音频时的 `source_duration` 是变速之前的素材时长。时间线时长等于源区间时长除以 `speed`。关键帧的 `time` 相对片段起点。

`trim_clip`、`set_clip_speed` 和默认的 `remove_clip` 不自动推移后面的片段。`remove_clip(ripple=true)` 在同一事务中只平移同轨后续片段；其他闭合空隙需求继续用 `move_clip` 调整位置。同一轨道禁止重叠，跨轨道可以重叠；字幕有重叠时需要拆分到不同文本轨道。

视觉层按轨道列表排列，后面的视觉轨道位于前面轨道之上。画面位置以中心为原点，`x/y` 是归一化值，`+y` 向上；缩放是倍数，旋转是度。原生字体大小使用剪映单位，不是像素。

`set_clip_transform` 和 `set_text_style` 是增量 patch，省略字段保留原值。`set_clip_audio` 完整设置音量及两个淡入淡出值，省略时分别为 `1/0/0`。`set_keyframes` 替换一个属性的所有关键帧，传 `[]` 清除；`set_transition(name=null)` 清除出场转场。

每次成功编辑返回新的 `revision`。建议 Skill 在后续编辑传入上次返回的 `expected_revision`；服务发现冲突会拒绝写入。业务错误返回包含 `isError=true` 和 `error.code`；参数不满足工具 schema 时由 MCP SDK 返回标准校验错误。错误操作不会提交部分工程状态。添加、分割、导出等操作不是幂等请求，收到不确定结果时应先查询工程或任务，避免盲目重放。

## Skill 组合示例

以下是客户端的工具调用示意，不是另一套批量计划 API。`project_id`、`track_id`、`clip_id` 等使用前一步真实返回值，`expected_revision` 持续跟进。

### 口播加字幕与配乐

1. `get_capabilities` → `probe_media`，确认素材时长、音轨和画幅。
2. `extract_frame` 读取候选源时间点；实际观察返回图像后再选择镜头。
3. `create_project` → `add_track(video)`、`add_track(audio)`、`add_track(text)`。
4. `add_video_clip` 放置口播；通过 `trim_clip` / `split_clip` / `move_clip` 删除停顿并重新排列。
5. `import_subtitles` 添加已有 SRT，使用 `set_text_style` 和 `set_clip_transform` 调整字幕。服务不自动识别语音。
6. `add_audio_clip` 添加配乐，`set_clip_audio(volume=0.15, fade_in=0.5, fade_out=0.5)` 调整声音。
7. `get_project` 检查各轨道时长和位置 → `save_draft` → `export_video`。
8. `get_job` 查询终态；成功后查看产物并按需要调用 `validate_output`。语义、字幕是否挡脸和节奏仍要观察画面确认。

### 多镜头与画中画

为每个主镜头调用 `add_video_clip`，明确选择源区间并设置时间线 `start`；主轨片段不能重叠。需要画中画时，新建上层 video 轨道，把视频或图片放在相同时间范围，再使用 `set_clip_transform` 缩放和定位。

镜头相邻后，先 `list_transitions` 查找准确名称，再 `set_transition`。需要推近时用 `set_keyframes(property_name="scale_x", ...)` 与 `scale_y`；点位以片段相对时间表示。带关键帧、转场、淡入淡出或动画的片段需先清除这些设置才能分割，避免悄悄改变动画语义。

### 定点返修

先 `get_project` 找到片段 ID 和当前 revision，再调用相应修改工具；不要根据分页位置猜测片段数组下标。重新 `save_draft` 会得到新 `draft_id`，原有快照及导出结果保留，Skill 可以交付多个版本供比较。

## 导出状态与文件

任务状态为 `queued → running → succeeded / failed / cancelled`；worker 意外消失时为 `interrupted`。`stage` 区分排队、原生渲染和成片验证。同一 workspace 的 native 导出串行运行，避免多任务叠加 CLI 并发。

`cancel_job` 返回 `cancellation_requested` 只表示请求已记录，应继续查询终态。渲染期间会终止该任务的原生子进程；验证期间在提交产物前再次检查取消请求。未通过校验的临时 MP4 不作为成功产物发布。

任务记录持久化，但**不保证跨宿主关闭继续运行**：Windows MCP 客户端可能结束整个子进程树。遇到 `interrupted` 时保留原回执与日志，检查后用原 `draft_id` 重新提交导出，获得新的 `job_id`。当前没有安装系统服务、常驻 worker 或自动重试。

```text
workspace/
  projects/<project_id>.json
  drafts/<draft_id>/draft_content.json
  drafts/<draft_id>/draft_meta_info.json
  drafts/<draft_id>/manifest.json
  audio-cache/<source_hash>.wav
  frames/<id>.png
  jobs/<job_id>/job.json
  jobs/<job_id>/render.log
  jobs/<job_id>/worker.log
  jobs/<job_id>/output.mp4
```

快照仍引用本机素材绝对路径，不是可跨机迁移的素材包。保存和导出前会检查源素材哈希，导出提交产物前还会复查源文件及草稿内容。成功条件包括可解码性、时长、画幅、帧率、编码格式和预期音轨；不会把这些检查等同于审美或内容语义验收。

## 验证与当前边界

```powershell
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
uv run --no-sync ruff check src/jy_edit_mcp tests
uv run --no-sync pytest -q

# 使用已配置的本机剪映运行时，额外执行真实原生导出
$env:JY_EDIT_TEST_NATIVE = '1'
uv run --no-sync pytest -q
# 新增原生编辑实测：只创建新的合成工程及副本，保留验收目录，不改已有工程
$env:JY_EDIT_TEST_NATIVE_EDITS = '1'
uv run --no-sync pytest -q tests/test_native_edits_live.py
```

测试使用新建合成素材，覆盖真实 stdio 工具组合、持久化、版本冲突、越界、回滚、字幕、派生音频、草稿快照、取消、超时和 worker 中断检测。原生验收在 `build/mcp-acceptance-*` 保留 MP4、关键帧图片和 JSON 回执，不修改真实剪映草稿目录。

普通剪辑工具编辑服务创建的工程；外部本地草稿通过独立模板接口导入、换料、替换文字和复制轨道。资源类动画、字体花字、滤镜、特效、贴纸、音效和原生形状蒙版均已封装，资源存在和效果正确仍需逐项本机验证。尚未实现服务工程曲线变速、ASR、在线素材检索/下载、智能抠像、目标跟踪、光流补帧、AI 生成和云端发布；已有原生草稿曲线变速和同轨波纹删除见 0.4.0 扩展。项目帧率暂限整数 `24/25/30/50/60`；淡入淡出支持独立音频与视频原声。

本机原生导出通过后，仍应分别记录“剪映 UI 打开、手动保存、重开”验收。当前没有自动安装到剪映草稿根目录，也没有完成该 UI 验收。
