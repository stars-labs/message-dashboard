# App shell

What surrounds every view: the sign-in gate, navigation at both widths, status
banners, the daemon health panel, toasts, confirm dialogs and the service-worker
update prompt.

## Sub-features

- sign-in gate: spinner while checking; 无法连接服务器 + 重试 when the Worker is down;
  signed out, 验证码中心 with 使用 Auth0 登录.
- desktop nav: 消息, 设备与卡 (`phones.write`), 余额, 规则 (`keywords.read` or
  `filters.read`), 用户 (`users.read`); header 通话, 采集服务<状态>, 发送短信, 🧹 cache
  reset, avatar (`title="退出登录"`).
- mobile tab bar: 验证码 / 设备 / 余额 / 发送 / 更多; the active tab has
  `data-mobile-tab-active="true"`. 更多 opens a dialog with 运行状态, 规则
  (垃圾过滤, 关键词高亮), 管理 (用户管理), 账户 (重置本地缓存, 退出登录).
- daemon health: header button 采集服务正常 / 部分异常 / 离线 / 错误 opens dialog
  `采集服务状态` (短信读取, 消息上传, 最老积压, 待处理, 上传中, 人工处理, 版本; buttons
  `刷新状态`, `关闭`).
- banners: red 采集服务离线|错误 with 重新连接; yellow card errors with 查看详情.
- toasts: top right, `role=alert`, auto-dismiss after 4s.
- confirm dialogs: `role=dialog` named by their title (default 请确认).
- update prompt: `role=status` 新版本已准备好 with 重新载入 / `稍后再说`.

## How to get to it (user POV)

Always present. Desktop is 1024px and up; below that the tab bar replaces the nav.

## Driving it with bun run verify

```ts
const d = await page('desktop');
await d.goto(`${stack.baseUrl}/#dashboard`);
await d.getByRole('button', { name: /采集服务/ }).first().click();
const panel = d.getByRole('dialog', { name: '采集服务状态' });
await panel.waitFor(); // 采集服务正常 … 版本 8.0.1

const m = await page('mobile');
await m.goto(`${stack.baseUrl}/#dashboard`);
await m.getByRole('button', { name: '更多' }).click();
await m.getByRole('dialog', { name: '更多' }).waitFor();
```

Switch views with the nav buttons (`getByRole('button', { name: '余额' })`), as a
user does; assert on `location.hash` and the view's heading.

## Gotchas

- Every run is signed in as admin, so every gated link shows. Hiding by permission
  needs a viewer session, which the stack does not create yet.
- Nav clicks close drawers and detail panels; `page.goto` to another hash does not,
  and a leftover backdrop then swallows clicks.
- The seeded heartbeat is the stack's start time; a long journey can see the status
  age, so assert on the panel's fields, not 刚刚.
- `bun run e2e` starts with an empty browser context, follows `/login` through fake
  Auth0 and `/callback`, then checks the new session at `/api/auth/me`. To exercise
  this in a journey, clear the seeded cookies on `page.context()` before opening
  `/login`. Fake Auth0 automatically approves the admin and enforces S256 PKCE.
- The Worker rejects missing or mismatched login state before contacting Auth0.
  The fake tenant implements browser sign-in and device authorization. Its logout
  page is unavailable.
- The mobile tab 发送 is shown without checking `messages.send`; the `#send` view
  itself is gated.
