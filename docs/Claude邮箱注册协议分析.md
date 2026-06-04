# Claude 邮箱注册协议分析

本文档说明 Claude 邮箱 magic link 注册流程的关键请求、浏览器上下文要求、代理处理方式，以及当前项目中的自动化实现映射。

## 结论

- Claude 邮箱注册使用 magic link，不依赖 Google OAuth。
- 发送 magic link 的核心接口是 `POST /api/auth/send_magic_link`。
- 请求必须在 `https://claude.ai/login` 页面上下文中执行，并携带当前浏览器 cookies。
- 浏览器需要通过代理访问 Claude，并完成 Cloudflare/站点初始化后再发请求。
- magic link 必须在同一个浏览器 profile 中打开，才能延续注册上下文。
- 注册完成后，登录凭据保存在 `claude.ai` 域下的 `sessionKey` cookie 中。

## 运行环境

当前项目使用 Node.js 实现完整流程：

```text
Chrome/Chromium
Chrome DevTools Protocol
Local proxy bridge
Microsoft Graph / IMAP mailbox reader
```

运行入口：

```text
src/send-email.js              只发送 magic link
src/interactive-register.js    交互式完整注册
src/auto-register-mail.js      邮箱组自动注册
src/open-with-session.js       使用 sessionKey 打开账号
```

## 代理模型

Chrome 不直接使用带认证的代理 URL。项目先启动本地无认证代理桥，再由代理桥连接上游认证代理。

```text
Chrome -> http://127.0.0.1:<local-port> -> authenticated upstream proxy
```

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

代理优先级：

```text
--proxy > CLAUDE_PROXY_URL > config/proxy.json
```

动态代理场景下，每次运行都会创建新的 profile、本地代理端口和 DevTools 端口，避免复用旧浏览器状态。

## 浏览器上下文

浏览器启动参数需要满足：

```text
--user-data-dir=<fresh-profile>
--lang=en-US
--accept-lang=en-US,en
--timezone=America/New_York
--proxy-server=http://127.0.0.1:<local-port>
--remote-debugging-port=<debug-port>
--remote-debugging-address=127.0.0.1
--remote-allow-origins=*
https://claude.ai/login
```

项目会写入英文 profile 偏好：

```json
{
  "intl": {
    "accept_languages": "en-US,en"
  },
  "credentials_enable_service": false,
  "profile": {
    "password_manager_enabled": false
  },
  "autofill": {
    "credit_card_enabled": false,
    "profile_enabled": false
  }
}
```

## 登录页就绪判断

发送请求前需要确认当前页面已经进入 Claude 登录页：

```text
location.href includes https://claude.ai/login
document.title == "Sign in - Claude"
页面存在 email input
```

实现位置：

```text
src/send-email.js              waitForLoginReady()
src/interactive-register.js    waitForLoginReady()
```

常见失败：

```text
ERR_TUNNEL_CONNECTION_FAILED   上游代理隧道失败
ERR_PROXY_CONNECTION_FAILED    代理连接失败
DevTools port did not open     浏览器或调试端口启动失败
```

自动注册流程会对代理/登录失败进行重试。

## 邮箱登录方式探测

前端可能会先请求邮箱可用登录方式：

```http
GET https://claude.ai/api/auth/login_methods?email=<email>&source=claude-ai
```

典型响应：

```json
{
  "methods": ["google", "magic_link"]
}
```

该请求不是发送 magic link 的必要步骤。当前项目直接调用 `send_magic_link`。

## 发送 Magic Link

接口：

```http
POST https://claude.ai/api/auth/send_magic_link
```

请求体：

```json
{
  "utc_offset": 480,
  "email_address": "user@example.com",
  "login_intent": null,
  "locale": "en-US",
  "return_to": null,
  "source": "claude"
}
```

成功响应：

```json
{
  "fallback_code_configuration": {
    "charset": "numeric",
    "length": 6,
    "show_input_after_delay": 5
  },
  "sent": true,
  "sso_url": null,
  "magic_link_intent_available": null,
  "sso_browser_requirement": null
}
```

关键要求：

- 在 Claude 页面上下文执行。
- 使用相对路径 `/api/auth/send_magic_link`。
- 设置 `credentials: "include"`。
- 携带页面中的 client/device 相关 headers。

页面内执行代码：

```js
await fetch("/api/auth/send_magic_link", {
  method: "POST",
  credentials: "include",
  headers: {
    "content-type": "application/json",
    "anthropic-client-platform": "web_claude_ai",
    "anthropic-client-version": document.documentElement.dataset.version || "1.0.0",
    "anthropic-client-sha":
      document.documentElement.dataset.gitHash ||
      document.documentElement.dataset.buildId ||
      "",
    "anthropic-device-id":
      document.cookie.match(/(?:^|; )anthropic-device-id=([^;]+)/)?.[1] || "",
    "anthropic-anonymous-id":
      document.cookie.match(/(?:^|; )ajs_anonymous_id=([^;]+)/)?.[1] || ""
  },
  body: JSON.stringify({
    utc_offset: new Date().getTimezoneOffset() * -1,
    email_address: "user@example.com",
    login_intent: null,
    locale: document.documentElement.lang || navigator.language || "en-US",
    return_to: null,
    source: "claude"
  })
});
```

实现位置：

```text
src/send-email.js              sendMagicLink()
src/interactive-register.js    sendMagicLink()
```

## Magic Link 邮件读取

自动注册使用 Microsoft 邮箱账号格式：

```text
email----password----client_id----refresh_token
```

读取顺序：

```text
new-gr: User.Read Mail.Read offline_access
old-gr: https://graph.microsoft.com/.default
imap:   https://outlook.office.com/IMAP.AccessAsUser.All offline_access
```

邮件读取逻辑：

```text
1. 使用 refresh_token 换取 access_token。
2. 优先通过 Microsoft Graph 读取最近邮件。
3. Graph 不可用时使用 IMAP XOAUTH2。
4. 从邮件正文、HTML、quoted-printable 内容中提取 Claude magic link。
5. 校验 magic link hash 中的邮箱是否匹配当前账号。
```

实现位置：

```text
src/mail-token.js
src/mailbox.js
```

Magic link 格式：

```text
https://claude.ai/magic-link#<token>:<base64-email>
```

## 打开 Magic Link

magic link 需要在发送请求的同一个浏览器 profile 中打开。

原因：

- 浏览器中已有 Claude 初始化 cookies。
- 同一 profile 保留设备标识和匿名 ID。
- 后续 onboarding 与该浏览器上下文绑定。

实现方式：

```text
CDP Page.navigate -> magic-link URL
```

实现位置：

```text
src/interactive-register.js    navigate()
src/auto-register-mail.js      将邮箱中提取的 URL 写入交互式注册子进程
```

## Onboarding

magic link 打开后，页面可能进入以下步骤：

```text
创建账号条款确认
使用场景选择
套餐选择
桌面应用提示
首次聊天前确认
生日填写
姓名填写
职业填写
手机号验证
```

项目自动处理常规步骤：

```text
Let’s create your account
How are you planning to use Claude
Plans that grow with you
Before your first chat
When is your birthday
What’s your name
What kind of work do you do
```

手机号验证属于人工阻塞。使用 `--keep-open-on-error` 时，浏览器会保留给人工处理。

实现位置：

```text
src/interactive-register.js    completeOnboarding()
```

## SessionKey 提取

注册完成后读取 cookies：

```text
sessionKey
sessionKeyLC
routingHint
```

CDP 方法：

```text
Network.getCookies
```

读取 URL：

```text
https://claude.ai/
https://claude.ai/chat
https://platform.claude.com/
```

实现位置：

```text
src/interactive-register.js    getSessionCookies()
```

## 自动化流程

交互式注册：

```text
1. 启动代理桥。
2. 启动全新英文 Chrome profile。
3. 等待 Claude 登录页就绪。
4. 页面内发送 magic link。
5. 等待用户粘贴 magic link。
6. 同 profile 打开 magic link。
7. 自动完成 onboarding。
8. 读取 sessionKey。
```

邮箱组自动注册：

```text
1. 启动交互式注册子进程。
2. 等待子进程提示 Magic link URL。
3. 轮询 Microsoft 邮箱。
4. 提取 magic link。
5. 写入子进程 stdin。
6. 等待注册完成或人工阻塞。
7. 输出结果。
```

## 错误处理

代理或登录页失败：

```text
ERR_TUNNEL_CONNECTION_FAILED
ERR_PROXY_CONNECTION_FAILED
Claude login page not ready
DevTools port did not open
```

处理策略：

```text
关闭当前浏览器和代理桥。
重新创建 profile。
重新创建本地代理端口。
按 --max-attempts 重试。
```

人工阻塞：

```text
Phone verification required
```

处理策略：

```text
带 --keep-open-on-error 时保留浏览器。
父流程返回 blocked: true。
```

## 运行命令

只发送 magic link：

```powershell
node .\src\send-email.js --email user@example.com
```

交互式完整注册：

```powershell
node .\src\interactive-register.js --email user@example.com
```

邮箱组自动注册：

```powershell
node .\src\auto-register-mail.js `
  --account "user@hotmail.com----password----client_id----refresh_token" `
  --keep-open-on-error `
  --max-attempts 5
```

使用已有 `sessionKey`：

```powershell
node .\src\open-with-session.js --session-key "sk-ant-sid02-..."
```

## 实现文件

```text
src/proxy-bridge.js            本地代理桥
src/cdp-client.js              CDP WebSocket client
src/browser-utils.js           浏览器发现和自动下载
src/send-email.js              magic link 发送
src/interactive-register.js    完整交互注册
src/auto-register-mail.js      邮箱组自动注册
src/mail-token.js              Microsoft token 获取
src/mailbox.js                 邮箱读取和 magic link 提取
src/open-with-session.js       sessionKey cookie 注入
```
