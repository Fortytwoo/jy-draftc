# yoyoking

`yoyoking` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的独立插件，注册同名预设、71 个剪辑 MCP 工具和 3 个剪辑 Skill。默认随 Harness 启动本机 DouyinCreatorSDK 登录服务，侧栏提供“抖音账号”入口；用户授权后增加 24 个抖音业务 MCP 工具和 1 个 Skill，另有 3 个连接控制工具。插件不修改 Harness 核心，也不向其他预设注入业务工具。

`0.7.1` 补齐安装版 Harness `0.2.1-rc.2` 的连接兼容：有宿主 `connect` 接口时沿用它，旧版则使用 MCP SDK 和 Harness 公开工具适配器连接，凭据仍只由 Host 的内存 fetch 持有。已通过源码环境 41 项测试，以及安装版 Electron/ASAR 引擎的 37 项非 UI 测试；4 项 React 渲染/点击测试在开发依赖环境验证。

`0.7.0` 将抖音服务改为 Host 托管：自动识别当前用户 `Documents/DouyinCreatorSDK`、分配本地端口并启动服务，不需要手动运行启动命令或填写 URL、端口、Cookie。侧栏直接发起登录，同一 Host、相同配置的 yoyoking 会话复用一次授权；关闭聊天不会停止服务，关闭 Host 才清理进程和内存登录态。退出连接会撤下这些会话的抖音工具，并重启托管服务以清除内存凭据。正常登录流程见[抖音账号登录](#抖音账号登录)。

`0.6.0` 首次接入 `douyin-creator-mcp 0.17.2`，当时需手动启用并启动服务；`0.7.0` 已替代这一步骤。OAuth 继续使用 MCP SDK 的 PKCE、state 和受保护资源发现，官方登录始终由用户确认。SDK 未安装、启动失败或尚未授权时不影响原剪辑功能。SDK 与剪辑后端使用独立 Python 环境，不打包 SDK 源码或账号状态。

`0.5.0` 升级后端到 `jy-edit-mcp 0.4.0`（71 工具），增加原生曲线变速、逐句字幕、同轨波纹删除、片段关联素材详情和操作回执查询。新增原生编辑均先复制，失败只留下未验收副本；普通 `remove_clip` 也支持原子同轨 ripple。未加入 ASR 或在线下载，未自动升级已安装的 Desktop。

`0.4.2` 增加 `prepare_native_copy`：剪映完全退出后，按成功分割回执校正副本身份、同步根草稿镜像及其首页条目，保留原始备份并明确报告元数据是否为明文。副本主时间线不变；UI 打开仍须实测。分割校验允许供应商最多 1 微秒舍入差，并保持首尾、连续性及总时长的严格检查。

`0.4.0` 接入原生草稿分割：`list_native_projects` → `get_native_draft` → `split_native_clip`，通过本机 lyra-cli 先复制后切分已有原生工程。原稿保留，副本放在剪映项目目录，回读验证时间线、素材和哈希；副本打开/首页登记仍单独报告。更新后的 yoyoking-edit 不再因模板没有 split 而拒绝原生草稿分割。lyraInstallDirectory 默认使用 jyInstallDirectory；nativeDraftRoot 可覆盖本机草稿根。依赖剪映自带 vebun.exe/lyra-cli.exe，不打包第三方二进制或登录态。

`0.3.0` 将 SDK 已有的字体花字、文字排版装饰、原生动画、画面/人物特效、滤镜及独立效果轨道、形状蒙版、色度抠图、混合模式、背景填充、精确裁剪、贴纸、音频效果、本地模板换料和草稿转换接入 MCP。资源目录按类别分页，回读参数和本地缓存线索；资源效果仍需本机缓存、权益与实际视听验收。三个 Skill 已更新组合方式和能力边界，完整契约见 [运行时说明](runtime/docs/jy-edit-mcp.md)。

`0.3.1` 增加回复内自动视频快速预览：最终回复里出现素材或成片的真实绝对路径（行内代码或 Markdown 链接，包括交付回执表格）时，回复下方直接显示默认展开的播放器。用户只需点击播放，无须要求助手“打开视频”，也不依赖额外的预览工具调用或展开工具过程。历史回复刷新后会恢复预览，每条回复最多显示三个不重复的视频；支持收起/展开、暂停、拖动进度、音量、全屏和失败重载，不自动播放。

原生工具 `yoyoking_preview_video` 保留，用于明确指定素材起播时间等操作，例如 `yoyoking_preview_video({path: "G:/视频素材/镜头.mp4", title: "镜头预览", start: 1.5})`。自动预览通过 Harness 的 `conversation.chat.turnTail` 正文扩展插槽实现，没有修改或替换 Harness 核心 Markdown 渲染器。

`0.3.2` 增加宿主侧的 `yoyoking-visualization` 注册，兼容安装版 Desktop 的预设服务隔离。当时使用 `visualizationOnly=true`，只提供媒体接口和客户端模块。`0.7.0` 保留该行 ID，改用 `hostServicesOnly=true`、`visualizationOnly=false`，在 Host 生命周期内同时管理媒体接口和抖音服务；仍不启动剪辑 MCP，也不向 Host 或其他预设注册业务工具与 Skill。安装 bundle 时应一并应用其 patch，不能只替换 JavaScript 文件；Host 行与 yoyoking 预设使用相同 workspace 配置。

`0.3.3` 修复素材目录移走后影响其他有效目录，以及多个配置中失效的 ffprobe 阻断可用配置的问题。Desktop 的 `dsh-app://` 转发层须保留未压缩音视频的 Content-Length 和 Content-Range，原生进度条才能跳转到尚未缓冲的位置；只有浏览器 HTTP 播放通过不能代表 Desktop 拖动验收通过。

视频使用 Harness 自带的客户端模块和 `tool.call.toolview` 插槽；媒体通过已有 Connection 认证通道分段传输，无须单独开启静态文件服务器。接口每次读取都校验真实路径，只允许 `mediaRoots` 和 `workspaceDirectory` 内的视频扩展名，支持中文路径和 HTTP Range。路径配置保持不变时可回放历史卡片；源文件必须仍存在。CLI/headless 没有 Connection 时不注册页面预览工具或侧栏，但仍提供剪辑工具及抖音连接控制，可通过 connect 返回的链接授权。

浏览器直接解码源文件，不进行预览转码；优先使用 H.264 / AAC MP4。MOV、WebM、MKV 等能否播放取决于浏览器和编码，失败时页面显示提示。页面播放供用户查看，模型仍通过 `extract_frame` 观察画面。源码修改和打包不自动替换或重启已经安装的 Desktop 插件。

```text
Harness Agent（选择 yoyoking 预设）
  ├─ skill → yoyoking-edit / yoyoking-montage / yoyoking-captions
  └─ mcp__yoyoking__* → Harness mcp-client → uv → jy-edit-mcp
                                                ├─ 工程与不可变草稿快照
                                                └─ jy-draftc → 本机匹配的剪映运行时 → MP4
```

## 功能与 Skill

| Skill | 组合能力 |
| --- | --- |
| `yoyoking-edit` | 素材观察、工程编辑、画面/声音调整、定点返修、草稿保存、任务导出与交付检查 |
| `yoyoking-montage` | 多镜头裁切重排、恒定变速、画中画、线性关键帧、转场 |
| `yoyoking-captions` | 已有 SRT 导入、可编辑字幕/标题、样式、位置和时间修订 |
| `yoyoking-douyin`（授权连接后加载） | 创作者指标、公开搜索/用户/评论、分页、Excel 导出、自有视频受控下载及后续剪辑 |

完整工具参数以 MCP 的 `tools/list` 为准；包内的 [工具 schema](runtime/docs/jy-edit-tools.json) 由服务生成。[后端说明](runtime/docs/jy-edit-mcp.md) 定义时间、revision、轨道层级、快照和异步任务语义。源码 checkout 先执行下方的 runtime 构建命令生成这两份随包文档。默认工具前缀是 `mcp__yoyoking__`，可通过 `serverName` 调整。

画面观察复用 Harness 的 MCP 图像附件处理：当前模型路由需要声明支持 image 输入，并有可用的 attachment store。文本模型会收到明确的图像不可用诊断；原始图片仍在工具结果和本机文件中，不应把抽帧成功等同于模型已经看过画面。

当前验证目标为 Windows x64、Harness `0.2.1-alpha.2`、Node.js 24、Python 3.12、FFmpeg/ffprobe 和剪映 `11.6.0.14552`。原生导出要求匹配的 `jy-draftc.exe` 与 `videoeditor.dll`；插件不分发剪映 DLL。未配置原生运行时时仍可编辑和生成草稿，通过能力探测报告导出缺项。ASR、任意既有剪映草稿重建为服务工程、服务工程曲线变速、自由绘制蒙版和云端发布尚未实现；原生工程已支持经过回读验证的速度曲线。

## 构建和开发

在本仓库准备 Python payload，源码只维护在 `src/jy_edit_mcp`，不要直接修改生成的 `runtime`。脚本会重建该生成目录，复制锁定依赖、后端源码和文档；`--native` 可选，只允许传入自己构建的 CLI，不复制 `.env`、素材或剪映 DLL。`runtime/manifest.json` 保存逐文件 SHA-256。

```powershell
cd G:\project\jy-draftc\yoyoking
node scripts/prepare-runtime.mjs --native=G:\project\jy-draftc\build\jy-draftc.exe
node scripts/link-harness.mjs C:\Users\fortytwo\Documents\deepseek-harness
node --test tests/*.test.mjs
npm pack
```

开发链接脚本只在插件自己的 `node_modules` 下连接已有 Harness 包，核对 peer 版本，拒绝替换已有不同路径。它不修改 Harness checkout 或 Profile。Node peer 依赖使用目标 Harness 自带版本；Python 依赖使用 `uv.lock`，首次运行需要 uv 下载或使用已有缓存。Python 环境放在配置的 workspace 下，插件包目录不存放项目状态。

## 安装到 Harness

优先在 Harness 的 `plugin_manager` 中执行 `install_bundle`，target 指向插件目录或构建后的 `.tgz`。当前预设依赖 Web/Desktop Profile 提供的 Agent preset registry。安装后新建会话，选择 `yoyoking`；已有会话继续使用其原预设。

没有提供 `plugin_manager` 的命令行环境可用官方 CLI。先设置本次 Host 启动使用的素材和运行时配置，再安装到指定 Profile；以下使用独立 Profile，不替换正在使用的 Desktop。

```powershell
$env:YOYOKING_WORKSPACE = 'D:\yoyoking-workspace'
$env:YOYOKING_MEDIA_ROOTS = '["D:/视频素材","D:/配乐"]'
$env:YOYOKING_JY_INSTALL_DIR = 'C:\Users\YOUR_USER\AppData\Local\JianyingPro\Apps\11.6.0.14552'
dsh --profile editing --from-default-profile web --dump-config
dsh plugin --profile editing add G:\project\jy-draftc\yoyoking --config.auto-install-peers=false
dsh --profile editing --no-open
```

初始化命令只用于新的 Profile。源码开发可在 Harness 根目录将 `dsh` 替换为 `node --import tsx/esm apps/cli/src/bin.ts`。本地目录安装是链接；迁移或交付使用打包文件。首次安装可通过 HMR 加载；替换已加载的插件代码后，应在合适时机重启该 Host，并在新会话验证。这里的安装示例不自动重启用户现有应用。

## 配置

插件 Config schema 在 Harness 中可查询，以下配置位于 `preset-yoyoking` 的 `plugins/yoyoking` 行。

| 字段 | 默认值与用途 |
| --- | --- |
| `workspaceDirectory` | 必须为绝对路径；patch 默认读取 `YOYOKING_WORKSPACE`，否则用 Profile 的 `yoyoking-data` |
| `mediaRoots` | 非空的现存绝对目录列表；patch 从 `YOYOKING_MEDIA_ROOTS` JSON 读取，否则使用 Host 启动目录 |
| `serverName` | `yoyoking`，同一作用域内应唯一；系统提示同步工具前缀 |
| `uvCommand` / `pythonVersion` | `uv` / `3.12` |
| `runtimeDirectory` | 默认使用包内 Python project；开发时可指定绝对目录 |
| `nativeExecutable` | 默认包内 `runtime/native/jy-draftc.exe`；patch 可从 `YOYOKING_NATIVE_EXE` 覆盖 |
| `jyInstallDirectory` | 匹配的剪映版本目录；patch 读取 `YOYOKING_JY_INSTALL_DIR` |
| `ffmpeg` / `ffprobe` | PATH 中的同名命令，可设为绝对路径 |
| `toolCallTimeoutMs` | 180000，单次 MCP 调用超时；渲染本身通过任务查询完成 |
| `douyinEnabled` | `true`；默认自动启动，只有显式关闭或 `YOYOKING_DOUYIN_ENABLED=0` 时禁用 |
| `douyinSdkDirectory` | 空值自动使用当前用户 `Documents/DouyinCreatorSDK`；仅迁移 SDK 目录时需要绝对路径覆盖 |
| `douyinServerUrl` | 空值表示自动托管、自动分配端口；非空值是外部服务高级覆盖，只接受 `http://127.0.0.1:PORT/mcp` |
| `douyinServerName` | `yoyoking_douyin`，必须与剪辑命名空间不同；patch 读取 `YOYOKING_DOUYIN_NAMESPACE` |
| `douyinToolCallTimeoutMs` | 300000；可配置 1000–1800000 毫秒。全账号 Excel 导出可能更久，超时后不要直接重复提交 |
| `hostServicesOnly` | `false`；安装 patch 的 Host 行设为 `true`，保留媒体接口与抖音服务但不注册 Agent 工具 |
| `visualizationOnly` | `false`；显式设为 `true` 时仅提供媒体功能，不启动抖音服务 |

修改环境变量需要在启动 Host 前完成。需要跨启动保持配置时，在 Harness 配置界面保存对应插件行的字段；环境变量示例只影响继承它们的进程。素材路径按真实路径检查；workspace 保存工程 JSON、缓存、快照、任务回执和成片。不要把 workspace 设到插件安装目录。

## 抖音账号登录

正常使用不需要填写抖音连接参数，也不需要另开终端启动 MCP 服务。安装 `0.7.1` bundle 后：

1. **启动 Harness**。插件自动找到当前用户的 `Documents/DouyinCreatorSDK`；本机对应
   `C:\Users\fortytwo\Documents\DouyinCreatorSDK`。在任何聊天创建前，Host 就会准备独立环境并启动服务。
2. **在侧栏底部展开“抖音账号”，点击“登录抖音”**。窄侧栏显示“抖”入口；准备期间会显示启动状态。
3. **点击“打开官方登录”**。浏览器打开 SDK 的本地授权页，按其提供的方式在官方窗口完成登录或扫码确认。
   不在聊天、插件设置或工具参数中输入 Cookie、Web-ID、验证码或 token。
4. **返回 Harness**。侧栏自动更新登录状态；当前和后来打开的 yoyoking 会话会挂载 24 个抖音工具及工作流 Skill。
   无须为每个聊天重复登录。

### 服务和登录生命周期

- 服务只监听 `127.0.0.1`，由操作系统分配端口。插件从自己启动的子进程接收就绪信息，不会扫描或接管已有服务。
- Python 环境位于 `<workspace>/.douyin-python-env`，下载位于 `<workspace>/douyin-downloads`。
  使用 SDK 自己的 `uv.lock`；首次启动可能下载依赖，后续可复用环境与缓存。
- 同一 Host、相同 workspace / SDK / 启动配置共享一个服务和一次登录。关闭聊天只移除其工具，不停止 Host 的服务。
  不同 Host 不共享 token；手动创建的不同启动配置也不会合并账号状态。
- 关闭 Harness 或卸载最后一个服务所有者时，插件关闭回调和子进程。SDK 凭据及 OAuth token 只保存在内存，
  下次启动需重新登录；不读取 SDK 旧 vault、`.env`、浏览器 profile 或账号状态文件。
- 点击“退出连接”会清除这个共享账号状态、撤下所有关联 yoyoking 会话的抖音工具和 Skill，
  并重启托管服务以清除其内存凭据。服务随后保持待登录，不影响剪辑；这不等于注销官方账号。
- 子进程意外退出会清除本次登录，最多自动重启 3 次；恢复后仍需用户重新确认登录。
  找不到 SDK、缺少 `uv` 或启动失败会显示失败状态，可点击重新连接；不阻断原剪辑工具。
- 仅启动服务和查询状态不会访问真实抖音业务接口。插件不自动打开授权页，不代点确认，也不处理验证码。

### 会话内控制工具

没有侧栏的 CLI/headless 环境也可使用以下默认工具；名称随命名空间配置变化：

- `yoyoking_douyin_connect()`：发起登录或重试当前会话的工具连接。尚未授权时返回 `authorization_url`，
  由用户打开并确认；已在侧栏或其他 yoyoking 会话完成授权时复用该登录。
- `yoyoking_douyin_status()`：查看服务状态、当前会话的 MCP 状态、实际工具名称和数量。
  只有当前会话为 `connected` 且发现业务工具后才可调用。
- `yoyoking_douyin_disconnect()`：与侧栏“退出连接”相同，影响所有关联会话，而不只是发起调用的聊天。

授权等待最多 5 分钟，重复 connect 复用当前链接。授权码、PKCE verifier 和 token 不写入配置、日志、工具结果或包。
业务请求遇到 401 时合并并发刷新，限制刷新及重放次数；失败后要求显式重新授权，不自动开启浏览器。
若平台业务返回会话过期，而 MCP 状态仍为 `connected`，先退出连接再登录；`connected` 只表示本地 OAuth/MCP 状态，
不保证平台会话仍有效。没有后台业务重试或批量采集任务。

授权前默认是 **71 个剪辑工具 + 3 个连接控制工具**，有 3 个剪辑 Skill；成功后是
**95 个业务 MCP 工具 + 3 个控制工具**，共 4 个 Skill（页面预览原生工具另计）。
抖音命名空间默认 `mcp__yoyoking_douyin__`。Harness 会给超过 64 字符的名称截短加哈希，
例如受众偏好工具；以 status 的 `tool_names` 和实时 schema 为准，不手拼长名称。

### 能力和边界

- 9 个 Creator 工具：自有作品列表、Excel 导出、自有视频下载、趋势、诊断、播放来源、搜索词、受众画像和偏好。
- 15 个 Web 工具：用户资料/作品、相关推荐、主页内搜索、合集、关键词建议、公开喜欢/关注/粉丝、作品详情、内容/用户/直播搜索、评论和回复。
- 没有上传、发布、删除、点赞、关注或发评论功能。没有把 ASR 加入剪辑后端。
- 分页、调用间隔、部分结果和受控下载见 [yoyoking-douyin Skill](douyin/skills/yoyoking-douyin/SKILL.md)。工具的限页与节流沿用 SDK，跨工具调用仍需按 Skill 串行并间隔至少 5 秒。
- 下载结果要交给剪辑时，把已创建的 `<workspace>/douyin-downloads` 加入 `mediaRoots`，不要授权整个磁盘。预览允许 workspace 内的视频，但素材导入仍按自己的白名单检查。
- 工具注册保持 Agent 作用域隔离：共享的是登录，不是工具作用域。Host 本身不获得这些业务工具；一个聊天的工具发现失败不撤销其他聊天的登录。
- SDK 保留在用户指定的位置，不复制 `secrets`、`logs`、`.venv`、vault、密钥或账号下载文件。包内只有自写托管/连接代码、公开 schema 和工作流说明。SDK 没有明确的许可证声明，本插件的 MIT 许可证不替代 SDK 的许可。
- 新版 Harness 使用 `mcp-client` 的 `connect(ctx, config, {fetch, isCurrent})` 接口；`0.2.1-rc.2` 安装版缺少该接口时，通过包内 SDK 连接兼容层和公开 `createMcpToolDefinition` 注册工具，不修改 Harness。侧栏依赖 `sidebar.footer.action` 插槽；源码 `0.2.1-alpha.2` 和本机安装版 `0.2.1-rc.2` 均已通过对应引擎测试。

### 高级覆盖：外部服务或自定义目录

这不是正常登录的前置步骤。SDK 放在其他位置时，可在 Host 行与 yoyoking 预设中设置一致的绝对路径
`douyinSdkDirectory`。不需要抖音功能时设 `douyinEnabled: false`，或在 Host 启动前设置
`YOYOKING_DOUYIN_ENABLED=0`。

只有自行管理服务时才填写 `douyinServerUrl`，或设置 `YOYOKING_DOUYIN_URL`；非空 URL 会禁用插件的进程托管。
可保留手动启动器用于诊断或独立运行：

```powershell
npm --prefix G:\project\jy-draftc\yoyoking run douyin:start -- `
  "C:\Users\fortytwo\Documents\DouyinCreatorSDK" "D:\yoyoking-workspace"
```

手动启动器默认监听 `127.0.0.1:8014`，最后可附加自定义端口。外部模式下插件不负责启动、关闭、重启或清除服务端 vault；
退出连接仅清除插件持有的登录。需要 SDK 自身的加密 vault 模式时，按 SDK 文档单独管理，不在插件配置中放入 Cookie 或密钥。

### 本地验证和 schema 更新

```powershell
# 合成 OAuth/MCP、Host 生命周期与侧栏渲染/点击测试，不访问真实抖音账号
npm --prefix yoyoking test
# 可选：实际本机 SDK 自动启动、Host 登录 API、OAuth 元数据/注册和停止；不完成账号登录
$env:YOYOKING_TEST_DOUYIN_SDK = 'C:\Users\fortytwo\Documents\DouyinCreatorSDK'
node --test yoyoking/tests/douyin-sdk.test.mjs
# 从 SDK 内存 MCP 服务核验公开 schema；不读凭据、不请求业务接口
uv run --offline --no-sync --project C:\Users\fortytwo\Documents\DouyinCreatorSDK `
  python -B scripts/export_douyin_tools.py yoyoking/douyin/tools.json --check
```

验证覆盖自动分配端口、聊天关闭后服务仍在、Host 释放后进程停止、共享登录/退出、崩溃恢复、
OAuth state/PKCE/resource/刷新、回调超时、真实 Harness 的 24 工具发现、作用域隔离、失败重试和 `partial` 结果保留。
侧栏使用 Harness 的 React 做渲染与点击处理测试，不等于实际 Desktop 窗口的视觉验收。
设置 `YOYOKING_TEST_PLUGIN_ROOT` 为解包后的插件根目录，可让 `harness.test.mjs`、`douyin.test.mjs`
和 `douyin-sdk.test.mjs` 直接加载包内代码，而不是源码；需按包的依赖声明提供 Node peer 和 MCP client。
真实账号数据、官方扫码登录、下载和 Excel 内容仍需用户确认登录后验收，
不能把合成响应或 OAuth 元数据检查当作真实账号操作成功。

## 验证

```powershell
# 在本仓库，从官方 dsh Profile 启动，创建合成素材并完成真实原生导出
./scripts/acceptance.ps1 -HarnessCheckout C:\Users\fortytwo\Documents\deepseek-harness `
  -JyInstallDirectory C:\Users\fortytwo\AppData\Local\JianyingPro\Apps\11.6.0.14552
```

脚本使用新的 `DSH_HOME` 和 Profile，禁用该验收进程的其他预设，安装本插件，验证作用域、工具发现、Skill 加载与持久化目录、revision、字幕、配乐、原生导出和源文件不变。测试插件通过 Harness 原生 registry 调用工具，不发送模型请求。`build/yoyoking-profile-*` 保留配置、实际工具回执、Skill 目录消息、Session 事件、MP4、抽帧和 JSON 验收结果。脚本退出后恢复其修改的进程环境变量，不操作用户 Desktop Profile。

通过 `-PackagePath ./local-dsh-yoyoking-0.3.1.tgz` 可验收实际打包文件；`-UseProfileWorkspace` 验证未设置 workspace 环境变量时的默认 Profile 存储目录。

导出通过后仍需分别记录成片观察与剪映 UI 打开/保存/重开状态。Windows Host 退出可能结束整个子进程树，持久化任务回执不保证后台渲染跨 Host 退出继续运行；遇到 `interrupted`，检查原任务后从同一快照提交新任务。插件清理通过 Cordis effect 与子插件生命周期完成；MCP 发现失败时插件激活失败，不发布看似可用的 Skill。原生输出失败保留日志，不将临时文件当作成片交付。
