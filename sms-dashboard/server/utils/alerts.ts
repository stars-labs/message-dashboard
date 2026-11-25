import { errorText } from '../../shared/error-text.js';
import type { D1 } from '../lib/d1.js';
import type { KV } from '../lib/kv.js';
import {
  closeAlert,
  markAlertNotified,
  openAlert,
  readAlertState,
  readLastHeartbeat,
} from '../db/alerts.js';

const MINUTE_MS = 60_000;
const DAEMON_SILENCE_MS = 20 * MINUTE_MS;
const REMINDER_MS = 6 * 60 * MINUTE_MS;
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
  db: D1<'first' | 'run'>;
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

  try {
    const heartbeat = await readLastHeartbeat(db);
    const silentMs = heartbeat === null ? 0 : now - sqlTimestampMs(heartbeat);
    const state = await readAlertState(db, 'daemon_offline');
    const at = new Date(now).toISOString();

    if (silentMs <= DAEMON_SILENCE_MS) {
      if (state === null) return;
      await closeAlert(db, 'daemon_offline');
      if (state.notified_at !== null) {
        await deliver({
          subject: '[SMS 恢复] 采集服务已恢复心跳',
          text: `采集服务又开始上报心跳了。\n\n${DASHBOARD_URL}`,
        });
      }
      return;
    }

    const due = state?.notified_at == null || now - Date.parse(state.notified_at) >= REMINDER_MS;
    if (!due) return;
    const sent = await deliver({
      subject: `[SMS 告警] 采集服务 ${String(Math.floor(silentMs / MINUTE_MS))} 分钟没有心跳`,
      text: `Orange Pi 上的采集服务最后一次心跳在 ${heartbeat ?? ''} (UTC)。\n收不到短信、发不出短信，直到它恢复。\n\n${DASHBOARD_URL}`,
    });
    if (state === null) await openAlert(db, 'daemon_offline', at, sent ? at : null);
    else if (sent) await markAlertNotified(db, 'daemon_offline', at);
  } catch (error) {
    console.error('[alerts] check failed:', error);
    if ((await kv.get(CHECK_FAILED_KEY)) !== null) return;
    const sent = await deliver({
      subject: '[SMS 告警] 告警检查失败',
      text: `告警检查本身失败了，采集服务目前无人监控：\n\n${errorText(error)}\n\n${DASHBOARD_URL}`,
    });
    if (sent) {
      await kv.put(CHECK_FAILED_KEY, new Date(now).toISOString(), {
        expirationTtl: REMINDER_MS / 1000,
      });
    }
  }
}
