import * as v from 'valibot';
import { errorText } from '../../shared/error-text.js';
import type { AiTestResult } from './ipc/contract.js';
import { callCompanyAI, CompanyAIProtocol } from './runner/company-ai.js';

type CompanyAICall = Parameters<typeof callCompanyAI>[0];

export interface AiConnectionInput {
  aiBaseUrl?: string | null | undefined;
  aiModel?: string | null | undefined;
  aiProtocol?: string | null | undefined;
  aiToken?: string | null | undefined;
}

export interface ConnectionLogger {
  info(message: string): void;
  warn(message: string, detail: unknown): void;
  error(message: string): void;
}

const AiCheckReply = v.looseObject({ ok: v.literal(true) });

function clean(value: string | null | undefined): string {
  return (value ?? '').trim();
}

// Extract the API's own error message from the thrown error string, which has
// the form "Company AI request failed (401): <body up to 500 chars>".
function extractApiDetail(message: string): string | null {
  const match = /\(\d+\):\s*(.+)$/s.exec(message);
  return match?.[1]?.trim() ?? null;
}

export function describeAIConnectionError(error: unknown): string {
  const message = errorText(error);
  const detail = extractApiDetail(message);
  if (/\b401\b/.test(message)) {
    return detail ? `认证失败：${detail}` : '认证失败，请检查 AI token';
  }
  if (/\b403\b/.test(message)) {
    // 403 covers both "wrong token" and "token valid but no model access" —
    // always surface the API's own message so the user knows which it is.
    return detail ? `权限不足：${detail}` : '请求被拒绝，请检查 AI token 和模型权限';
  }
  if (/\b404\b/.test(message)) return '接口不存在，请检查 AI URL 和协议';
  if (/abort|timeout|fetch failed|network|ENOTFOUND|ECONN/i.test(message)) {
    return '无法连接公司 AI，请确认 VPN 和 AI URL';
  }
  if (/valid JSON|message content/i.test(message)) return 'AI 已响应，但返回格式不兼容';
  return `测试失败：${message}`;
}

export async function testAIConnection(
  input: AiConnectionInput,
  {
    callAI = callCompanyAI,
    now = Date.now,
    logger = console,
  }: {
    callAI?: (call: CompanyAICall) => Promise<unknown>;
    now?: () => number;
    logger?: ConnectionLogger;
  } = {},
): Promise<AiTestResult> {
  const aiBaseUrl = clean(input.aiBaseUrl);
  const aiModel = clean(input.aiModel);
  const aiProtocol = clean(input.aiProtocol);
  const aiToken = clean(input.aiToken);
  const missing = [
    ['aiBaseUrl', aiBaseUrl],
    ['aiModel', aiModel],
    ['aiProtocol', aiProtocol],
    ['aiToken', aiToken],
  ].flatMap(([key, value]) => (value ? [] : [key]));
  if (missing.length) {
    return { ok: false, message: `请先填写：${missing.join(', ')}` };
  }
  const protocol = v.safeParse(CompanyAIProtocol, aiProtocol);
  if (!protocol.success) return { ok: false, message: 'AI 协议必须是 anthropic 或 openai' };

  logger.info(`[ai-connection] test url=${aiBaseUrl} model=${aiModel} protocol=${aiProtocol}`);

  const startedAt = now();
  try {
    const response = await callAI({
      baseUrl: aiBaseUrl,
      token: aiToken,
      model: aiModel,
      protocol: protocol.output,
      prompt: {
        system: 'Return only a JSON object. Do not include markdown.',
        user: 'Return exactly {"ok":true}.',
      },
    });
    if (!v.is(AiCheckReply, response)) {
      logger.warn('[ai-connection] unexpected response payload', response);
      return { ok: false, message: 'AI 已响应，但测试结果不符合预期' };
    }
    const latencyMs = Math.max(0, now() - startedAt);
    logger.info(`[ai-connection] test ok latency=${latencyMs}ms`);
    return { ok: true, latencyMs, message: '连接成功' };
  } catch (error) {
    logger.error(`[ai-connection] test failed: ${errorText(error)}`);
    return { ok: false, message: describeAIConnectionError(error) };
  }
}
