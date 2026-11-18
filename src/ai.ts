export class AiRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiRequestError';
  }
}

export interface AiSettings {
  baseURL: string;
  model: string;
  apiKey: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function missingConfigMessage(part: { baseURL?: string; model?: string; apiKey?: string }): string {
  const missing: string[] = [];
  if (!part.baseURL?.trim()) {
    missing.push('设置 vscode-debugger-view.baseURL');
  }
  if (!part.model?.trim()) {
    missing.push('设置 vscode-debugger-view.model');
  }
  if (!part.apiKey?.trim()) {
    missing.push('设置 vscode-debugger-view.apiKey');
  }
  if (!missing.length) {
    return '';
  }
  return `未配置 AI，无法生成讲解。请补全：${missing.join('；')}。`;
}

export function resolveChatUrl(baseURL: string): string {
  const trimmed = baseURL.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) {
    return trimmed;
  }
  if (trimmed.endsWith('/v1')) {
    return `${trimmed}/chat/completions`;
  }
  return `${trimmed}/v1/chat/completions`;
}

export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  const values = [...secrets].filter(secret => secret && secret.length >= 4).sort((a, b) => b.length - a.length);
  for (const secret of values) {
    out = out.split(secret).join('[redacted]');
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer [redacted]');
  out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]');
  return out;
}

export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^﻿/, '');
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : trimmed).trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(body.slice(start, end + 1));
    }
    throw new AiRequestError('讲解请求失败：无法解析模型输出的 JSON');
  }
}

export async function chatComplete(options: {
  settings: AiSettings;
  messages: ChatMessage[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<string> {
  const url = resolveChatUrl(options.settings.baseURL);
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 25000);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.settings.apiKey}`,
      },
      body: JSON.stringify({
        model: options.settings.model,
        temperature: 0.2,
        stream: false,
        messages: options.messages,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AiRequestError(`讲解请求失败：${redactSecrets(message, [options.settings.apiKey])}`);
  } finally {
    clearTimeout(timer);
  }
  const raw = await response.text();
  const safeBody = redactSecrets(raw.slice(0, 500), [options.settings.apiKey]);
  if (!response.ok) {
    throw new AiRequestError(`讲解请求失败：HTTP ${response.status} ${safeBody}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new AiRequestError('讲解请求失败：响应不是 JSON');
  }
  const content = (data as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) {
    return content;
  }
  if (content && typeof content === 'object') {
    return JSON.stringify(content);
  }
  throw new AiRequestError('讲解请求失败：响应缺少 choices[0].message.content');
}
