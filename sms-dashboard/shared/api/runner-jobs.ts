import * as v from 'valibot';

export const RUNNER_ID_REQUIRED = 'runner_id is required';

/** 1 to 200 characters once trimmed. */
export const RunnerIdQuery = v.object({
  runner_id: v.pipe(
    v.optional(v.string(RUNNER_ID_REQUIRED), ''),
    v.trim(),
    v.minLength(1, RUNNER_ID_REQUIRED),
    v.maxLength(200, RUNNER_ID_REQUIRED),
  ),
});

export const JobParams = v.object({ id: v.string() });
