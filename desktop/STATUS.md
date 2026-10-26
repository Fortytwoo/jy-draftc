# Yoyoking Studio 实施状态

更新：2026-10-26。用户已确认完整范围，并明确批准当前 Spec 进入实现。Spec 保持 `proposed`，直到全部真实验收标准有证据。

## 已实现

- 固定 Cherry Studio `2.1.8` / `de8d659dbe23753fe62e86330483c10c88007566` 为底座；保留原仓库未提交内容。
- 独立应用名称、appId、NSIS GUID、协议、基础配置和用户数据目录；关闭上游更新检查与安装，默认关闭上游数据采集。
- 剪辑工作台入口、设置、工程检查、视频播放器、剪映页签、账号页签，以及剪辑 Agent 会话中的工作台面板。
- 复用现有 MCP runtime、Agent、SkillService、IpcApi、Preference 和生命周期管理；71 个剪辑工具、3 个剪辑 Skill，另有 5 个宿主 MCP 工具。
- 带清单和哈希检查的 Python/原生 helper/Skill 资源准备；基于固定上游及源码补丁的可复现 checkout。
- 受窗口来源和真实路径授权约束的文件流视频协议，支持 GET/HEAD、Range、撤销、播放器播放与拖动。
- Windows 原生窗口精确选择、接入、视口同步、同进程首页/编辑器切换、页签隔离、失联隐藏、恢复与当前工程稳定快照读取。
- 应用内抖音 SDK 托管、官方登录、内存授权、账号共享、认证传输注入、工具关联和退出清理；不复制 SDK 凭据或旧登录态。

## 已验证

| 检查 | 当前证据 |
| --- | --- |
| 底座实际启动 | 隔离 Electron 窗口显示工作台，标题 `Yoyoking Studio`，原应用 Profile 未参与 |
| MCP/Skill/Agent | 实际发现 71 个工具，安装并关联 3 个剪辑 Skill，SQLite 回读剪辑 Agent 与 MCP 关联；尚未向模型发送真实请求 |
| 合成音视频剪辑 | 工程创建、轨道、素材入轨、revision 冲突保护、快照、原生导出、任务终态和源哈希检查通过 |
| 成片 | H.264/AAC，320×180、30 fps、约 3.018 秒；完整解码通过 |
| 播放器 | 在真实 Electron 中用鼠标点击播放、拖动到约 2 秒，回读播放时间、时长与尺寸 |
| 新宿主窗口适配 | 精确指定独立 Win32 fixture 的 HWND，接入实际 Electron 窗口，回读父窗口；其他页签的 detach 被拒绝；正常恢复通过 |
| 原生 helper | 真实 Win32 焦点/文本输入归属/布局/隐藏/恢复回归通过；工程读取与选择 8 项测试通过 |
| 账号服务 | 实际本机 SDK 托管启动至 running，OAuth 元数据回读通过；未进行用户账号授权 |
| 单元与消费方回归 | 主进程 83 项、renderer 导航 41 项通过 |
| 类型、构建与规范 | 已完成主进程与 renderer 类型检查、Electron main/preload/renderer 和 utility-process 构建；最终改动后需以最终检查回执为准 |

最终整体验证位于 `E:\CodexBuild\jy-draftc-cherry\acceptance-release-check`，在同一个真实 Electron 实例中完成了 Win32 fixture、SDK 服务、71 个剪辑工具与 5 个宿主 MCP 工具发现、音视频编辑/原生导出/解码、播放器鼠标播放与拖动。该次 renderer 错误回读为空，退出后已核验 SDK 端口不再监听。源码补丁校验与检查状态见 `validation.json`。这些是独立测试数据，不是用户真实剪映工程或抖音账号的验收结果。

整体验证发现并修复了结果 JSON 区域遮挡工作台按钮的布局问题；最终播放器截图已实际检查。主进程与 renderer 类型检查、开发版构建、124 项主进程/导航测试、翻译与 Spec 文档检查通过。ESLint 无错误，AgentRightPane 的两条既有 hooks 警告保留。

## 未完成与已知问题

- 真实模型对话和实际会话内 Skill 执行，仍需在新应用配置可用模型与凭据。已验证的是实际工具发现、Skill 安装/关联和数据库回读。
- 真实剪映草稿的打开、中文输入、播放、保存重开与跨屏/弹窗仍待实机验收。Win32 fixture 不替代这些标准。
- 抖音官方授权、真实账号有界读取、下载和 Excel 内容回读尚未验收，需要用户完成官方登录。
- 单视频轨、无独立音轨的合成草稿在现有原生引擎 `ProjectService::init` 处出现 `0xC0000005`；独立 CLI 和重新编译均可复现。含音轨的样例与旧成功样例导出通过。保留失败回执，未添加隐式音轨或换用其他渲染器掩盖问题。
- Windows 发行包被本机缺少 C++ ATL 组件阻塞，组件 ID 为 `Microsoft.VisualStudio.Component.VC.ATL`。当前终端不是管理员；没有跳过语音 helper、安装覆盖原应用、签名或发布安装包。已有构建可用开发版启动脚本运行。

## 复验入口

```powershell
node scripts/cherry-source.mjs prepare
node scripts/prepare-cherry-runtime.mjs
scripts\start-yoyoking.cmd
node scripts/cherry-smoke.mjs --edit --output=E:\CodexBuild\yoyoking-edit-check
node scripts/cherry-smoke.mjs --native --host --output=E:\CodexBuild\yoyoking-host-check
```

源码增量进入父仓库前执行 `node scripts/cherry-source.mjs snapshot`，并在干净的固定上游 checkout 上验证补丁。运行时资源不收录账号、素材、缓存或 Python 虚拟环境。
