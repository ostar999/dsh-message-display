# dsh-message-navigator

DeepSeek Harness（DSH）Web GUI 的**消息导航插件**：在页面右侧边缘放一个半透明胶囊按钮，悬停展开消息队列面板，点击任意消息即可平滑滚动定位并高亮闪烁。

结构参考社区插件仓库（如 [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui)、[dsh-ads](https://github.com/Nagi-ovo/dsh-ads)）：一个带 `dsh.bundle` 补丁声明的 npm 包，通过官方 `dsh plugin` 命令挂到 `web` profile，不改 DSH 源码。

## 功能特性

- **默认收起**：页面右侧边缘一个 44×152px 的半透明胶囊按钮（三横线图标），几乎不遮挡内容。
- **悬停展开 / 移出收起**：鼠标移入按钮区域自动展开消息队列面板；移出面板与按钮区域自动收起（`Esc` 也可关闭；按钮支持键盘 Enter / 空格切换）。
- **消息队列只含“我 / AI”**：只列出用户输入与每轮 AI 回复的**最终输出**——同一轮次多步 AI 自动去重，thinking（思维链）与工具调用不进入列表，每条约 44 字摘要。
- **「我 / AI」过滤开关**：面板头部两个胶囊开关（我=蓝点、AI=绿点），可分别显示/隐藏两类消息。
- **从上到下时间正序**：旧消息在上、新消息在下；打开面板自动定位到当前浏览位置。
- **浏览位置自动跟踪**：滚动主聊天区时，面板实时高亮当前视口顶部对应的消息，并把列表滚到该条目。
- **点击定位 + 高亮闪烁**：点击任意摘要，主聊天窗口平滑滚动到该消息并闪烁约 1.5 秒琥珀色高亮。
- **自动加载更早历史**：打开面板自动加载一页「加载更早」之前的历史（从 Host 会话日志读取）；把面板列表滚到顶部继续自动加载，直到全部历史加载完；历史条目变暗区分。点击历史消息时，若其尚未渲染进聊天流，会自动触发聊天流翻页直至目标出现再定位。
- **失败可见**：历史加载失败会在面板内显示红色原因并支持点击重试，不会静默吞掉。

## 目录结构

```
dsh-message-navigator/
├── package.json        # exports 与 dsh 清单：bundle 补丁 + 客户端入口
├── cordis.patch.yml    # 插入到 web profile 的插件行（- insert）
├── src/
│   ├── index.js        # Host 半边：/dsh-message-navigator/fetch-history 路由 + 会话日志读取
│   └── client.js       # 浏览器半边：消息导航 UI（window.__ModuleLoader__ 工厂形式）
├── lib/                # 构建产物（已提交，安装无需构建）
│   ├── index.js
│   └── client.js
├── scripts/build.mjs   # “构建”= 把 src 拷贝到 lib（纯 JS，无打包器）
├── LICENSE             # MIT
└── README.md
```

## 环境要求

- 已安装 DeepSeek Harness，且 `dsh web` 可用；
- `pnpm` 在 PATH 上（`dsh plugin` 内部转发给 pnpm 管理 profile 依赖）。

## 安装

### 方式一：从 GitHub 安装（推荐）

```sh
dsh plugin --profile web add github:ostar999/dsh-message-display
```

`dsh plugin` 会在 `$DSH_HOME/profiles/web` 里用 pnpm 安装该仓库（安装后按包名 `dsh-message-navigator` 落库），并把本包（声明了 `dsh.bundle.patch`）自动加入该 profile 的 `dsh.profile.bundles` 层级列表。

> 本仓库的 `lib/` 构建产物已提交，**安装不需要任何构建步骤**。
>
> pnpm ≥ 10 默认阻止 git 依赖的 prepare（构建）脚本；若 pnpm 提示需要 allowlist，按提示把对应 key 加入 `$DSH_HOME/profiles/web/pnpm-workspace.yaml` 的 `allowBuilds`，再重跑一次。

### 方式二：本地目录安装（开发 / 修改源码时）

克隆仓库后，在仓库根目录执行：

```sh
git clone https://github.com/ostar999/dsh-message-display.git
cd dsh-message-display
dsh plugin --profile web add .
```

`dsh plugin` 会在 `$DSH_HOME/profiles/web` 里运行 `pnpm add <绝对路径>`（本地目录链接），改完 `src/` 后执行 `pnpm run build` 并重启 `dsh web` 即可看到改动。

### 验证安装

```sh
dsh --profile web --dump-config
```

输出中应能看到 `dsh-message-navigator` 这一行（同时会挂载 Host 半边与浏览器半边）。

### 生效

如果 `dsh web` 正在运行，**重启它**（插件集合变更在重启后生效），然后刷新浏览器页面。此时页面右侧边缘会出现半透明胶囊按钮，移入即可看到消息队列面板。

## 卸载

### 常规卸载

```sh
dsh plugin --profile web remove dsh-message-navigator
```

`dsh plugin` 会在 profile 里执行 `pnpm remove`，并把本包从 `dsh.profile.bundles` 层级列表中清理掉。**重启 `dsh web` 并刷新页面**后按钮消失。

### 手动卸载（兜底）

编辑 `$DSH_HOME/profiles/web/package.json`：

- 删除 `dependencies` 里的 `"dsh-message-navigator"`；
- 删除 `dsh.profile.bundles` 数组里的 `"dsh-message-navigator"`。

如果曾在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里手动写过相关 `insert`，也一并删除。然后重启 `dsh web`。

### 临时禁用（保留安装）

在 `$DSH_HOME/profiles/web/cordis.patch.yml`（profile 自己的补丁层，最后应用）里加：

```yaml
- disable:
    id: dsh-message-navigator
```

重启后本插件不挂载；删除这几行即可恢复。

## 开发

两个半边都是纯 JavaScript，无构建链依赖：

- `src/index.js` — Host 半边。通过 `webServer` 注册同源路由 `/dsh-message-navigator/fetch-history`，用 `sessionQuery.readSession()` 读取会话日志，返回「边界之前」的用户输入与每轮 AI 最终输出（JSON）。
- `src/client.js` — 浏览器半边。以 `window.__ModuleLoader__.load({ id, factory })` 的懒加载 CJS 形式提供，`require('react')` 使用 shell 共享的 React；样式注入的 `<style>` 标签由模块系统认领，卸载时自动清理。UI 注册在 `shell.overlay` 插槽。

改完源码后：

```sh
pnpm run build        # 等价于 node scripts/build.mjs：src → lib
```

重启 `dsh web` 并刷新浏览器即可看到改动（`dsh plugin add` 用的是本地目录链接，lib 改动直接生效）。

## 工作原理（简述）

- **消息来源**：聊天流每行带稳定的 `data-chat-anchor-key` / `data-chat-flow-kind` 属性，面板扫描已渲染的 DOM 行得到「当前窗口」；更早的历史则由 Host 半边从会话日志（`user/message`、`assistant/message` 事件）读取，与 DOM 窗口按身份去重合并。
- **每轮 AI 只显示最后输出**：聊天行 key 形如 `<kind长度>:<kind><id>`（assistant 的 id 为 `轮次:步骤`），解析轮次后每轮只保留最后一步。
- **定位与高亮**：`scrollIntoView({ behavior: 'smooth', block: 'center' })` 定位，再叠加 1.5 秒的 CSS 闪烁动画；目标行尚未渲染时自动点击聊天流自带的「加载更早」按钮逐页翻页，直到目标出现。
- **浏览位置跟踪**：在 `[data-conversation-scroll]` 滚动时按捕获阶段监听 scroll 事件（节流 100ms），取视口顶部对应的最近一条候选消息高亮。
- **主题适配**：颜色全部使用 DSH 主题 token（`--dsw-alias-*`），浅色/深色自动适配。

## 常见问题

- **`pnpm not found on PATH`**：安装 pnpm 后重试。
- **安装后页面上没有按钮**：确认已重启 `dsh web` 并刷新页面；用 `dsh --profile web --dump-config` 确认插件行存在。
- **控制台报 `/plugins/dsh-message-navigator/client.js` 404**：`lib/` 产物缺失，在仓库里跑一次 `pnpm run build`。
- **面板提示「加载失败」**：面板内会显示具体原因（红色小字）。常见原因是 Host 半边路由不可用——确认 Host 半边正常挂载（`dump-config` 里插件行存在），并查看 `dsh web` 的启动日志。
- **切换会话后历史串了**：不会。面板检测到当前会话 id 变化会自动清空历史缓存并重新加载。

## 隐私说明

插件只在**本地**读取当前会话的日志用于面板展示，不向任何外部服务发送数据；面板交互状态（过滤开关等）只保存在当前页面内存中。

## 许可

[MIT](./LICENSE)
