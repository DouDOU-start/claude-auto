# Claude Email Automation

基于 Chrome DevTools Protocol 的 Claude 邮箱注册自动化工具。支持代理启动独立浏览器 profile、发送 magic link、读取 Microsoft 邮箱、完成 onboarding，并提取 cookies 中的 `sessionKey`。

## 功能

- 每次运行创建全新 Chrome profile。
- 通过本地代理桥接入带认证的上游代理。
- 首次运行自动下载 Chromium 到本地 `browsers/`。
- 支持交互式注册和邮箱组自动注册。
- 支持 Microsoft Graph / IMAP 自动兜底读取邮件。
- 支持使用已有 `sessionKey` 打开 Claude。
- 支持动态代理失败重试。

## 环境要求

- Windows
- Node.js 22+
- 首次运行需要网络下载 Chromium

正常使用不需要执行 `npm install`。`browsers/`、`profiles/`、`logs/` 和 `config/proxy.json` 均已忽略，不会提交到 Git。

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

## 快速开始

```powershell
cd claude-email-automation
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
node --check .\src\interactive-register.js
node --check .\src\auto-register-mail.js
node --check .\src\browser-utils.js
git status --short --ignored
```

实现要点：

- 浏览器控制使用 Chrome DevTools Protocol。
- magic-link 请求在 `claude.ai` 页面上下文中执行。
- 每次运行默认创建新的 profile、DevTools 端口和本地代理桥。
