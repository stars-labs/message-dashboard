import { join } from 'node:path';
import type { Page } from 'playwright-core';
import * as v from 'valibot';
import type { Journey } from '../journey.ts';

const Width = v.object({ required: v.number(), available: v.number() });
const Chips = v.array(v.object({ label: v.string(), lines: v.number() }));

async function placeholderWidth(page: Page, label: string) {
  const selector = JSON.stringify(`input[aria-label="${label}"]`);
  const measured: unknown = await page.evaluate(`(async () => {
    const element = document.querySelector(${selector});
    if (!(element instanceof HTMLInputElement)) throw new Error('Expected a search input');
    await document.fonts.ready;
    const style = getComputedStyle(element);
    const placeholder = getComputedStyle(element, '::placeholder');
    const measure = document.createElement('span');
    measure.style.position = 'absolute';
    measure.style.visibility = 'hidden';
    measure.style.whiteSpace = 'pre';
    measure.style.font = placeholder.font;
    measure.style.letterSpacing = placeholder.letterSpacing;
    measure.textContent = element.placeholder;
    document.body.append(measure);
    const required = measure.getBoundingClientRect().width;
    measure.remove();
    return {
      required,
      available:
        element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    };
  })()`);
  return v.parse(Width, measured);
}

const journey: Journey = async ({ stack, page, out, evidence }) => {
  const desktop = await page('desktop');
  await desktop.goto(`${stack.baseUrl}/#balances`);
  const search = desktop.getByRole('searchbox', { name: '搜索 SIM' });
  await search.waitFor();
  const balanceSearch = await placeholderWidth(desktop, '搜索 SIM');
  const chipLayout: unknown = await desktop.evaluate(`(() => {
    const element = document.querySelector('input[aria-label="搜索 SIM"]');
    if (!element) throw new Error('Expected the balance search input');
    const filterBar = element.parentElement?.parentElement;
    return [...(filterBar?.querySelectorAll('button') ?? [])].map((button) => {
      const range = document.createRange();
      range.selectNodeContents(button);
      return {
        label: button.textContent.trim(),
        lines: new Set(Array.from(range.getClientRects(), ({ top }) => top)).size,
      };
    });
  })()`);
  const chips = v.parse(Chips, chipLayout);
  await desktop.screenshot({ path: join(out, 'balances-desktop.png') });

  const mobile = await page('mobile');
  await mobile.goto(`${stack.baseUrl}/#balances`);
  const mobileSearch = mobile.getByRole('searchbox', { name: '搜索 SIM' });
  await mobileSearch.waitFor();
  const mobileBalanceSearch = await placeholderWidth(mobile, '搜索 SIM');
  await mobile.screenshot({ path: join(out, 'balances-mobile.png') });

  await desktop.getByRole('button', { name: /^通话/ }).click();
  const call = desktop.getByRole('dialog', { name: '语音通话' });
  await call.getByRole('textbox', { name: '搜索拨出卡' }).waitFor();
  const callSearch = await placeholderWidth(desktop, '搜索拨出卡');
  await desktop.screenshot({ path: join(out, 'call-desktop.png') });
  const widths = { balanceSearch, mobileBalanceSearch, callSearch };
  await evidence('search-layout', { widths, chips });

  for (const [name, { required, available }] of Object.entries(widths)) {
    if (required <= 0 || available < required) {
      throw new Error(
        `${name}: placeholder needs ${String(required)}px, has ${String(available)}px`,
      );
    }
  }
  if (chips.length === 0 || chips.some(({ lines }) => lines !== 1)) {
    throw new Error(`Balance filter labels wrapped: ${JSON.stringify(chips)}`);
  }
};

export default journey;
