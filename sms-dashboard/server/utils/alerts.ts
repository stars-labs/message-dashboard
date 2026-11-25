import { formatCardNumber } from '../../shared/card-number.js';
import { errorText } from '../../shared/error-text.js';
import type { D1 } from '../lib/d1.js';
import type { KV } from '../lib/kv.js';
import {
  closeAlert,
  listOfflineAssignedSims,
  markAlertNotified,
  openAlert,
  readAlertState,
  readLastHeartbeat,
  type AlertName,
} from '../db/alerts.js';

const MINUTE_MS = 60_000;
const DAEMON_SILENCE_MS = 20 * MINUTE_MS;
const SIM_OUTAGE_MS = 30 * MINUTE_MS;
const REMINDER_MS = 6 * 60 * MINUTE_MS;
// The cron fires every 5 minutes; the SIM check reads device_view, so it runs every 15
// to keep D1 row reads small on the free plan.
const SIM_CHECK_MINUTES = 15;
const CHECK_FAILED_KEY = 'alert:check_failed';
const SENDER = { name: 'SMS Dashboard', email: 'noreply@alerts.itoken.world' };
const DASHBOARD_URL = 'https://sexy.itoken.world';

export interface AlertEmail {
  from: { name: string; email: string };
  to: string[];
  subject: string;
  text: string;
}

export interface AlertMailer {
  send(email: AlertEmail): Promise<unknown>;
}

interface Message {
  subject: string;
  text: string;
}

interface AlertChecks {
  db: D1<'first' | 'all' | 'run'>;
  kv: KV<'get' | 'put'>;
  mail: AlertMailer | undefined;
  recipients: string[] | undefined;
  now: number;
}

function sqlTimestampMs(value: string): number {
  return Date.parse(`${value.replace(' ', 'T')}Z`);
}

export async function runAlertChecks({ db, kv, mail, recipients, now }: AlertChecks) {
  const deliver = async (message: Message): Promise<boolean> => {
    if (mail === undefined || recipients === undefined || recipients.length === 0) {
      console.error(`[alerts] not sent, no recipients configured: ${message.subject}`);
      return false;
    }
    await mail.send({ from: SENDER, to: recipients, ...message });
    return true;
  };

  const track = async (
    alert: AlertName,
    holds: boolean,
    holdFor: number,
    raised: () => Message,
    cleared: Message,
  ) => {
    const state = await readAlertState(db, alert);
    const at = new Date(now).toISOString();
    if (!holds) {
      if (state === null) return;
      await closeAlert(db, alert);
      if (state.notified_at !== null) await deliver(cleared);
      return;
    }
    if (state === null) {
      const notified = holdFor === 0 && (await deliver(raised()));
      await openAlert(db, alert, at, notified ? at : null);
      return;
    }
    const due =
      state.notified_at === null
        ? now - Date.parse(state.first_seen_at) >= holdFor
        : now - Date.parse(state.notified_at) >= REMINDER_MS;
    if (due && (await deliver(raised()))) await markAlertNotified(db, alert, at);
  };

  try {
    const heartbeat = await readLastHeartbeat(db);
    const silentMs = heartbeat === null ? 0 : now - sqlTimestampMs(heartbeat);
    await track(
      'daemon_offline',
      silentMs > DAEMON_SILENCE_MS,
      0,
      () => ({
        subject: `[SMS 告警] 采集服务 ${String(Math.floor(silentMs / MINUTE_MS))} 分钟没有心跳`,
        text: `Orange Pi 上的采集服务最后一次心跳在 ${heartbeat ?? ''} (UTC)。\n收不到短信、发不出短信，直到它恢复。\n\n${DASHBOARD_URL}`,
      }),
      {
        subject: '[SMS 恢复] 采集服务已恢复心跳',
        text: `采集服务又开始上报心跳了。\n\n${DASHBOARD_URL}`,
      },
    );

    if (new Date(now).getUTCMinutes() % SIM_CHECK_MINUTES !== 0) return;
    const sims = await listOfflineAssignedSims(db);
    await track(
      'sims_offline',
      sims.length > 0,
      SIM_OUTAGE_MS,
      () => ({
        subject: `[SMS 告警] ${String(sims.length)} 张卡不在线：${sims.map((sim) => formatCardNumber(sim.sim_index)).join('、')}`,
        text: `以下已分配到 modem 的卡超过 30 分钟不在线：\n\n${sims
          .map((sim) => `${formatCardNumber(sim.sim_index)} ${sim.sim_status}`)
          .join('\n')}\n\n${DASHBOARD_URL}/#iccid-mappings`,
      }),
      {
        subject: '[SMS 恢复] 所有已分配的卡都已在线',
        text: `已分配的卡都重新在线了。\n\n${DASHBOARD_URL}`,
      },
    );
  } catch (error) {
    console.error('[alerts] check failed:', error);
    if ((await kv.get(CHECK_FAILED_KEY)) !== null) return;
    const sent = await deliver({
      subject: '[SMS 告警] 告警检查失败',
      text: `告警检查本身失败了，采集服务和卡的状态目前无人监控：\n\n${errorText(error)}\n\n${DASHBOARD_URL}`,
    });
    if (sent) {
      await kv.put(CHECK_FAILED_KEY, new Date(now).toISOString(), {
        expirationTtl: REMINDER_MS / 1000,
      });
    }
  }
}
