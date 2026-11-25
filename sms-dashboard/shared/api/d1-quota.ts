import * as v from 'valibot';

export const D1QuotaExceeded = v.object({
  code: v.literal('D1_QUOTA_EXCEEDED'),
  quota: v.picklist(['rows_read', 'rows_written']),
  retry_at: v.pipe(v.string(), v.isoTimestamp()),
  timestamp: v.pipe(v.string(), v.isoTimestamp()),
});

export type D1QuotaExceeded = v.InferOutput<typeof D1QuotaExceeded>;
