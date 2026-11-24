# Message feed

The default view (`#dashboard`): received and sent SMS across every SIM, with
verification codes up front. Read-only: nothing here writes D1.

## Sub-features

- feed: rows `[data-message-row]`, newest first, with a 实时 / 本地缓存 / 连接失败 badge.
- tabs: 验证码 (rows with a code) / 余额查询 / 全部短信 (default).
- code copy: tapping a code copies it; a `role=status` pill says 已复制 and the code.
- spam toggle: on 全部短信 only, shows rows hidden by filter rules, dimmed, labelled
  `已过滤: <rule note>`.
- receiver filter: the SIM list (search, 全部 / 在线 / 离线 / 异常 chips) narrows the
  feed to one SIM; `title="返回全部设备"` clears it.
- detail: a row opens 短信详情 with sender, SIM, time, code, full text and audit
  fields; 复制全文 copies the text.
- load more: 显示更多记录.
- refresh: polled every 60s while visible; pull-to-refresh on touch below 1024px.

## How to get to it (user POV)

Open the app; it lands here. Desktop: nav 消息. Mobile: tab 验证码. On desktop the SIM
list sits left of the feed; on mobile the header button `选择接收卡` opens it as a
sheet (`role=dialog`, closed with `关闭`).

## Driving it with bun run verify

```ts
const p = await page('desktop');
await p.goto(`${stack.baseUrl}/#dashboard`);
await p.locator('[data-message-row]').first().waitFor();

// code copy (scripts/verify/journeys/copy-verification-code.ts)
await p.getByRole('button', { name: '482913', exact: true }).click();
await p.getByRole('status').filter({ hasText: '482913' }).waitFor();
// clipboard: v.parse(v.string(), await p.evaluate('navigator.clipboard.readText()'))

// spam toggle: aria-pressed flips and e2e-msg-3 appears
await p.getByRole('button', { name: '显示垃圾短信' }).click();
await p.getByText('已过滤: Marketing sender').waitFor();

// detail
await p.locator('[data-message-row]').filter({ hasText: '7731' }).first().click();
const detail = p.getByRole('region', { name: '短信详情' });
await detail.waitFor(); // text includes 'e2e-msg-2', 'S02', '7731'
await detail.getByRole('button', { name: '关闭' }).click();
```

Proof: the toast and the clipboard for copy; `aria-pressed="true"` plus the filtered
row for the spam toggle; the detail's text for detail.

## Gotchas

- The copy button's `title` is `点击复制`, `已复制！` for 2s after; its accessible name is
  the code itself. The detail view has its own code button with the same `title`.
- Copy fails silently (no pill) without clipboard permission; the driver grants it.
- The feed caches in IndexedDB; a 本地缓存 badge means the rows came from cache, not
  the Worker. Clear with `title="清除本地缓存并重新加载"` (desktop) or MoreMenu
  重置本地缓存 (mobile) before asserting on fresh data.
- New rows are highlighted for 10s; don't assert on the highlight class.
- A sent row added by the composer labels its SIM by ICCID tail (`00000002`) rather
  than `S02` until the feed reloads; seeded sent rows show `S02`.
