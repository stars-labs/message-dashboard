import { callCompanyAI } from '../../server/utils/company-ai.js';

function required(input) {
  return ['aiBaseUrl', 'aiModel', 'aiProtocol', 'aiToken'].filter((key) => !input[key]);
}

// Extract the API's own error message from the thrown error string, which has
// the form "Company AI request failed (401): <body up to 500 chars>".
function extractApiDetail(message) {
  const match = message.match(/\(\d+\):\s*(.+)$/s);
  return match ? match[1].trim() : null;
}

export function describeAIConnectionError(error) {
  const message = String(error?.message || error || 'Unknown error');
  const detail = extractApiDetail(message);
  if (/\b(401|403)\b/.test(message)) {
    return detail ? `认证失败：${detail}` : '认证失败，请检查 AI token';
  }
  if (/\b404\b/.test(message)) return '接口不存在，请检查 AI URL 和协议';
  if (/abort|timeout|fetch failed|network|ENOTFOUND|ECONN/i.test(message)) {
    return '无法连接公司 AI，请确认 VPN 和 AI URL';
  }
  if (/valid JSON|message content/i.test(message)) return 'AI 已响应，但返回格式不兼容';
  return `测试失败：${message}`;
}

export async function testAIConnection(
  input,
  { callAI = callCompanyAI, now = Date.now, logger = console } = {},
) {
  const configuration = Object.fromEntries(
    Object.entries(input || {}).map(([key, value]) => [key, String(value || '').trim()]),
  );
  const missing = required(configuration);
  if (missing.length) {
    return { ok: false, message: `请先填写：${missing.join(', ')}` };
  }

  logger.info(
    `[ai-connection] test url=${configuration.aiBaseUrl} model=${configuration.aiModel}`
    + ` protocol=${configuration.aiProtocol}`,
  );

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
      logger.warn('[ai-connection] unexpected response payload', response);
      return { ok: false, message: 'AI 已响应，但测试结果不符合预期' };
    }
    const latencyMs = Math.max(0, now() - startedAt);
    logger.info(`[ai-connection] test ok latency=${latencyMs}ms`);
    return { ok: true, latencyMs, message: '连接成功' };
  } catch (error) {
    logger.error(`[ai-connection] test failed: ${error.message}`);
    return { ok: false, message: describeAIConnectionError(error) };
  }
}
