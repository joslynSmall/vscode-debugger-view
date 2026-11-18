import { chatComplete, parseJsonObject, type AiSettings } from './ai';
import { baseName, formatStack, funcKey, type CallSite, type Frame, type FuncRef, type HistoryEntry, type Target } from './model';

export interface StructuredExplanation {
  summary: string;
  purpose: string;
  params: string;
  logic: string;
  whyHere: string;
  snippet: string;
  fromAi: boolean;
  error?: string;
}

export interface CandidateView {
  name: string;
  file: string;
  line: number;
  detail: string;
  thirdParty: boolean;
}

export function thirdPartyLine(name: string): string {
  return `${name} 来自第三方库，默认不进入，只作一句话说明。可在面板手动进入。`;
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+$/g, '');
  return clean.length > max ? `${clean.slice(0, max)}\n…` : clean;
}

function field(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const text = value.map(item => field(item, '')).filter(Boolean).join('；');
    return text || fallback;
  }
  if (value && typeof value === 'object') {
    const text = Object.entries(value as Record<string, unknown>).map(([key, item]) => `${key}：${field(item, '')}`).filter(item => !item.endsWith('：')).join('；');
    return text || fallback;
  }
  return fallback;
}

function signatureOf(func: FuncRef): string {
  return func.detail?.trim() || `暂无签名，见 ${baseName(func.fsPath)}:${func.range.start.line + 1}`;
}

export function fallbackExplanation(entry: HistoryEntry, error: string): StructuredExplanation {
  const top = entry.stack[entry.stack.length - 1];
  const site = top.callIndex >= 0 ? top.sites[top.callIndex] : undefined;
  const file = baseName(top.func.fsPath);
  const visit = top.visit > 1 ? `已访问第 ${top.visit} 次。` : '';
  const third = entry.thirdPartyStop && site
    ? site.targets.map(target => thirdPartyLine(target.func.name)).join(' ')
    : '';
  const atCall = site ? `停在调用点 ${file}:${site.from.start.line + 1}，目标 ${site.targets.map(target => target.func.name).join(' / ')}。` : `停在 ${file}:${top.func.range.start.line + 1} 的函数入口。`;
  return {
    summary: `${entry.thirdPartyStop ? '第三方库调用' : top.func.name}（${file}:${(site ?? { from: top.func.range }).from.start.line + 1}）${visit}`,
    purpose: signatureOf(top.func),
    params: signatureOf(top.func),
    logic: third || (site
      ? `当前调用点有 ${site.targets.length} 个目标。本函数还有 ${Math.max(0, top.sites.length - top.callIndex - 1)} 个后续调用点。`
      : `本函数有 ${top.sites.length} 个调用点。`),
    whyHere: atCall,
    snippet: '',
    fromAi: false,
    error,
  };
}

export function promptForExplanation(entry: HistoryEntry, snippet: string): { system: string; user: string } {
  const top = entry.stack[entry.stack.length - 1];
  const site = top.callIndex >= 0 ? top.sites[top.callIndex] : undefined;
  const system = [
    '你在讲解静态源码调用链，不要假装看到了运行时变量。',
    '只返回一个 JSON 对象，不要 markdown，键为 summary、purpose、params、logic、whyHere。',
    'summary 是一句话结论。purpose 是作用。params 是入参和出参。logic 是关键逻辑。whyHere 是为何在此被调用。',
  ].join('');
  const user = [
    `当前函数：${top.func.name}`,
    `文件：${top.func.fsPath}`,
    `签名：${signatureOf(top.func)}`,
    `本帧访问次数：${top.visit}`,
    `是否停在第三方库调用：${entry.thirdPartyStop ? '是' : '否'}`,
    site ? `当前调用点行：${site.from.start.line + 1}` : '当前在函数入口',
    site ? `调用目标：${site.targets.map(target => `${target.func.name}${target.thirdParty ? '(第三方库)' : ''}`).join(', ')}` : '',
    '调用栈（从起点到当前）：',
    formatStack(entry.stack),
    '代码片段：',
    snippet || '（没有代码片段）',
  ].filter(Boolean).join('\n');
  return { system, user };
}

export function mergeExplanation(previous: StructuredExplanation | undefined, next: StructuredExplanation, force: boolean): { explanation: StructuredExplanation; notice?: string } {
  if (previous && !next.fromAi && force) {
    return {
      explanation: { ...previous, error: next.error || '重新请求讲解失败，仍显示上一次讲解。' },
      notice: next.error,
    };
  }
  return { explanation: next, notice: next.fromAi ? undefined : next.error };
}

export async function buildExplanation(options: {
  entry: HistoryEntry;
  snippet: string;
  settings?: AiSettings;
  fetchImpl?: typeof fetch;
}): Promise<StructuredExplanation> {
  const fallback = fallbackExplanation(options.entry, options.settings ? '' : '未配置 AI');
  fallback.snippet = options.snippet;
  if (!options.settings) {
    fallback.error = '未配置 AI，当前显示的是签名和调用点占位，不是模型讲解。';
    return fallback;
  }
  try {
    const prompt = promptForExplanation(options.entry, clip(options.snippet, 1600));
    const content = await chatComplete({
      settings: options.settings,
      fetchImpl: options.fetchImpl,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
    });
    const parsed = parseJsonObject(content) as Record<string, unknown>;
    return {
      summary: field(parsed.summary, fallback.summary),
      purpose: field(parsed.purpose, fallback.purpose),
      params: field(parsed.params, fallback.params),
      logic: field(parsed.logic, fallback.logic),
      whyHere: field(parsed.whyHere, fallback.whyHere),
      snippet: options.snippet,
      fromAi: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = fallbackExplanation(options.entry, message);
    failed.snippet = options.snippet;
    failed.error = message;
    return failed;
  }
}

export async function rankCandidates(options: {
  caller: Frame;
  site: CallSite;
  settings?: AiSettings;
  fetchImpl?: typeof fetch;
}): Promise<{ index: number; reason: string } | undefined> {
  if (!options.settings || options.site.targets.length < 2) {
    return undefined;
  }
  const listed = options.site.targets.map((target, index) => (
    `${index}. ${target.func.name} ${target.func.fsPath}:${target.func.range.start.line + 1} ${target.thirdParty ? '第三方库' : '工作区'} ${signatureOf(target.func)}`
  )).join('\n');
  try {
    const content = await chatComplete({
      settings: options.settings,
      fetchImpl: options.fetchImpl,
      messages: [
        {
          role: 'system',
          content: '给出最可能的实现。只返回 JSON：{"index":数字,"reason":"一句话理由"}。index 必须是候选列表里的下标。',
        },
        {
          role: 'user',
          content: `调用方：${options.caller.func.name} ${options.caller.func.fsPath}\n调用点行：${options.site.from.start.line + 1}\n候选：\n${listed}`,
        },
      ],
    });
    const parsed = parseJsonObject(content) as { index?: unknown; reason?: unknown };
    const index = typeof parsed.index === 'number' ? parsed.index : Number(parsed.index);
    if (!Number.isInteger(index) || index < 0 || index >= options.site.targets.length) {
      return undefined;
    }
    return { index, reason: field(parsed.reason, '模型推荐这个实现') };
  } catch {
    return undefined;
  }
}

export async function answerFollowup(options: {
  question: string;
  entry: HistoryEntry;
  explanation?: StructuredExplanation;
  settings: AiSettings;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const content = await chatComplete({
    settings: options.settings,
    fetchImpl: options.fetchImpl,
    messages: [
      {
        role: 'system',
        content: '根据给出的静态调用栈和当前讲解回答。不要编造运行时变量值。用中文，控制在八句以内。',
      },
      {
        role: 'user',
        content: [
          '调用栈：',
          formatStack(options.entry.stack),
          options.explanation ? `当前讲解：${options.explanation.summary}\n${options.explanation.purpose}` : '',
          `问题：${options.question}`,
        ].filter(Boolean).join('\n'),
      },
    ],
  });
  return content.trim();
}

export function candidateViews(targets: Target[]): CandidateView[] {
  return targets.map(target => ({
    name: target.func.name,
    file: baseName(target.func.fsPath),
    line: target.func.range.start.line + 1,
    detail: signatureOf(target.func),
    thirdParty: target.thirdParty,
  }));
}

export function cacheIdentity(entry: HistoryEntry): string {
  const top = entry.stack[entry.stack.length - 1];
  return `${funcKey(top.func)}#visit${top.visit}`;
}
