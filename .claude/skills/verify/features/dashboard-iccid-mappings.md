# SIM inventory (ICCID mappings)

`#iccid-mappings`, 设备与卡 · ICCID 映射: the user's SIM inventory, the `sims` table,
joined to the live modem through `device_view`. Needs `phones.write`.

## Sub-features

- list: one row per SIM, secondaries indented under their primary; columns 卡号,
  手机号, ICCID, 运营商, 计费类型, 主副卡, 模块位置, 信号, 状态, 余额阈值, 备注, 操作.
- filters: chips 全部 / 在线 / 异常 / 待映射 with counts, `运营商筛选` select, search
  `卡号 / 号码 / 运营商 / ICCID`.
- sort: column headers, `aria-label="按<列>升序排列"`.
- edit: 编辑 opens `编辑映射` (role=dialog); 保存 writes the SIM.
- add: 添加映射 opens `添加映射` with an ICCID field.
- delete: 删除映射 in the edit dialog, behind a 请确认 dialog.
- from the feed: 映射 on an unmapped SIM opens `设置 ICCID 映射`.

## How to get to it (user POV)

Desktop: nav 设备与卡. Mobile: tab 设备 (cards instead of a table; edit is an icon
button `aria-label="编辑"`). Also from the 处理 → link in the stats bar and 查看详情 on
the yellow card-error banner.

## Driving it with bun run verify

```ts
const p = await page('desktop');
await p.goto(`${stack.baseUrl}/#iccid-mappings`);
await p.getByText('设备与卡 · ICCID 映射').waitFor();
await p.getByRole('row').filter({ hasText: '+6580000002' })
  .getByRole('button', { name: '编辑' }).click();
const dialog = p.getByRole('dialog', { name: '编辑映射' });
await dialog.getByLabel('备注（可选）').fill('verify edit');
await dialog.getByRole('button', { name: '保存' }).click();
await dialog.waitFor({ state: 'hidden' });
await evidence('sim', await stack.d1(
  "SELECT sim_index, notes, updated_by FROM sims WHERE phone_number = '+6580000002'",
)); // notes 'verify edit', updated_by 'auth0-e2e-admin@example.test'
```

Proof: the dialog closes, the row shows the new value, and the `sims` row has it with
`updated_by` set. Reload (`p.reload()`) to prove it persisted.

## Gotchas

- No toast on success; failures show inline in the dialog (保存失败, 请输入卡号,
  请输入电话号码). 保存 stays disabled until 手机号 is filled.
- `sims.service_type` is operator-verified: setting 计费类型 to prepaid or postpaid
  requires 确认来源. Never infer it in a journey from ICCID or carrier.
- Card numbers render through the S-index formatter (`S02`, `—` when unset); assert on
  that text, not the raw `sim_index`.
- Deleting a primary that still has secondaries answers 409, shown inline.
- Seed state: S03 is 异常 (modem disconnected), so the 异常 chip counts 1.
