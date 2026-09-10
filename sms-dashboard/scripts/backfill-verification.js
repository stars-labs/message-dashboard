// Backfill runner for stored verification codes.
//
// Drives POST /api/verification/reprocess across every page of received
// messages until the cursor is exhausted. That endpoint recomputes each row's
// verification_code with the *currently deployed* detection rules and only
// writes rows whose code changed, so running it after deploying Japanese OTP
// support retroactively flags the Japanese messages that were missed.
//
// The script always DRY-RUNS first (no writes), prints the per-page progress,
// then a totals table and sample changes. It only writes after you confirm the
// dry-run output in a browser dialog.
//
// HOW TO RUN:
//   1. Deploy first so production has the new detection rules:
//        cd sms-dashboard && bun run deploy
//   2. Log into https://sexy.itoken.world
//   3. Open DevTools (Cmd+Option+J) on that tab and paste this whole file.
//   4. Read the totals table. If `added`/`replaced` look right (e.g. the
//      Amazon コード / ワンタイムパスワード messages now show codes), click OK
//      on the dialog to apply. Click Cancel to stop and inspect further.
//
// Safe to re-paste: the whole body runs inside one async IIFE, so nothing leaks
// into the console's global scope and a second paste starts fresh.
(async () => {
  const PAGE = 500; // server caps page size at 500

  async function reprocess(dryRun) {
    const params = new URLSearchParams({ limit: String(PAGE) });
    if (dryRun) params.set('dry_run', '1');

    const totals = { processed: 0, changed: 0, removed: 0, added: 0, replaced: 0 };
    const samples = [];
    let cursor = 0;

    for (;;) {
      params.set('after', String(cursor));
      const resp = await fetch(`/api/verification/reprocess?${params}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${body}`);
      }
      const page = await resp.json();
      for (const key of ['processed', 'changed', 'removed', 'added', 'replaced']) {
        totals[key] += page[key] ?? 0;
      }
      samples.push(...(page.samples || []));
      console.log(
        `[${dryRun ? 'dry-run' : 'WRITE'}] cursor=${cursor} ` +
          `processed=${page.processed} changed=${page.changed} ` +
          `added=${page.added} replaced=${page.replaced} done=${page.done}`
      );
      if (page.done) break;
      cursor = page.next_cursor;
    }
    return { totals, samples };
  }

  const preview = await reprocess(true);
  console.log('=== DRY-RUN totals ===');
  console.table(preview.totals);
  console.log(`Sample changes (${preview.samples.length} shown):`);
  console.table(preview.samples);

  const proceed = confirm(
    `Dry-run would change ${preview.totals.changed} stored message(s) ` +
      `(added ${preview.totals.added}, replaced ${preview.totals.replaced}). Apply now?`
  );
  if (!proceed) {
    console.log('Skipped write pass. Re-paste after inspecting the dry-run output.');
    return;
  }

  const applied = await reprocess(false);
  console.log('=== WRITE totals ===');
  console.table(applied.totals);
  console.log(`Sample changes (${applied.samples.length} shown):`);
  console.table(applied.samples);
  console.log('Done — codes applied. Re-paste to verify nothing is left to change.');
})();