// Feed: tapping a verification code copies it and says so (dashboard-message-feed).
import * as v from 'valibot';
import type { Journey } from '../journey.ts';

/** e2e-msg-1 in scripts/e2e/seed.sql. */
const CODE = '482913';

const journey: Journey = async ({ stack, page, evidence }) => {
  const feed = await page('desktop');
  await feed.goto(`${stack.baseUrl}/#dashboard`);
  await feed.getByRole('button', { name: CODE, exact: true }).click();

  const toast = feed.getByRole('status').filter({ hasText: CODE });
  await toast.waitFor({ timeout: 5_000 });
  const clipboard = v.parse(v.string(), await feed.evaluate('navigator.clipboard.readText()'));
  if (clipboard !== CODE) throw new Error(`the clipboard holds "${clipboard}", not ${CODE}`);

  await evidence('copied-code', { clicked: CODE, toast: await toast.innerText(), clipboard });
};

export default journey;
