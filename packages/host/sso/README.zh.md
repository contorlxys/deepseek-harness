---
description: "Host half of Web single sign-on: runs the PKCE authorization-code round trip against the identity provider, stores the grant in the credential seam, refreshes tokens, and projects the current token onto a credential reference for consumers."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-sso

[English](README.md) | 中文

## 摘要

用 `dsh-host-sso` 在 Host 侧完成 Web 单点登录的往返与凭据生命周期。浏览器向 `/sso/authorize` 要一个 URL 并跳转；授权服务器重定向到 `/sso/callback`，本包校验 state（不可猜测、单次消费、限时）后用自己保有的 PKCE verifier 换取 token，把授权授予（access token、refresh token、过期时间）作为私有 `GrantRecord` 写入凭据缝，并把当前 access token 投影到一个凭据引用——该投影触发的 `credentials/reference-updated` 正是让消费方（MCP transport）带着新 token 重连的信号。浏览器全程不接触任何秘密；client secret、授权码的 verifier、refresh token 都只在本进程与凭据存储里。

## 目录

- [使用本包](#using-this-package)
- [理解实现](#understanding-the-implementation)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="using-this-package"></a>
## 使用本包

把本包挂载到同时具备 `webServer`、`connection` 和凭据提供方（通常是 `dsh-credentials-local`）的 Web 组合中。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-host-sso'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | `mock` | `mock` 不经网络派生确定性 token；`remote` 走真实的 PKCE 往返。 |
| `authorizeUrl` | `''` | 授权端点，或转发到它的前端中转页；仅当 `mode` 为 `remote` 时必填。带 fragment（`https://idp/#/oauth2/`）时参数位于 fragment 内（`#/oauth2/?…`），中转页从完整 href 里读取。 |
| `tokenUrl` | `''` | 令牌端点；仅当 `mode` 为 `remote` 时必填。 |
| `clientId` | `''` | public client 标识；仅当 `mode` 为 `remote` 时必填。 |
| `clientSecret` | `''` | 令牌端点的 confidential client 密钥；留空即按 public + PKCE 换取。可由 `$DSH_SSO_CLIENT_SECRET` 兜底，且始终留在 Host 侧（不进日志、不下发浏览器）。 |
| `scope` | `''` | 请求的 scope；空则省略该参数。 |
| `redirectPath` | `/sso/callback` | 授权重定向回落的回调路径。 |
| `redirectUri` | `''`（由请求 Host 推导） | 在授权服务器处登记的绝对回调 URL；当 TLS 或代理让推导出的 `http://<Host><redirectPath>` 与登记值不一致时设置。 |
| `credentialKey` | `default` | 本插件在凭据缝记录半边的自身寻址单元。 |
| `credentialRef` | `DSH_ERP_ACCESS_TOKEN` | access token 投影到的凭据引用。 |
| `expirySkewMs` | `60000` | 在过期前多久开始刷新，毫秒。 |
| `exchangeTimeoutMs` | `15000` | 单次远程交换的截止毫秒数。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-host-sso)是每个受支持字段的穷尽式真源。

### 预期行为

`GET /sso/authorize` 生成 state 与 PKCE verifier 并返回跳转 URL（`mock` 模式直接指回本 Host 的回调，携带 mock code，因此浏览器侧流程与真实流程完全一致）；两者都落在凭据缝的记录半边，因此两段之间 Host 重启不会让这次登录作废。`GET /sso/callback` 是授权服务器的重定向目标：state 校验通过后换 token、提交授予、投影 access token，回一个完成页。`GET /sso/status` 报告认证状态并在进入刷新窗口时续期；`POST /sso/logout` 删除授予并撤回投影。`authorize`/`status`/`logout` 是浏览器 fetch，先过 connection 信任围栏；`callback` 是重定向目标，不能要求浏览器登录 cookie，由 state 承担 CSRF 防护。

<a id="understanding-the-implementation"></a>
## 理解实现

授予是本包的私有 `GrantRecord`：payload 格式只有本包能解释，记录半边没有环境可层叠，存在即是全部事实。写入只经 `modifyRecord` 的序列化 read-modify-write——两个进程并发轮换同一个 refresh token 时不会丢写，这正是缝文档为 token 刷新设计的路径。刷新在写锁内进行：并发调用只会轮换一次，其余读到胜者的新授予；被拒绝的授予在锁外撤销（在自身的 read-modify-write 里删除会与缝的锁死锁），而暂时性失败——端点不可达、5xx——保留记录，让下一次调用重试刷新，而不是让操作者重新登录一次。每次 token 变化都把当前 access token `set` 到配置的引用上，投影的事实由 `credentials/reference-updated` 广播，消费方（`dsh-mcp-client` 的 `${cred:NAME}` 模板）据此重连并重新解析。PKCE 是 public client 的硬要求：verifier 在 Host 生成与保存，authorize URL 只携带 `S256` challenge。

## Model Experience

None, as 本包管理的是 IdP 往返与凭据缝；它不暴露面向模型的上下文、工具 schema 或提示文本。

#### KV Cache effect

没有任何模型请求依赖本包。它投影到凭据引用的 access token 经由消费方各自的读取路径到达，因此任何缓存效应属于那些消费方，而非此处。

## 已知限制与延期工作

- 刷新由 `status` 查询与插件激活恢复驱动；没有查询就没有刷新，因此消费方依赖的 token 新鲜度以客户端轮询节奏为上界。
- `remote` 模式假定授权服务器接受本 Host 出示的回调 URL——即配置的 `redirectUri`，或未配置时的 `http://<Host><redirectPath>`（动态端口需要 IdP 接受）。若两者都不接受，回退方案是浏览器侧中继授权码，会重新引入浏览器 JavaScript 暴露。
- 授权服务器不支持 refresh token 轮换时，`refreshToken` 沿用存储值；`mock` 模式派生的是夹具而非凭据，其存在是为了在 IdP 交付端点之前跑通全链路。
