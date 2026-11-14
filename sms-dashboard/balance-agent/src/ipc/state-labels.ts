import type { AgentState } from './contract.js';

export const STATE_LABELS: Readonly<Record<AgentState['auth'] | AgentState['smsAi'], string>> =
  Object.freeze({
    signed_out: '未登录',
    authorizing: '等待授权',
    signed_in: '已连接',
    stopped: '已停止',
    starting: '启动中',
    ready: '就绪',
    busy: '查询中',
    degraded: '连接异常',
    configuration_required: '待配置',
    stopping: 'stopping',
  });
