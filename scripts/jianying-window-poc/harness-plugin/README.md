# DeepSeek Harness 右侧剪映工作区 POC

`@local/dsh-jianying-window-poc` 0.4.1 注册实际 Harness 的 `sidebarRightTabs` 和 `sidebar.right.pane.tab`，在原右侧“开始”页增加“剪映”，与文件、终端、浏览器并列。安装目标仅为 DeepSeek Harness 的 `desktop` Profile。

0.4.1 跟随 Timelines/project.json 读取有效主时间线，避免分割后仍回读根目录旧镜像；提供 native_ref 供 yoyoking 0.4.0 的 get_native_draft/split_native_clip 使用。多时间线无法明确选择时拒绝猜测。副本分割不代表当前 UI 已切换工程。

打开右侧“开始”页，选择“剪映”。发现唯一可用剪映主窗口时自动接入；未运行时点击“启动剪映”，也可自行启动。每次连接扫描当前窗口，不使用固定 HWND；应用关闭后显示等待，重新打开则自动识别新 PID/HWND。多个主窗口需要明确选择。当前设置启动 10.6.0.14057，不切换用户版本。

启动时若进程仍在但主窗口隐藏，优先恢复上次已接管且当前原生清单中仍匹配 PID/HWND 的窗口；只有一个隐藏主窗口时可直接恢复，多个且没有有效历史选择时由用户选择。历史句柄仅作为已验证窗口的偏好，绝不代替新清单扫描。显示窗口只发生在用户点击启动或明确选择窗口后，不因后台扫描任意唤醒工程。

首页进入编辑器或返回首页时，每 750ms 扫描当前授权进程的主窗口，自动脱离已隐藏窗口并接管替代窗口。不会切到其他剪映进程。接管时保留已隐藏首页的状态，避免恢复时重新弹出首页。原生线程每 50ms 使用最近的页签范围跟随宿主移动、尺寸和最小化，不依赖 Chromium 后台计时器。只在布局变化时调整原生窗口，避免每次心跳都重建窗口边框。

切换页签或会话时同时隐藏主面板及其 Qt 工具窗口，切回来恢复并请求重绘。普通应用失焦不隐藏画布，也不持续抬高 popup 的层级；外部 Qt 选框裁剪到页签视口内。客户端失联超过 120 秒先暂停，恢复心跳后继续；宿主消失或三十分钟租约到期则恢复原窗口。“恢复为独立窗口”或关闭页签也会恢复。窗口恢复不撤销工程修改，也不自动保存工程。

恢复结果 `ok` 验证原父窗口及宿主修改的窗口样式位；`exactStyle` 另行记录完整 style/exStyle 是否一致。Qt 可能动态更改渲染样式，完整样式差异不再误报为父窗口恢复失败。原生面板仍是实际 Harness 拥有的 popup，不是 Chromium 子视图。真实剪映 GPU 失焦恢复、跨屏、弹窗及强制退出仍需实机验收。

配置中的 `helper` 指向插件包内的原生程序，`jianyingExecutable` 为本机剪映路径。包从 staging 目录打包，包含编译后的 `runtime/window-host.exe`；不要直接打包缺少 runtime 的源目录。Evidence 写入 `build/jianying-harness-poc`。

0.3.2 在原生承载面板获得焦点或收到剪映区域点击时，将键盘焦点交给剪映，并保留有效的原生文本框焦点；Qt 选框工具窗口不能作为恢复键盘的目标。布局、心跳和普通切回应用不会主动抢回键盘。状态栏显示前台实际焦点属于剪映、Harness 还是其他应用；“聚焦剪映”仅在当前授权页签、面板可见且 Harness 位于前台时申请焦点，等待原生回执确认。记录仅含 HWND 和焦点归属，不记录按键或输入内容。快捷键仍由剪映处理；实际剪映的空格、组合键、中文输入和弹窗需人工复测。

0.4.0 增加原生 Agent 工具 `jianying_get_current_project`（不加 MCP 前缀）与“读取项目”按钮。读取前验证接入的 PID/HWND 仍属于当前承载面板，再用 Restart Manager 查询 `.locked` 的实际进程持有者，唯一匹配后读取工程。读取路径遵守剪映 `Config/globalSetting` 的 `currentCustomDraftPath`；也可显式设置 `currentProject.draftRoots`。不会按修改时间猜测工程。

工具返回工程名称/ID、草稿目录、轨道、分页片段和媒体库素材、原始文件绝对路径与存在状态、保存时间和哈希证据。`clip_offset`、`material_offset` 默认 0，`limit` 为 1..200；时间字段以 `_us` 表示微秒。加密草稿先复制到配置的 snapshotDirectory，再使用已配置的转换器解密副本；结束时复查绑定、锁持有者和原始文件哈希。没有保存、改写或导出原工程。多工程锁、没有工程锁、窗口切换、并发自动保存均明确返回失败。

这是“当前原生工程最近保存的磁盘快照”，不是内存实时状态，不提供未保存修改、播放头或选中片段。其 draft_id 不能作为服务 project_id 调用 get_project/split_clip；模板编辑需要导入副本，现有 MCP 的媒体目录限制继续生效。工具不自动扩大素材白名单或执行剪辑。

本地检查：编译原生程序，执行 `node --test selection.test.mjs client.test.mjs`、`node smoke.mjs` 和 `node --experimental-test-module-mocks --test bridge.test.mjs`。原生回归从仓库根执行 `scripts/jianying-window-poc/build-fixture.cmd` 后运行 `node --test scripts/jianying-window-poc/native.test.cjs`；使用独立测试进程中的屏幕外窗口，不加载真实剪映工程。测试通过不代替实际 Harness 的播放、Agent 剪辑和保存重开验收。

0.2.1 加入等待秒数、接入耗时、十秒请求超时、三十秒未发现主窗口提示、渲染异常后的错误详情和重试。前后台版本不同会显示完全退出应用的提示；安装版升级须使用“应用 → 退出”后重开，仅关闭窗口不等于后台退出。协议 fixture 使用 `node --experimental-test-module-mocks --test bridge.test.mjs`。
