# Grok 自动注册流程

本文记录 2026 年 7 月通过真实 Chromium 与 Chrome DevTools Protocol 完成的 Grok 邮箱注册流程。文档只保留页面结构和会话字段名称，不记录测试账号密码、Cookie 值或代理凭据。

## 实际流程

```text
https://grok.com/
→ Sign up
→ https://accounts.x.ai/sign-up?redirect=grok-com&return_to=%2F
→ Sign up with email
→ 填写邮箱并继续
→ 输入一次性邮箱安全码
→ 填写名字、姓氏和密码
→ 站点执行 Turnstile 校验并创建账号
→ 重定向至 https://grok.com/
```

邮箱安全码在邮件中可能显示为 `ABC-123`，页面输入框实际接收 6 位字母数字，例如 `ABC123`。输入满 6 位后页面会自动提交；适配器仍兼容需要点击 `Confirm email` 的页面变体。

## 已确认的页面字段

邮箱安全码：

```text
input[name="code"]
```

注册资料：

```text
input[data-testid="givenName"]
input[data-testid="familyName"]
input[data-testid="password"]
```

密码至少需要 8 个字符。项目默认生成随机密码，也可以通过 `--password` 指定。

## 已确认的网络行为

发送邮箱安全码：

```text
POST https://accounts.x.ai/auth_mgmt.AuthManagement/CreateEmailValidationCode
```

资料提交期间还会调用密码校验接口，并加载 Cloudflare Turnstile。实测注册中 Turnstile 在真实浏览器环境下无感完成，账号创建请求返回成功后自动跳转至 Grok 首页。

如果站点显示可见的 Turnstile 挑战，程序不会尝试绕过。配合 `--keep-open-on-error` 可以保留浏览器，让使用者自行完成安全验证。

## 会话提取

成功登录后已确认下列 Cookie 存在：

```text
x-userid
x-anonuserid
grok_device_id
sso
sso-rw
x-signature
x-challenge
cf_clearance
```

完整 Cookie 和注册密码仅写入 Git 已忽略的 `logs/` 与浏览器 profile。终端摘要不输出 Grok 的 `sso` 值。

## 使用方式

交互输入邮箱安全码：

```powershell
npm run interactive -- --provider grok --email user@example.com --no-proxy
```

通过 Outlook Graph 或 IMAP 自动读取邮箱安全码：

```powershell
npm run auto-register-mail -- `
  --provider grok `
  --account "email----password----client_id----refresh_token" `
  --no-proxy
```

如果代理允许访问 Grok，可以去掉 `--no-proxy` 并使用统一配置中的代理。
