import * as v from 'valibot';

/** What a job route answers when it cannot tell which runner is asking. */
export const RUNNER_ID_REQUIRED = 'runner_id is required';

/** ?runner_id= on a claim: the runner taking the lease, 1 to 200 characters once trimmed. */
export const RunnerIdQuery = v.object({
  runner_id: v.pipe(
    v.optional(v.string(RUNNER_ID_REQUIRED), ''),
    v.trim(),
    v.minLength(1, RUNNER_ID_REQUIRED),
    v.maxLength(200, RUNNER_ID_REQUIRED),
  ),
});

/** /jobs/{id}/…: the job a runner acts on. */
export const JobParams = v.object({ id: v.string() });
