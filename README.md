# Claude 与 Grok 浏览器自动化工具

基于 Node.js 22 和 Chrome DevTools Protocol 的浏览器自动化工具。注册流程支持 Claude 与 Grok；Claude 另外支持已有会话打开、终端聊天和 Anthropic 兼容 API。所有站点操作都在真实 Chromium 页面中完成。

## 免责声明

本项目仅用于技术研究、自动化流程验证和个人学习。使用者应自行确认其行为符合目标服务条款、账号使用规则以及所在地法律法规。因使用本项目造成的账号限制、服务中断、数据损失或其他后果，由使用者自行承担。

## 功能

- 每次运行创建全新 Chrome profile。
- 通过本地代理桥接入带认证的上游代理。
- 首次运行自动下载 Chromium 到本地 `browsers/`。
- 支持 Claude Magic Link 与 Grok 邮箱安全码注册。
- Grok 注册成功后可自动完成 xAI OAuth，并生成 CLIProxyAPI 认证文件。
- 支持交互式注册和 Outlook 邮箱组自动注册。
- 支持 Microsoft Graph / IMAP 自动兜底读取邮件。
- 支持使用已有 `sessionKey` 打开 Claude。
- 支持动态代理失败重试。
- 支持终端流式聊天。
- 支持 Anthropic `/v1/messages` 兼容 API。
- 项目统一使用 Node.js，不需要 Go 工具链。

## 环境要求

- Windows 或 Linux
- Node.js 22+
- 首次运行需要网络下载 Chromium

项目当前没有第三方 npm 运行依赖，正常使用不需要执行 `npm install`。`browsers/`、`profiles/`、`logs/` 和本地敏感配置均已忽略，不会提交到 Git。

## 浏览器

查找顺序：

1. `--chrome <path>`
2. `APP_BROWSER_PATH`（兼容 `CLAUDE_BROWSER_PATH`）
3. 项目本地 `browsers/`
4. 自动下载到项目本地 `browsers/`
5. Playwright 浏览器缓存
6. 系统 Chrome

手动安装浏览器：

```powershell
npm run install-browser
```

禁止自动下载：

```powershell
$env:APP_SKIP_BROWSER_DOWNLOAD = "1"
```

## 统一配置

所有运行模块统一读取一个本地配置：

```text
config/app.local.json
```

仓库只提交同结构的模板 `config/app.example.json`，真实配置已被 Git 忽略。首次使用时复制模板：

```powershell
Copy-Item .\config\app.example.json .\config\app.local.json
```

配置分为代理、浏览器、邮箱、注册、CLIProxy、服务适配器和 API 七个区域：

```json
{
  "proxy": {
    "url": "http://user:password@host:port"
  },
  "browser": {
    "path": "",
    "headless": false
  },
  "mail": {
    "randomDomain": "example.com"
  },
  "registration": {
    "provider": "claude"
  },
  "cliproxy": {
    "xaiOAuthAfterRegistration": true,
    "xaiOAuthUseProxy": false,
    "authDir": "./exports/cliproxy"
  },
  "providers": {
    "claude": {
      "sessionKeys": ["sk-ant-sid02-..."],
      "model": "claude-sonnet-5",
      "effort": "medium"
    },
    "grok": {}
  },
  "api": {
    "host": "127.0.0.1",
    "port": 8080,
    "key": ""
  }
}
```

注册、代理浏览器、聊天和 API 服务都从该文件读取各自需要的字段。也可以使用环境变量覆盖：

旧版配置中的顶层 `claude` 区域仍可读取，建议后续统一迁移到 `providers.claude`。

```powershell
$env:CLAUDE_SESSION_KEY = "sk-ant-sid02-..."
$env:APP_PROXY_URL = "http://user:password@host:port"
$env:APP_RANDOM_EMAIL_DOMAIN = "mail.example.com"
$env:APP_REGISTRATION_PROVIDER = "grok"
$env:APP_CLIPROXY_XAI_OAUTH = "true"
$env:APP_CLIPROXY_XAI_OAUTH_PROXY = "false"
$env:APP_CLIPROXY_AUTH_DIR = ".\exports\cliproxy"
```

配置优先级：

```text
命令行参数 > 通用环境变量 > 兼容环境变量 > config/app.local.json
```

`mail.randomDomain` 是未传入 `--email` 时使用的随机邮箱后缀。可以填写 `mail.example.com` 或 `@mail.example.com`；程序会自动去掉开头的 `@`。如果没有任何配置，则回退使用 `example.com`。

`registration.provider` 是注册命令默认使用的服务，支持 `claude` 和 `grok`。命令行 `--provider` 可以临时覆盖该配置。

`cliproxy.xaiOAuthAfterRegistration` 控制 Grok 注册成功后是否继续完成 xAI Device OAuth。默认启用，只影响 Grok，不影响 Claude。认证文件默认保存为：

```text
exports/cliproxy/xai-<邮箱>.json
```

该文件可直接上传到 CLIProxyAPI 管理端，或复制到 CLIProxyAPI 配置的 `auth-dir`。也可以把 `cliproxy.authDir` 直接配置为 CLIProxyAPI 的认证目录。程序会请求使用 `0600` 权限写入；Windows/WSL 挂载目录的实际访问控制由 Windows ACL 决定，摘要中的 `cliproxyAuthPermissionsRestricted` 会标明 POSIX 权限位是否已收紧。

`cliproxy.xaiOAuthUseProxy` 控制登录态校验、设备码、verify、consent、approve、token 和 userinfo 等全部 OAuth 请求。授权阶段优先复用注册浏览器中的 `sso/sso-rw` Cookie 走协议请求；如果 `accounts.x.ai` 被 Cloudflare 拦截，则自动在当前已登录浏览器中按固定的 `verify` 和 `approve` 表单地址提交，不依赖按钮文案、坐标或人工点击。默认直连是因为部分动态代理对 token 轮询连接不稳定；如果 xAI 登录态受出口 IP 约束，建议将其改为 `true`。

代理链路：

```text
Chrome -> http://127.0.0.1:<port> -> authenticated upstream proxy
```

## 快速开始

```powershell
cd claude-auto
```

交互式注册：

```powershell
npm run interactive
```

邮箱组自动注册：

```powershell
npm run auto-register-mail -- --account "email----password----client_id----refresh_token" --keep-open-on-error
```

使用已有 `sessionKey` 打开：

```powershell
node .\src\open-with-session.js --session-key "sk-ant-sid02-..."
```

只打开一个带代理的浏览器（不登录、不注册，纯浏览）：

```powershell
node .\src\open-browser.js
```

终端聊天：

```powershell
npm run chat
```

启动 Anthropic 兼容 API：

```powershell
npm run api
```

## 邮箱组自动注册

账号格式：

```text
email----password----client_id----refresh_token
```

单账号：

```powershell
npm run auto-register-mail -- --account "user@hotmail.com----password----client_id----refresh_token"
```

批量：

```powershell
npm run auto-register-mail -- --accounts-file .\accounts.txt
```

动态代理推荐参数：

```powershell
npm run auto-register-mail -- `
  --account "user@hotmail.com----password----client_id----refresh_token" `
  --keep-open-on-error `
  --max-attempts 5
```

流程：

1. 启动新的代理浏览器 profile。
2. 通过服务适配器提交邮箱并发送验证信息。
3. 通过 Graph 或 IMAP 读取邮件。
4. Claude 提取 Magic Link；Grok 提取 6 位字母数字安全码。
5. 在同一浏览器环境完成邮箱验证。
6. 完成服务对应的新用户流程。
7. 读取服务登录会话。
8. Grok 读取浏览器 SSO Cookie，通过协议请求或当前浏览器的固定表单自动完成 xAI Device OAuth，并输出 CLIProxyAPI 认证文件。

主要参数：

```text
--provider <name>             注册服务适配器，优先于统一配置。
--account <line>              单个邮箱组账号。
--accounts-file <path>        批量账号文件。
--mail-timeout <ms>           邮件轮询超时，默认 180000。
--mail-interval <ms>          邮件轮询间隔，默认 5000。
--max-attempts <n>            代理/登录失败重试次数，默认 3。
--retry-delay <ms>            重试间隔，默认 3000。
--registration-timeout <ms>   父进程超时，默认 600000。
--devtools-timeout <ms>       DevTools 启动超时，默认 30000。
--login-timeout <ms>          注册页超时，默认 90000。
--given-name <name>           Grok 注册名字。
--family-name <name>          Grok 注册姓氏。
--password <password>         Grok 注册密码，默认随机生成。
--no-proxy                    本次注册不使用代理。
--xai-oauth                   Grok 注册后执行 xAI OAuth。
--no-xai-oauth                Grok 注册后不执行 xAI OAuth。
--cliproxy-auth-dir <path>    CLIProxy 认证文件输出目录。
--xai-oauth-proxy             OAuth 协议请求使用注册代理。
--no-xai-oauth-proxy          OAuth 协议请求使用直连。
--keep-open                   成功后保留浏览器。
--keep-open-on-error          仅在人工 onboarding 阻塞时保留浏览器。
```

`--keep-open-on-error` 只保留手机号验证等人工处理场景。代理隧道失败、登录页失败、DevTools 启动失败会关闭当前浏览器并重试。

## 交互式注册

```powershell
npm run interactive
```

指定邮箱和姓名：

```powershell
npm run interactive -- --email test-demo@example.com --name "Alex Morgan"
```

指定生日：

```powershell
npm run interactive -- --birthday "01/01/1995"
```

Grok 交互式注册：

```powershell
npm run interactive -- --provider grok --email user@example.com --no-proxy
```

如果本地配置已经设置为：

```json
{
  "registration": {
    "provider": "grok"
  }
}
```

则可以省略 `--provider`：

```powershell
npm run interactive -- --no-proxy
```

程序发送安全码后，在终端输入邮件中的六位安全码。邮件常见展示格式为 `ABC-123`，输入时保留或省略连字符都可以。

主要参数：

```text
--provider <name>           注册服务适配器，优先于统一配置。
--email <email>             注册邮箱，未提供时自动生成随机邮箱。
--domain <domain>           随机邮箱后缀，优先于统一配置。
--name <name>               显示名称，默认随机英文名。
--given-name <name>         Grok 注册名字。
--family-name <name>        Grok 注册姓氏。
--password <password>       Grok 注册密码，默认随机生成。
--birthday <MM/DD/YYYY>     生日，默认 01/01/1995。
--proxy <proxy-url>         代理覆盖。
--no-proxy                  本次注册不使用代理。
--chrome <path>             浏览器路径覆盖。
--profile-dir <path>        Chrome profile 目录。
--log-dir <path>            输出目录，默认 ./logs。
--xai-oauth                 注册后执行 xAI OAuth。
--no-xai-oauth              注册后不执行 xAI OAuth。
--cliproxy-auth-dir <path>  CLIProxy 认证文件输出目录。
--xai-oauth-proxy           OAuth 协议请求使用注册代理。
--no-xai-oauth-proxy        OAuth 协议请求使用直连。
--keep-open                 完成后保留浏览器和代理桥。
--keep-open-on-error        仅在人工 onboarding 阻塞时保留浏览器。
```

## 发送邮箱验证信息

```powershell
npm run send -- --email test-demo@example.com
```

使用配置文件中的随机邮箱后缀：

```powershell
npm run send
```

临时覆盖随机邮箱后缀：

```powershell
npm run send -- --domain example.com
```

发送 Grok 邮箱安全码并保留浏览器：

```powershell
npm run send -- --provider grok --email user@example.com --no-proxy
```

## 使用 SessionKey

```powershell
node .\src\open-with-session.js --session-key "sk-ant-sid02-..."
```

可选 cookies：

```powershell
node .\src\open-with-session.js `
  --session-key "sk-ant-sid02-..." `
  --session-key-lc "1780475735165" `
  --routing-hint "sk-ant-rh-..."
```

默认打开：

```text
https://claude.ai/chat
```

## 纯代理浏览器

不登录、不注册、不做任何页面自动化，只是用配置好的代理打开一个 Chrome 窗口，窗口会一直保留，直到手动关闭或 Ctrl+C 停掉本地代理桥：

```powershell
node .\src\open-browser.js
```

指定打开的地址：

```powershell
node .\src\open-browser.js --url https://claude.ai/login
```

默认打开：

```text
https://claude.ai/
```

## 终端聊天

启动：

```powershell
npm run chat
```

可用命令：

```text
/new    新建会话
/model  切换模型
/quit   退出
```

终端聊天会启动一个独立 Chromium，并通过页面内流式请求与 Claude Web 接口通信。首次运行如果出现 Cloudflare 验证，需要在浏览器窗口中手动完成；该 profile 会保留供后续复用。确认环境可以稳定通过验证后，可改用无头模式：

```powershell
npm run chat -- --headless
```

## Anthropic 兼容 API

默认只监听本机：

```text
http://127.0.0.1:8080
```

启动：

```powershell
npm run api
```

请求示例：

```powershell
curl http://127.0.0.1:8080/v1/messages `
  -H "content-type: application/json" `
  -d '{"model":"claude-sonnet-5","max_tokens":1024,"messages":[{"role":"user","content":"你好"}]}'
```

对外监听时必须配置访问密钥：

```powershell
$env:CLAUDE_API_HOST = "0.0.0.0"
$env:CLAUDE_API_KEY = "替换为随机密钥"
npm run api
```

客户端通过 `x-api-key` 或 `Authorization: Bearer <密钥>` 访问。请求体默认限制为 20 MB。

## Microsoft 邮件令牌

自动模式：

```powershell
node .\src\mail-token.js --refresh-token "<refresh_token>" --client-id "<client_id>"
```

指定模式：

```powershell
node .\src\mail-token.js --refresh-token "<refresh_token>" --client-id "<client_id>" --mode imap
```

兜底顺序：

```text
new-gr: User.Read Mail.Read offline_access
old-gr: https://graph.microsoft.com/.default
imap:   https://outlook.office.com/IMAP.AccessAsUser.All offline_access
```

## 输出

注册成功后会在终端输出 JSON，并将详细结果写入 `logs/`。

Grok 的完整结果中包含随机生成或命令行指定的密码，以及 `sso` 会话 Cookie；这些文件和浏览器 profile 已被 Git 忽略，不应复制到公开位置。

示例：

```json
{
  "email": "test-demo@example.com",
  "name": "Alex Morgan",
  "birthday": "01/01/1995",
  "durationText": "1m 32s",
  "sessionKey": "sk-ant-sid02-...",
  "sessionKeyLC": "1780479117030",
  "profileDir": "...",
  "debugPort": 54321,
  "outputPath": "logs/claude-register-....json"
}
```

## 常见问题

`ERR_TUNNEL_CONNECTION_FAILED`

代理隧道失败。更换代理或提高 `--max-attempts`。

`407 Proxy Authentication Required`

当前代理不允许访问 Grok。更换代理，或为直连环境传入 `--no-proxy`。

`Phone verification required`

Claude 要求手机号验证。使用 `--keep-open-on-error` 保留浏览器。

`No browser executable found`

执行 `npm run install-browser`，传入 `--chrome <path>`，或取消 `CLAUDE_SKIP_BROWSER_DOWNLOAD`。

`Magic link email mismatch`

magic link 对应邮箱与当前注册邮箱不一致。使用匹配的账号重新运行。

`需要人工完成 Grok Turnstile 安全验证`

使用 `--keep-open-on-error` 保留当前浏览器并在窗口中完成安全验证。程序不会绕过可见的 Turnstile 挑战。

## 开发

```powershell
npm test
npm run check
git status --short --ignored
```

实现要点：

- 浏览器控制使用 Chrome DevTools Protocol。
- magic-link 请求在 `claude.ai` 页面上下文中执行。
- 每次运行默认创建新的 profile、DevTools 端口和本地代理桥。
- 聊天与 API 请求通过后台 Chrome 页面内的 `fetch` 发出。
- `src/core/` 负责浏览器运行时、注册编排和命令行公共能力。
- `src/mail/` 负责通用邮箱账号、Outlook Graph/IMAP 读取和轮询。
- `src/providers/claude/` 只负责 Claude 登录、邮件匹配、新用户引导和会话提取。
- `src/providers/grok/` 负责 Grok 邮箱安全码、账号资料提交和会话提取。
- `src/providers/index.js` 是注册服务适配器入口。
- `src/commands/` 负责交互注册、批量注册、聊天和 API 等命令入口。
- `src/tools/claude/` 保存 Claude 页面诊断工具，不参与正式注册流程。

新增注册服务时的接口约定见 [注册服务适配器扩展指南](docs/注册服务适配器扩展指南.md)，Grok 的真实浏览器走查结果见 [Grok 自动注册流程](docs/Grok自动注册流程.md)。

## 许可证

使用 MIT 许可证，详见 `LICENSE`。
