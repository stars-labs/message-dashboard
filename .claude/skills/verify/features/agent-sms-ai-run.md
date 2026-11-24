# Balance Agent: sms-ai capability

When a carrier answers a balance SMS with a menu the parser cannot read, the Worker
creates a skill job. The Balance Agent claims it, asks the company AI which menu option
to reply with (or to complete with a balance, or to stop), and posts the decision; the
Worker validates it and queues the follow-up SMS or records the result.

## Sub-features

- skill job: created when a reply matches no scripted step, the parser finds no
  balance, and the check is still inside its response window and turn limit
  (`server/handlers/balance-replies.ts`).
- claim and decide: `run --capability sms-ai`, `runner/capabilities/sms-ai.ts`.
- decision `reply`: the option must appear in the carrier's menu, be numeric and carry
  no forbidden intent; the Worker queues it as the next SMS.
- decision `complete`: the balance and currency must be within the skill's allowlist
  and match an exact excerpt of the reply.
- decision `stop`, or any decision below the confidence threshold: the check stops.

## How to get to it (user POV)

An operator queues a balance query for a China Mobile or China Unicom SIM (SMS-menu
profiles) and has a signed-in Balance Agent running. Everything after that is
automatic; the result shows in 余额 → 查询记录.

## Driving it with bun run verify

`scripts/verify/journeys/sms-ai-reply.ts` runs the whole loop:

1. `daemon('/api/control/devices', …)` reports S03's modem connected.
2. 设备与卡 → 编辑 S03: 主副卡 独立, 计费类型 预付费, 确认来源 运营商客服.
3. 余额 → reload → 查询 on S03 → 仍然排队.
4. `daemon('/api/control/pending-sms', { sessionId: 'e2e-session' })`, then
   `sms-result` `confirmed`, then `messages` with the carrier's menu from `10086`.
5. Sandboxed CLI: configure, login, `ai.answer({ action: 'reply', selected_option:
   '201', … })`, `run --capability sms-ai --once`.
6. Proof: `sim_balance_skill_jobs.status = 'completed'` and a `messages` row
   `content = '201'`, `status = 'sending'` to 10086.

## Gotchas

- Menu options must each start a line (`\n201.查询话费余额`); one line with spaces
  parses to no options, and the Worker stops the AI's reply ("Selected option is not
  present").
- The seed has no queryable SMS-AI SIM: S03 is a secondary on a disconnected modem, so
  steps 1–2 make it one through production paths. Never write `sims` or `modems` with
  `d1()` to set this up.
- The balance page keeps the SIM list it loaded; after the edit in step 2 it still
  shows S03 as a secondary until reloaded.
- With no agent signed in when the query is queued, the page asks 查询助手未就绪;
  仍然排队 queues it anyway.
- `ai.prompts` holds the exact prompt, including `menu_options` and the carrier text:
  assert on it when changing the prompt builder (`shared/balance-skill.ts`).
