import * as v from 'valibot';

/** A validated balance-skill configuration: the limits the runner holds an AI decision to. */
const BalanceSkillConfig = v.object({
  id: v.string(),
  version: v.string(),
  objective: v.string(),
  confidence_threshold: v.number(),
  max_turns: v.number(),
  allowed_currencies: v.array(v.string()),
  forbidden_intents: v.array(v.string()),
});

/** One numbered option found in a carrier reply. */
const BalanceMenuOption = v.object({ value: v.string(), label: v.string() });

/** GET /api/control/balance-skills/jobs/claim, when a job was leased. */
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
