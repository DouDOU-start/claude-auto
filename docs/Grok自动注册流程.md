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
→ 申请 xAI OAuth 设备码
→ 在当前登录浏览器中确认 Grok Build 授权
→ 轮询取得 OAuth 令牌
→ 生成 CLIProxyAPI xAI 认证文件
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

## xAI OAuth 授权

注册完成后复用同一浏览器登录状态执行 OAuth 2.0 Device Authorization Grant。协议参数与 CLIProxyAPI 的 xAI 实现保持一致：

```text
OIDC discovery: https://auth.x.ai/.well-known/openid-configuration
client_id: b1a00492-073a-47ea-816f-4c329264a828
scope: openid profile email offline_access grok-cli:access api:access
grant_type: urn:ietf:params:oauth:grant-type:device_code
```

真实页面流程：

```text
https://accounts.x.ai/oauth2/device?user_code=...
→ Continue
→ https://accounts.x.ai/oauth2/device/consent?user_code=...
→ Allow
→ https://accounts.x.ai/oauth2/device/done
→ Device Authorized
```

同意页依赖页面脚本设置隐藏的授权动作，因此自动化使用真实鼠标事件点击按钮，并在页面跳转后等待前端挂载完成。直接调用表单提交会返回 `Invalid action`。

令牌轮询支持 `authorization_pending`、`slow_down`、`expired_token` 和 `access_denied`，短暂网络超时会有限重试。access token、refresh token 和 id token 不会打印到终端，只写入 Git 已忽略的认证文件。

## CLIProxyAPI 认证文件

默认输出位置：

```text
exports/cliproxy/xai-<邮箱>.json
```

主要字段：

```json
{
  "type": "xai",
  "access_token": "...",
  "refresh_token": "...",
  "id_token": "...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "expired": "RFC3339 时间",
  "last_refresh": "RFC3339 时间",
  "email": "user@example.com",
  "sub": "用户标识",
  "base_url": "https://api.x.ai/v1",
  "token_endpoint": "https://auth.x.ai/oauth2/token",
  "auth_kind": "oauth",
  "disabled": false
}
```

程序请求按 `0600` 权限写入认证文件。Windows/WSL 挂载目录的实际访问控制由 Windows ACL 决定，运行摘要中的 `cliproxyAuthPermissionsRestricted` 会标明 POSIX 权限位是否已收紧。可将文件上传到 CLIProxyAPI 管理端，复制到其 `auth-dir`，或者直接把 `cliproxy.authDir` 配置为该目录。

统一配置示例：

```json
{
  "cliproxy": {
    "xaiOAuthAfterRegistration": true,
    "xaiOAuthUseProxy": false,
    "authDir": "./exports/cliproxy"
  }
}
```

`xaiOAuthUseProxy` 只影响 OAuth 协议请求，授权页面仍随注册浏览器走原有代理。部分动态代理对 token 轮询连接不稳定，因此默认使用直连；确有需要时可配置为 `true`。

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

临时关闭注册后的 OAuth：

```powershell
npm run interactive -- --provider grok --no-xai-oauth
```

临时把认证文件直接输出到 CLIProxyAPI 的认证目录：

```powershell
npm run interactive -- --provider grok --cliproxy-auth-dir "E:\code\CLIProxyAPI\auths"
```
