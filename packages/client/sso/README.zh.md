---
description: "浏览器半的 Web 单点登录：在 Host 未持有授权时给出框级登录提示，启动 Host 的 PKCE 往返"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-sso

English | [中文](README.md)

## 摘要

`@deepseek-ai/dsh-client-sso` 是 Web 单点登录的浏览器半。它往 `shell.overlay` 层注册一个条目，轮询 Host 的授权状态（`GET /sso/status`），在授权授予缺失期间常驻一条框级提示，其动作启动该往返。组件去取 `GET /sso/authorize`、跳转到返回的 URL，其余时间不插手——Host 独占每个秘密、令牌交换与凭据投影。Host 侧行为与线协议见 [`@deepseek-ai/dsh-host-sso`](../../host/sso/README.zh.md)。

## 目录

- [使用本包](#using-this-package)
- [理解实现](#understanding-the-implementation)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="using-this-package"></a>
## 使用本包

把本包挂载进已经挂载 `@deepseek-ai/dsh-host-sso` 的 Web 组合（两者以 `sso` / `client-sso` 的 roster 条目出现在 Web bundle 里）。浏览器应用不需要任何定制代码：提示自行出现与消失。

提示按固定节奏轮询，呈现三种渲染态之一：

- **未登录** —— 带「去认证」动作的框级横幅；
- **出错** —— 状态查询失败时同样的横幅带「重试」动作；
- **已登录** —— 不渲染任何内容；授予一旦存在横幅即卸载。

轮询节奏是 UX 常量而非部署旋钮，因此它留在组件内，不进 `Config`。

<a id="understanding-the-implementation"></a>
## 理解实现

组件是自包含的：它自己持有 `useEffect` 轮询循环与动作，只向 `shell.overlay` 注册一个 `id`，因此不会替掉别的条目。每次 fetch 都收窄线边界（`isSsoStatus`、`isSsoAuthorize`），Host 返回畸形答案时会大声失败，而不是渲染空白横幅。动作绝不接触秘密——它去取已经构造好的 `authorizeUrl` 并对其调用 `window.location.assign`；PKCE verifier 与 code 交换都留在 Host。等 Host 的完成页把浏览器带回、下一次轮询观察到授予，组件自行撤除，而 Host 的 `credentials/reference-updated` 扇出正是让消费方（MCP transport）带着新 token 重连的原因。

## Model Experience

None, as 本包是一个浏览器 overlay 提示；它不渲染任何面向模型的上下文、工具 schema 或提示文本。

#### KV Cache effect

没有任何模型请求依赖本包。它的登录提示是一个框级 UI 元素，其存在与否不改变任何模型提示或工具 schema。

## 已知限制与延期工作

- 提示是引导而非栅栏：它依赖 `@deepseek-ai/dsh-host-sso` 已被挂载并提供 `/sso/status`。若 Host 缺失，轮询会进入错误态而非静默卡死，于是横幅保持可见而非消失——预期配置总是成对挂载这两个条目。
- 轮询节奏是固定的 UX 常量，需要不同节奏的部署必须改组件而非改配置。
- 消费方的 token 新鲜度以该轮询节奏加上 Host 的刷新窗口为上界，见 Host 包的描述。
