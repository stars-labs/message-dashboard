import * as v from 'valibot';
import { bodyObject } from './body.js';
import { RUNNER_ID_REQUIRED } from './runner-jobs.js';

const BalanceSkillConfig = v.object({
  id: v.string(),
  version: v.string(),
  objective: v.string(),
  confidence_threshold: v.number(),
  max_turns: v.number(),
  allowed_currencies: v.array(v.string()),
  forbidden_intents: v.array(v.string()),
});

const BalanceMenuOption = v.object({ value: v.string(), label: v.string() });

export const BalanceSkillJob = v.object({
  id: v.string(),
  check_id: v.string(),
  step_index: v.number(),
  attempts: v.number(),
  skill: BalanceSkillConfig,
  menu_options: v.array(BalanceMenuOption),
  response_content: v.string(),
});

export type BalanceSkillJob = v.InferOutput<typeof BalanceSkillJob>;

const DECISION_REQUIRED = 'runner_id and decision are required';

/** The decision is the validator's to judge. */
export const SkillDecisionBody = bodyObject(
  {
    runner_id: v.string(DECISION_REQUIRED),
    decision: v.pipe(
      v.unknown(),
      v.check((decision) => Boolean(decision), DECISION_REQUIRED),
    ),
    model: v.nullish(v.string('model must be text')),
  },
  { runner_id: DECISION_REQUIRED },
  DECISION_REQUIRED,
  DECISION_REQUIRED,
);

export const SkillDecisionResponse = v.union([
  v.object({
    status: v.literal(202),
    body: v.object({
      success: v.literal(true),
      action: v.literal('reply'),
      status: v.literal('queued'),
    }),
  }),
  v.object({
    status: v.literal(200),
    body: v.union([
      v.object({
        success: v.literal(true),
        action: v.literal('complete'),
        status: v.literal('parsed'),
      }),
      v.object({ success: v.literal(true), action: v.literal('stop'), reason: v.string() }),
    ]),
  }),
]);

export type SkillDecisionResponse = v.InferOutput<typeof SkillDecisionResponse>;

export const SkillReleaseBody = bodyObject(
  {
    runner_id: v.string(RUNNER_ID_REQUIRED),
    error: v.nullish(v.string('error must be text')),
  },
  { runner_id: RUNNER_ID_REQUIRED },
  RUNNER_ID_REQUIRED,
  RUNNER_ID_REQUIRED,
);
