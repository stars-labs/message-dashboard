# Send SMS

Compose an SMS from one of our SIMs. The Worker only queues it: it writes a `messages`
row (`type='sent'`, `status='sending'`) that the Orange Pi daemon polls through
`/api/control/pending-sms`. Locally there is no daemon, so nothing is sent and the row
stays `sending`.

## Sub-features

- sending SIM: searchable picker, 可用发送卡（n）, only `active` SIMs.
- recipient: country code (default `+65`, or 无区号) plus number, with a history
  dropdown; the Worker normalizes it (`91234567` → `+6591234567`).
- templates: 验证码模板 / 通知模板 / 提醒模板 / 营销模板.
- text: 短信内容, with a 字数 counter out of 500.
- submit: 发送短信 → 已提交，等待发送 for 2s, text cleared, a 等待发送 row at the top of
  the feed.
- errors: empty fields → 请填写完整信息; Worker refusal → toast `发送失败: …`
  (`role=alert`) and 提交失败，请先查看发送记录.

## How to get to it (user POV)

- Desktop below 1536px: header button 发送短信 opens a drawer on the right.
- Desktop 1536px and up: the composer sits in a third column on 消息.
- Mobile: tab 发送 (`#send`), a full page with the same fields.

Selecting a SIM in the feed's SIM list pre-fills the sending SIM.

## Driving it with bun run verify

```ts
const p = await page('desktop'); // 1440px: drawer
await p.goto(`${stack.baseUrl}/#dashboard`);
await p.getByRole('button', { name: '发送短信' }).first().click();
const drawer = p.getByRole('button', { name: '关闭发送短信' }).locator('xpath=../..');
await drawer.getByPlaceholder('卡号 / 号码 / 运营商 / ICCID').click();
await drawer.getByRole('button', { name: /S02/ }).click();
await drawer.getByPlaceholder('输入手机号或短号…').fill('91234567');
await drawer.getByPlaceholder('输入短信内容…').fill('verify send');
await drawer.getByRole('button', { name: '发送短信', exact: true }).click();
await drawer.getByText('已提交，等待发送').waitFor();
await evidence('sent', await stack.d1(
  "SELECT id, phone_iccid, recipient, status, type FROM messages WHERE content = 'verify send'",
)); // one row: S02's ICCID, '+6591234567', 'sending', 'sent'
```

Proof: the 已提交 state, the 等待发送 feed row, and the D1 row.

## Gotchas

- Scope everything to the drawer and select fields by placeholder. At 1440px two
  composers are mounted (the drawer and the hidden 1536px column) with the same ids,
  so `getByLabel('发送卡')` and `#sim-selection` resolve outside the drawer
  ([GRA-227](https://linear.app/gray-arrow/issue/GRA-227)).
- The drawer's backdrop covers the page and swallows clicks. Close it (`关闭发送短信`)
  before driving anything else. Nav buttons close it; `page.goto` does not.
- Only S01 and S02 are offered: S03's modem is disconnected, so it is not `active`.
- Delivery (`processing` → `sent` / `failed`) needs the daemon; drive it with the
  daemon contract journeys, not here.
- The mobile page keeps a draft in sessionStorage and recipients in localStorage;
  each run starts with empty storage.
