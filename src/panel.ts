import type { StructuredExplanation } from './explain';
import { entryTitle, type HistoryEntry, type PendingChoice } from './model';

export interface PanelState {
  entries: HistoryEntry[];
  cursor: number;
  explanations: Record<string, StructuredExplanation>;
  keys: string[];
  pending?: PendingChoice;
  notice?: string;
  followups: { question: string; answer: string }[];
  configured: boolean;
}

function briefOf(text: string | undefined): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  return clean || '还没有讲解';
}

export function renderPanel(state: PanelState, esc: (value: string) => string): string {
  const { entries, cursor, explanations, keys, pending, notice, followups, configured } = state;
  const currentEntry = entries[cursor];
  const crumb = currentEntry
    ? `<p class="crumb">${currentEntry.stack.map(frame => esc(frame.func.name)).join('<span> › </span>')}</p>`
    : '';
  const cards = entries.map((entry, index) => {
    const current = index === cursor;
    const explanation = explanations[keys[index]];
    const title = entryTitle(entry);
    const visit = entry.stack[entry.stack.length - 1].visit;
    const depth = Math.max(0, entry.stack.length - 1);
    const body = explanation
      ? `<div>结论：${esc(explanation.summary)}</div>` +
        `<div>作用：${esc(explanation.purpose)}</div>` +
        `<div>入参出参：${esc(explanation.params)}</div>` +
        `<div>关键逻辑：${esc(explanation.logic)}</div>` +
        `<div>为何在此调用：${esc(explanation.whyHere)}</div>` +
        (explanation.error ? `<div class="warn">${esc(explanation.error)}</div>` : '')
      : '<div>还没有讲解</div>';
    const marks = [
      current ? '<i class="badge">当前</i>' : '',
      entry.thirdPartyStop ? '<i class="badge">库</i>' : '',
      visit > 1 ? `<i class="badge">第 ${visit} 次</i>` : '',
    ].join('');
    return `<details class="node${current ? ' current' : ''}" style="--depth:${depth}"${current ? ' open' : ''}>` +
      `<summary><span class="name">${marks}${esc(title)}</span>` +
      `<button type="button" data-jump="${index}">定位</button>` +
      `<span class="brief">${esc(briefOf(explanation?.summary))}</span></summary>` +
      `<div class="body">${body}</div></details>`;
  }).join('') || '<p>尚未开始单步讲解。点函数上方的 CodeLens，或在函数上右键「开始单步讲解」。</p>';
  const choice = pending
    ? `<section><h3>选一个实现</h3>${pending.order.map((original, display) => {
        const target = pending.targets[original];
        const mark = display === 0 && pending.recommended ? '推荐' : `候选 ${display + 1}`;
        return `<button data-pick="${display}">${mark}：${esc(target.func.name)} ${esc(target.func.fsPath.split(/[/\\]/).pop() || '')}:${target.func.range.start.line + 1}${target.thirdParty ? ' · 第三方库' : ''}</button>`;
      }).join('')}${pending.reason ? `<p>${esc(pending.reason)}</p>` : '<p>模型没有给出推荐，请自己选。</p>'}</section>`
    : '';
  const force = currentEntry?.thirdPartyStop ? '<button id="force">手动进入第三方库</button>' : '';
  const asks = followups.map(item => `<div class="ask"><b>问：</b>${esc(item.question)}<br><b>答：</b>${esc(item.answer)}</div>`).join('');
  const config = configured
    ? ''
    : '<p class="warn">未配置 AI。请在设置里填写 Base URL、Model 和 API Key。</p>';
  return `${config}${notice ? `<p class="warn">${esc(notice)}</p>` : ''}${choice}${force}${entries.length ? '<button id="retry">重新请求讲解</button>' : ''}${crumb}<div class="tree">${cards}</div><h3>追问</h3>${asks}<form id="ask"><input name="q" placeholder="结合当前调用栈追问" ${entries.length ? '' : 'disabled'}><button type="submit" ${entries.length ? '' : 'disabled'}>发送</button></form>`;
}

export function panelCommand(message: { type?: string; index?: number; question?: string }): { command: string; args: unknown[] } | undefined {
  if (message.type === 'jump' && typeof message.index === 'number') {
    return { command: 'vscode-debugger-view.jumpToHistory', args: [message.index] };
  }
  if (message.type === 'pick' && typeof message.index === 'number') {
    return { command: 'vscode-debugger-view.pickCandidate', args: [message.index] };
  }
  if (message.type === 'force') {
    return { command: 'vscode-debugger-view.forceInto', args: [] };
  }
  if (message.type === 'retry') {
    return { command: 'vscode-debugger-view.retryExplain', args: [] };
  }
  if (message.type === 'ask' && typeof message.question === 'string') {
    return { command: 'vscode-debugger-view.ask', args: [message.question] };
  }
  return undefined;
}

export interface PanelHost {
  postCommand(command: string, args: unknown[]): void;
  setHtml(html: string): void;
}

export class ExplainPanel {
  static viewId = 'vscode-debugger-view.explain';
  private state: PanelState = { entries: [], cursor: -1, explanations: {}, keys: [], followups: [], configured: false };
  private host?: PanelHost;

  attach(host: PanelHost): void {
    this.host = host;
    this.render();
  }

  receive(message: { type?: string; index?: number; question?: string }): void {
    const action = panelCommand(message);
    if (action) {
      this.host?.postCommand(action.command, action.args);
    }
  }

  show(state: PanelState): void {
    this.state = state;
    this.render();
  }

  private esc(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private render(): void {
    if (!this.host) {
      return;
    }
    const body = renderPanel(this.state, value => this.esc(value));
    this.host.setHtml(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); margin: 0; padding: 12px 12px 20px; line-height: 1.45; }
  h2, h3 { font-size: 13px; font-weight: 600; margin: 14px 0 8px; }
  button, input { font: inherit; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 0; border-radius: 2px; padding: 2px 8px; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .crumb { margin: 0 0 10px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .crumb span { opacity: .7; }
  .tree { display: flex; flex-direction: column; gap: 6px; }
  details.node { margin-left: calc(var(--depth) * 14px); border-left: 2px solid var(--vscode-panel-border, #444); background: var(--vscode-editor-background, transparent); }
  details.current { border-left-color: var(--vscode-focusBorder, #007acc); background: var(--vscode-list-inactiveSelectionBackground, rgba(14,42,58,.45)); }
  summary { display: block; padding: 7px 8px; cursor: pointer; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary .name { font-weight: 600; }
  summary .badge { font-style: normal; margin-right: 4px; padding: 0 4px; border-radius: 3px; font-size: 11px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  summary button { float: right; }
  .brief { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-top: 3px; color: var(--vscode-descriptionForeground); font-size: 12px; }
  details[open] > summary .brief { display: none; }
  .body { padding: 0 8px 8px; }
  pre { white-space: pre-wrap; overflow: auto; max-height: 180px; margin: 8px 0 0; padding: 8px; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.15)); }
  .warn { color: var(--vscode-errorForeground, #f14c4c); }
  .ask { margin: 6px 0; }
  form { display: flex; gap: 6px; }
  input { flex: 1; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 4px 6px; }
</style>
</head>
<body>
<h2>单步讲解</h2>
${body}
<script>
  const vscode = acquireVsCodeApi();
  document.body.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest('button')) { event.preventDefault(); event.stopPropagation(); }
    if (target.dataset.jump) vscode.postMessage({ type: 'jump', index: Number(target.dataset.jump) });
    if (target.dataset.pick) vscode.postMessage({ type: 'pick', index: Number(target.dataset.pick) });
    if (target.id === 'force') vscode.postMessage({ type: 'force' });
    if (target.id === 'retry') vscode.postMessage({ type: 'retry' });
  });
  document.getElementById('ask').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = event.target.elements.q;
    const question = input.value.trim();
    if (!question) return;
    input.value = '';
    vscode.postMessage({ type: 'ask', question });
  });
</` + 'script></body></html>');
  }
}
