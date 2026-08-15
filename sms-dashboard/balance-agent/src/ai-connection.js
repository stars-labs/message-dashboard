import { callCompanyAI } from '../../server/utils/company-ai.js';

function required(input) {
  return ['aiBaseUrl', 'aiModel', 'aiProtocol', 'aiToken'].filter((key) => !input[key]);
}

export function describeAIConnectionError(error) {
  const message = String(error?.message || error || 'Unknown error');
  if (/\b(401|403)\b/.test(message)) return '认证失败，请检查 AI token';
  if (/\b404\b/.test(message)) return '接口不存在，请检查 AI URL 和协议';
  if (/abort|timeout|fetch failed|network|ENOTFOUND|ECONN/i.test(message)) {
    return '无法连接公司 AI，请确认 VPN 和 AI URL';
  }
  if (/valid JSON|message content/i.test(message)) return 'AI 已响应，但返回格式不兼容';
  return `测试失败：${message}`;
}

export async function testAIConnection(input, { callAI = callCompanyAI, now = Date.now } = {}) {
  const configuration = Object.fromEntries(
    Object.entries(input || {}).map(([key, value]) => [key, String(value || '').trim()]),
  );
  const missing = required(configuration);
  if (missing.length) {
    return { ok: false, message: `请先填写：${missing.join(', ')}` };
  }

  const startedAt = now();
  try {
    const response = await callAI({
      baseUrl: configuration.aiBaseUrl,
      token: configuration.aiToken,
      model: configuration.aiModel,
      protocol: configuration.aiProtocol,
      prompt: {
        system: 'Return only a JSON object. Do not include markdown.',
        user: 'Return exactly {"ok":true}.',
      },
    });
    if (response?.ok !== true) {
      return { ok: false, message: 'AI 已响应，但测试结果不符合预期' };
    }
    return {
      ok: true,
      latencyMs: Math.max(0, now() - startedAt),
      message: '连接成功',
    };
  } catch (error) {
    return { ok: false, message: describeAIConnectionError(error) };
  }
}
