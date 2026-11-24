import type { D1, D1Batch } from '../lib/d1.js';
import { listReceivedMessagesAfter, updateVerificationCodes } from '../db/messages.js';
import { extractVerificationCode } from './verification.js';
import { FILTER_STATUS } from './spam-filter.js';

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;
const SAMPLE_LIMIT = 12;

interface CodeChange {
  id: string;
  previous: string | null;
  next: string | null;
}

interface VerificationPage {
  processed: number;
  changed: number;
  removed: number;
  added: number;
  replaced: number;
  next_cursor: number;
  done: boolean;
  dry_run: boolean;
  samples: CodeChange[];
}

function normaliseCode(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Stateless: the caller owns the cursor and passes next_cursor into the next request. */
export async function reprocessVerificationPage(
  db: D1<'all' | 'run'> & D1Batch<'all' | 'run'>,
  {
    after = 0,
    pageSize = DEFAULT_PAGE_SIZE,
    dryRun = false,
  }: {
    after?: unknown;
    pageSize?: unknown;
    dryRun?: boolean;
  } = {},
): Promise<VerificationPage> {
  const cursor = Number.isSafeInteger(Number(after)) && Number(after) >= 0 ? Number(after) : 0;
  const boundedPageSize = Math.min(
    Math.max(Number.parseInt(String(pageSize), 10) || DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE,
  );

  const results = await listReceivedMessagesAfter(db, cursor, boundedPageSize);

  const changes: CodeChange[] = [];
  for (const row of results) {
    const previous = normaliseCode(row.verification_code);
    const next = extractVerificationCode(row.content);
    if (previous !== next) {
      changes.push({ id: row.id, previous, next });
    }
  }

  if (!dryRun && changes.length > 0) {
    await updateVerificationCodes(
      db,
      changes.map((change) => ({ id: change.id, code: change.next })),
      FILTER_STATUS.PENDING,
    );
  }

  const lastRow = results.at(-1);
  return {
    processed: results.length,
    changed: changes.length,
    removed: changes.filter((change) => change.previous && !change.next).length,
    added: changes.filter((change) => !change.previous && change.next).length,
    replaced: changes.filter((change) => change.previous && change.next).length,
    next_cursor: lastRow?.row_cursor ?? cursor,
    done: results.length < boundedPageSize,
    dry_run: dryRun,
    samples: changes.slice(0, SAMPLE_LIMIT),
  };
}
