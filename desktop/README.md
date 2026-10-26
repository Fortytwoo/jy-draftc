# Yoyoking Studio 桌面源码

底座是固定提交的 Cherry Studio；本仓库保留剪辑后端、原生工具和共享 Skill 的权威源码。`cherry-studio/` 是可重建的独立 checkout，`desktop/cherry-studio.patch` 保存派生应用的源码增量，`source-receipt.json` 保存补丁校验值。不是只保留一个无法复现的嵌套 Git 目录。

## 准备与运行

在当前仓库根目录执行，先准备 Node 24.12+、pnpm 12.6.0、uv 和 FFmpeg/ffprobe。Windows 原生 helper 的编译还需要 MSVC x64。

```powershell
node scripts/cherry-source.mjs prepare
./build.bat
./scripts/jianying-window-poc/build.cmd
node scripts/prepare-cherry-runtime.mjs
cd cherry-studio
pnpm install --frozen-lockfile
pnpm download:binaries
pnpm rebuild:electron
pnpm build:utility-process
pnpm dev:yoyoking
```

本机已有构建时，也可在仓库根目录运行 `scripts\start-yoyoking.cmd`。这是开发版启动入口，不会覆盖已安装的 Cherry Studio 或 Harness。

启动脚本把开发版 Profile 固定在 `%LOCALAPPDATA%\YoyokingStudioDev`；其中 `userData` 保存应用数据，`.yoyokingstudio` 保存基础配置。验收脚本另用独立 `CS_DEV_PROFILE_ROOT` 隔离测试数据。当前环境已存在的 Cherry Studio 和 DeepSeek Harness 配置不参与迁移。

打开“剪辑工作台”，在设置中填写允许素材目录和匹配版本的剪映运行时，再点击“准备剪辑环境”。剪辑 Agent 关联实际发现的 MCP 工具和 Skill，模型与密钥沿用底座的正常设置入口。抖音默认查找当前用户 Documents 下的 DouyinCreatorSDK，官方登录需要用户亲自完成；不复制已有登录态。

## 构建与检查

```powershell
pnpm build:yoyoking
cd ..
node scripts/cherry-package.mjs E:\CodexBuild\yoyoking-package
```

底座的 Windows 系统语音 helper 还需要 Visual Studio C++ ATL 组件；缺少该组件时打包会明确失败，不跳过 helper 生成不完整的安装包。当前机器尚未安装 ATL，且当前终端没有管理员权限。

仅 x64 是本轮目标。打包不表示完成原生剪映或抖音账号实机验收；未签名文件必须标为 `NotSigned`。不安装到现有桌面应用目录。运行时资源只来自准备脚本的白名单，并有 SHA-256 清单；不包含 `.env`、本地素材、工作区、账号状态或 SDK 凭据。

```powershell
# 隔离 Electron 的真实工具与合成素材检查；输出目录请设在有足够空间的位置
node scripts/cherry-smoke.mjs --edit --output=E:\CodexBuild\yoyoking-acceptance
# 修改桌面源码后，将增量同步回本仓库中的可复现补丁
node scripts/cherry-source.mjs snapshot
```

`--edit` 经过真实 MCP 创建与编辑、revision 冲突保护、快照、原生导出、成片解码、视频播放和鼠标拖动；失败会保留 `partial-receipts.json`。它不替代真实模型对话、用户原生工程保存重开或真实抖音账号验收。

许可与来源：底座保留 AGPL-3.0，`jy-draftc` 和已有 MIT 组件保留原声明；DouyinCreatorSDK 是用户提供的外部运行时。
