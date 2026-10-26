# 剪映窗口承载 POC

包含独立 Electron 44.7.0 宿主实验及 [实际 DeepSeek Harness 插件](harness-plugin/README.md)。独立实验不加载 Harness Profile；插件已安装到 DeepSeek Harness `desktop` Profile，增加原生剪映工作区入口。当前不提供 Agent 剪辑自动化。

## 运行

在仓库根目录执行：

```powershell
.\scripts\jianying-window-poc\build.cmd
node scripts\jianying-window-poc\run.cjs --inspect
node scripts\jianying-window-poc\run.cjs --panel
```

`--panel` 自动显示、缩小、恢复并脱离窗口，结果写入新的 `build/jianying-window-poc/<UTC-run>/report.json`。`02-visible-composite.png`、`03-visible-composite-resized.png` 是屏幕上 POC 窗口范围的截图；普通 Electron 窗口截图不含其 owned popup，不能单独作为原生面板显示证据。

需要人工观察和操作时：

```powershell
node scripts\jianying-window-poc\run.cjs --panel --interactive
```

点击“记录当前画面”保存 POC 范围内的前台截图，尚未由 Agent 审查的截图不代表某项编辑已经通过。点击“恢复剪映并结束”可脱离。自动模式租期五分钟，人工模式租期三十分钟，到期恢复窗口。人工修改的工程内容不会由此自动撤销；只使用独立测试草稿。当前只追踪进入 POC 时的主窗口，不自动接管新建工程弹出的其他窗口。需要精确选择已回读的窗口时增加 `--target-hwnd=<实际句柄>`。

默认使用本机 Harness checkout 的 Electron；其他机器设置 `POC_ELECTRON` 为已安装的 Electron 可执行文件绝对路径。启动器仅为测试子进程移除 `NODE_OPTIONS` 和 `ELECTRON_RUN_AS_NODE`，不修改全局环境。需要已有 MSVC x64 工具链。

## 两条模式与保护

- 不带 `--panel`：直接将剪映设为 Electron 子窗口。DPI context 不同则在改动窗口前拒绝，返回 `DPI_CONTEXT_MISMATCH`。
- `--panel`：先创建与剪映相同 DPI context 的原生顶层面板，该面板由 Electron 窗口拥有；剪映成为面板的子窗口。面板覆盖在 Electron 工作区上，**不是 Electron 的真正子视图**。
- 保存并恢复剪映的原父窗口、style、exStyle、位置与 WINDOWPLACEMENT；不发剪辑输入，不读写业务草稿。失败回滚、正常脱离、stdin EOF 和租期结束均有恢复路径。宿主被强制终止时的窗口生命周期尚未验收，不要以杀进程方式退出。
- 原生桥接只接受路径以 `JianyingPro.exe` 结尾的真实窗口；宿主默认要求恰好一个标题为“剪映专业版”的可见主窗口，避免猜测目标。
- 自动检查只改变宿主大小。人工模式同步宿主移动与大小变化；跨屏、Tab 切换、最小化与焦点变化仍待实际验收。

## 当前证据边界

2026-10-21 在剪映 10.6.0.14057 上检查了首页展示、150% 缩放下调整大小与原窗口恢复。随后用户在独立 POC 内打开测试工程并确认“播放正常”；截图显示真实预览、时间线和音轨。旧容器已正常释放并回读恢复成功。实际 DeepSeek Harness 插件已热加载，并收到客户端就绪回执；原生接入和 Harness 内播放仍待用户操作验证。尚未验证 11.6 编辑器窗口、时间线拖拽、中文输入、快捷键、弹窗、Agent 修改、保存重开。桌面操作通道仍不可用，当前由用户操作界面。

完整结论与原始回执索引见 [验证报告](../../docs/jianying-window-poc-2026-10-21.md)。

后续 0.2.0 已改为真正的右侧栏页签入口，并修复关闭重开后固定 HWND 失效的问题；包已安装，现有安装版升级需重启后生效。见 [右侧栏修复与验收状态](../../docs/jianying-harness-sidebar-2026-10-21.md)。
