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
→ 从当前浏览器读取 sso/sso-rw 登录 Cookie
→ 申请 xAI OAuth 设备码
→ 通过协议请求自动完成 verify/consent/approve
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

注册完成后复用同一浏览器中的 `sso` 或 `sso-rw` 登录 Cookie，执行 OAuth 2.0 Device Authorization Grant。授权阶段不再导航浏览器授权页，也不再依赖页面按钮文字和前端脚本。

协议参数：

```text
OIDC discovery: https://auth.x.ai/.well-known/openid-configuration
client_id: b1a00492-073a-47ea-816f-4c329264a828
scope: openid profile email offline_access grok-cli:access api:access conversations:read conversations:write
grant_type: urn:ietf:params:oauth:grant-type:device_code
```

自动授权流程：

```text
读取浏览器 sso/sso-rw Cookie
→ GET https://accounts.x.ai/ 校验登录态
→ POST https://auth.x.ai/oauth2/device/code
→ 协议访问 verification_uri_complete、verify、consent、approve
→ 如果 accounts.x.ai 被 Cloudflare 拦截，切到当前 Chromium
→ 按表单 action 精确提交 /oauth2/device/verify
→ 按表单 action 精确提交 /oauth2/device/approve，action=allow
→ POST https://auth.x.ai/oauth2/token 轮询令牌
→ 必要时 GET https://auth.x.ai/oauth2/userinfo 补全邮箱
```

程序为 `auth.x.ai` 和 `accounts.x.ai` 发送浏览器中对应的登录 Cookie，并维护授权过程中服务端返回的临时 Cookie。由于协议请求的 TLS 指纹或代理连接可能让账户首页预检跳转到登录页或直接返回 Cloudflare 403，预检结果只用于诊断，不会直接判定 Cookie 失效。协议页面受限时，程序会在同一个已登录 Chromium 页面中打开 `verification_uri_complete`，根据表单的目标地址识别 `verify` 与 `approve`，写入固定字段后直接提交；不会识别按钮文案，也不会依赖鼠标坐标或人工操作。整个 Device Flow 固定使用同一代理出口，并对 `429`、`slow_down`、`invalid_grant` 和授权状态不完整进行有限重试。

令牌轮询支持 `authorization_pending`、`slow_down`、`expired_token` 和 `access_denied`，短暂网络超时会有限重试。access token、refresh token、id token 和 SSO Cookie 不会打印到终端；CLIProxyAPI 认证文件只写入 OAuth Token，不写入 SSO Cookie。

如果浏览器已经到达 `/oauth2/device/done`，但 Token 端点仍返回 `invalid_grant: Access denied`，说明 SSO 与自动授权步骤都已完成，是 xAI 拒绝为该账号签发 Device OAuth Token。此情况通常属于账号资格或风控限制，不应再按“浏览器登录状态失效”处理。

协议自动确认的实现思路参考了 [wenfxl/openai-cpa](https://github.com/wenfxl/openai-cpa) 的 xAI SSO Device Flow，并按当前项目的 Node.js、CDP、代理桥和 CLIProxyAPI 凭证格式重新适配。

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

`xaiOAuthUseProxy` 影响 discovery、登录态校验、设备码、verify、consent、approve、token 和 userinfo 等全部 OAuth 协议请求。部分动态代理对 token 轮询连接不稳定，因此默认使用直连；如果注册登录态受出口 IP 约束，建议开启该选项，让授权请求继续使用注册代理。

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
