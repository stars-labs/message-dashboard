# Balance Agent app

The macOS menu-bar app (`sms-dashboard/balance-agent/src/main.ts`): a tray menu and one
window with two tabs, 状态 and 设置. It hosts the same capabilities as the CLI, with
credentials encrypted by Electron `safeStorage` in its user-data dir.

## Sub-features

- tray menu: status rows, 显示验证窗口 (only while a carrier portal waits for a human),
  打开 Dashboard, 设置..., 登录系统后自动启动, 退出 (`src/menu-model.ts`).
- 状态 tab: 登录 / 退出登录, Dashboard, SMS AI and 浏览器查询 states, device code.
- 设置 tab: 设备名称, Dashboard URL, Auth0 issuer, Auth0 client ID, Auth0 audience,
  AI URL, 模型, 协议, AI token, 登录系统后自动启动; buttons 测试全部配置, 测试连接,
  保存设置.
- single instance: opening the app again shows the window of the running one.

## How to get to it (user POV)

Launch Balance Agent; it lives in the menu bar with no Dock icon. Open the window from
the tray menu, or by opening the app again.

## Driving it with bun run verify

```ts
const app = await agentApp(); // own user-data dir; needs the Electron binary (SKILL.md)
const w = await app.open();   // second launch: the running instance shows its window
await w.getByText('未配置 Dashboard').waitFor();
await w.getByRole('button', { name: '设置', exact: true }).click();
await w.getByLabel('Dashboard URL', { exact: true }).fill(stack.baseUrl);
await w.getByLabel('Auth0 issuer', { exact: true }).fill(`http://${stack.auth0.domain}`);
await w.getByLabel('Auth0 client ID', { exact: true }).fill(stack.auth0.nativeClientId);
await w.getByLabel('Auth0 audience', { exact: true }).fill(stack.auth0.audience);
await w.getByLabel('AI URL', { exact: true }).fill(ai.baseUrl);
await w.getByLabel('模型', { exact: true }).fill('fake-model');
await w.getByRole('button', { name: '保存设置' }).click();
// settings.json in app.userData now holds those values
await w.getByRole('button', { name: '测试全部配置' }).click();
// Dashboard 请先登录 · 公司 AI 请先填写：aiToken · 浏览器 浏览器运行时可用
```

Proof: the window's text and `settings.json` in `app.userData`.

## Gotchas

- Do not click 登录 in a journey: the device flow opens the verification URL in the
  operator's real default browser. Sign-in is proven through the CLI
  ([agent-cli](agent-cli.md)), which shares the code.
- Do not type an AI token into the app: `safeStorage` creates an "Electron Safe
  Storage" item in the operator's login Keychain, shared by every dev Electron app.
- The tray menu is a native menu that Playwright cannot click; `src/menu-model.ts`
  is unit-tested instead.
- The app does not quit when Playwright asks it to; the driver kills it after 10s and
  the report carries a NOTE. Whether a user's 退出 has the same problem is not yet
  known ([GRA-230](https://linear.app/gray-arrow/issue/GRA-230)).
- Closing the window only hides it.
