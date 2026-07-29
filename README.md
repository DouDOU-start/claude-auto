# Claude 浏览器自动化工具

基于 Node.js 22 和 Chrome DevTools Protocol 的 Claude 浏览器自动化工具。支持邮箱注册、代理浏览器、已有会话打开、终端聊天和 Anthropic 兼容 API。所有 Claude Web 请求都在真实 Chrome 页面上下文中发出，以保持浏览器 TLS 指纹和 Cloudflare 会话。

## 免责声明

本项目仅用于技术研究、自动化流程验证和个人学习。使用者应自行确认其行为符合目标服务条款、账号使用规则以及所在地法律法规。因使用本项目造成的账号限制、服务中断、数据损失或其他后果，由使用者自行承担。

## 功能

- 每次运行创建全新 Chrome profile。
- 通过本地代理桥接入带认证的上游代理。
- 首次运行自动下载 Chromium 到本地 `browsers/`。
- 支持交互式注册和邮箱组自动注册。
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
2. `CLAUDE_BROWSER_PATH`
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
$env:CLAUDE_SKIP_BROWSER_DOWNLOAD = "1"
```

## 代理配置

配置文件：

```text
config/proxy.json
```

格式：

```json
{
  "proxyUrl": "REPLACE_WITH_AUTHENTICATED_HTTP_PROXY_URL"
}
```

优先级：

```text
--proxy > CLAUDE_PROXY_URL > config/proxy.json
```

代理链路：

```text
Chrome -> http://127.0.0.1:<port> -> authenticated upstream proxy
```

仓库提供模板：`config/proxy.example.json`。

### Claude 本地配置

聊天和 API 服务使用：

```text
config/claude.local.json
```

同时兼容被忽略的 `config/claude.local.yaml`，旧 Go 配置已迁移到该位置。

从模板复制：

```powershell
Copy-Item .\config\claude.example.json .\config\claude.local.json
```

至少填写 `sessionKeys`。也可以完全使用环境变量：

```powershell
$env:CLAUDE_SESSION_KEY = "sk-ant-sid02-..."
$env:CLAUDE_PROXY_URL = "http://user:password@host:port"
```

敏感配置优先级：

```text
命令行参数 > 环境变量 > config/claude.local.json > config/proxy.json
```

## 快速开始

```powershell
cd claude-auto
```

交互式注册：

```powershell
node .\src\interactive-register.js
```

邮箱组自动注册：

```powershell
node .\src\auto-register-mail.js --account "email----password----client_id----refresh_token" --keep-open-on-error
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
node .\src\auto-register-mail.js --account "user@hotmail.com----password----client_id----refresh_token"
```

批量：

```powershell
node .\src\auto-register-mail.js --accounts-file .\accounts.txt
```

动态代理推荐参数：

```powershell
node .\src\auto-register-mail.js `
  --account "user@hotmail.com----password----client_id----refresh_token" `
  --keep-open-on-error `
  --max-attempts 5
```

流程：

1. 启动新的代理浏览器 profile。
2. 向邮箱发送 Claude magic link。
3. 通过 Graph 或 IMAP 读取邮件。
4. 提取 `https://claude.ai/magic-link#...`。
5. 在同一浏览器环境打开 magic link。
6. 完成 onboarding。
7. 输出并记录 `sessionKey`。

主要参数：

```text
--account <line>              单个邮箱组账号。
--accounts-file <path>        批量账号文件。
--mail-timeout <ms>           邮件轮询超时，默认 180000。
--mail-interval <ms>          邮件轮询间隔，默认 5000。
--max-attempts <n>            代理/登录失败重试次数，默认 3。
--retry-delay <ms>            重试间隔，默认 3000。
--registration-timeout <ms>   父进程超时，默认 600000。
--devtools-timeout <ms>       DevTools 启动超时，默认 30000。
--login-timeout <ms>          Claude 登录页超时，默认 90000。
--keep-open                   成功后保留浏览器。
--keep-open-on-error          仅在人工 onboarding 阻塞时保留浏览器。
```

`--keep-open-on-error` 只保留手机号验证等人工处理场景。代理隧道失败、登录页失败、DevTools 启动失败会关闭当前浏览器并重试。

## 交互式注册

```powershell
node .\src\interactive-register.js
```

指定邮箱和姓名：

```powershell
node .\src\interactive-register.js --email test-demo@k9ray.com --name "Alex Morgan"
```

指定生日：

```powershell
node .\src\interactive-register.js --birthday "01/01/1995"
```

主要参数：

```text
--email <email>             注册邮箱，默认随机 @k9ray.com。
--domain <domain>           随机邮箱域名，默认 k9ray.com。
--name <name>               显示名称，默认随机英文名。
--birthday <MM/DD/YYYY>     生日，默认 01/01/1995。
--proxy <proxy-url>         代理覆盖。
--chrome <path>             浏览器路径覆盖。
--profile-dir <path>        Chrome profile 目录。
--log-dir <path>            输出目录，默认 ./logs。
--keep-open                 完成后保留浏览器和代理桥。
--keep-open-on-error        仅在人工 onboarding 阻塞时保留浏览器。
```

## 发送 Magic Link

```powershell
node .\src\send-email.js --email test-demo@k9ray.com
```

随机邮箱：

```powershell
node .\src\send-email.js --domain k9ray.com
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

示例：

```json
{
  "email": "test-demo@k9ray.com",
  "name": "Alex Morgan",
  "birthday": "01/01/1995",
  "durationText": "1m 32s",
  "sessionKey": "sk-ant-sid02-...",
  "sessionKeyLC": "1780479117030",
  "profileDir": "...",
  "debugPort": 54321,
  "outputPath": "logs/interactive-register-....json"
}
```

## 常见问题

`ERR_TUNNEL_CONNECTION_FAILED`

代理隧道失败。更换代理或提高 `--max-attempts`。

`Phone verification required`

Claude 要求手机号验证。使用 `--keep-open-on-error` 保留浏览器。

`No browser executable found`

执行 `npm run install-browser`，传入 `--chrome <path>`，或取消 `CLAUDE_SKIP_BROWSER_DOWNLOAD`。

`Magic link email mismatch`

magic link 对应邮箱与当前注册邮箱不一致。使用匹配的账号重新运行。

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
- `src/claude/` 负责 Claude Web 客户端、SSE 和协议适配。
- `src/core/` 负责浏览器运行时与命令行公共能力。

## 许可证

使用 MIT 许可证，详见 `LICENSE`。
