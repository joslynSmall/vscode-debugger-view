import * as vscode from 'vscode';
import { missingConfigMessage, type AiSettings } from './ai';
import { answerFollowup, buildExplanation, candidateViews, mergeExplanation, rankCandidates, type StructuredExplanation } from './explain';
import { STATE_KEY } from './keys';
import {
  commitEnter,
  createSession,
  currentEntry,
  explainKey,
  focusOf,
  hierarchyName,
  isSupportedLanguage,
  isThirdPartyPath,
  jumpHistory,
  noteThirdParty,
  parsePersisted,
  planForceEnter,
  planStepInto,
  rawFromResolved,
  setRecommendation,
  stepOut,
  stepOver,
  takeChoice,
  toCallSites,
  toPersisted,
  topFrame,
  type CallSite,
  type FuncRef,
  type HistoryEntry,
  type RawOutgoing,
  type Session,
  type SrcRange,
  type StepKind,
} from './model';
import { handleDebugRequest, stepResponse, stepRunner } from './debugProtocol';
import { ExplainPanel, type PanelHost, type PanelState } from './panel';

export function getSession(): Session | undefined { return session; }
export function getHistory(): HistoryEntry[] { return session?.history ?? []; }

let session: Session | undefined;
let explanations: Record<string, StructuredExplanation> = {};
let followups: { question: string; answer: string }[] = [];
let notice: string | undefined;
let panel: ExplainPanel | undefined;
let adapter: StepDebugAdapter | undefined;
let status: vscode.StatusBarItem | undefined;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let focusDecoration: vscode.TextEditorDecorationType | undefined;

function rangeFrom(range: vscode.Range): SrcRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

function toVscodeRange(range: SrcRange): vscode.Range {
  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

function funcFromItem(item: vscode.CallHierarchyItem, containerName?: string): FuncRef {
  return {
    name: hierarchyName(item.name, containerName, item.kind === vscode.SymbolKind.Method),
    uri: item.uri.toString(),
    fsPath: item.uri.fsPath,
    range: rangeFrom(item.selectionRange),
    body: rangeFrom(item.range),
    detail: item.detail,
  };
}

function isInWorkspace(uri: vscode.Uri): boolean {
  return !!vscode.workspace.getWorkspaceFolder(uri);
}

async function readSettings(): Promise<{ settings?: AiSettings; message: string }> {
  const config = vscode.workspace.getConfiguration('vscode-debugger-view');
  const baseURL = config.get<string>('baseURL') ?? '';
  const model = config.get<string>('model') ?? '';
  const apiKey = config.get<string>('apiKey') ?? '';
  const message = missingConfigMessage({ baseURL, model, apiKey });
  if (message) {
    return { message };
  }
  return { settings: { baseURL, model, apiKey }, message: '' };
}

function implementationPlaces(found: vscode.Location | vscode.LocationLink | Array<vscode.Location | vscode.LocationLink> | undefined): { uri: vscode.Uri; position: vscode.Position }[] {
  const list = !found ? [] : Array.isArray(found) ? found : [found];
  return list.map(item => 'targetUri' in item
    ? { uri: item.targetUri, position: (item.targetSelectionRange ?? item.targetRange).start }
    : { uri: item.uri, position: item.range.start });
}

async function containerAt(uri: vscode.Uri, position: vscode.Position): Promise<string | undefined> {
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri);
  const contains = (symbol: vscode.DocumentSymbol): boolean => symbol.range.contains(position);
  const walk = (items: vscode.DocumentSymbol[] | undefined, parent?: string): string | undefined => {
    for (const item of items ?? []) {
      if (!contains(item)) {
        continue;
      }
      const next = item.kind === vscode.SymbolKind.Class || item.kind === vscode.SymbolKind.Interface ? item.name : parent;
      return walk(item.children, next) ?? next ?? parent;
    }
    return parent;
  };
  return walk(symbols);
}

async function implementationsOf(item: vscode.CallHierarchyItem): Promise<FuncRef[]> {
  try {
    const found = await vscode.commands.executeCommand<vscode.Location | vscode.LocationLink | Array<vscode.Location | vscode.LocationLink>>(
      'vscode.executeImplementationProvider',
      item.uri,
      item.selectionRange.start,
    );
    const funcs: FuncRef[] = [];
    for (const place of implementationPlaces(found)) {
      if (!isInWorkspace(place.uri)) {
        continue;
      }
      const prepared = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', place.uri, place.position);
      if (prepared?.[0]) {
        funcs.push(funcFromItem(prepared[0], await containerAt(place.uri, place.position)));
      }
    }
    return funcs;
  } catch {
    return [];
  }
}

async function outgoingOf(func: FuncRef): Promise<RawOutgoing[]> {
  const uri = vscode.Uri.parse(func.uri);
  const position = new vscode.Position(func.range.start.line, func.range.start.character);
  const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', uri, position);
  if (!items?.length) {
    return [];
  }
  const calls = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>('vscode.provideOutgoingCalls', items[0]) ?? [];
  const resolved = [];
  for (const call of calls) {
    if (!isInWorkspace(call.to.uri)) {
      continue;
    }
    resolved.push({
      fromRanges: call.fromRanges.map(rangeFrom),
      declared: { func: funcFromItem(call.to), thirdParty: isThirdPartyPath(call.to.uri.fsPath) },
      implementations: await implementationsOf(call.to),
    });
  }
  return rawFromResolved(resolved);
}

async function sitesOf(func: FuncRef): Promise<CallSite[]> {
  return toCallSites(await outgoingOf(func));
}

async function snippetOf(entry: HistoryEntry): Promise<string> {
  const top = topFrame(entry.stack);
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(top.func.uri));
    const focus = focusOf(entry).range;
    const start = Math.max(0, Math.min(top.func.range.start.line, focus.start.line) - 2);
    const end = Math.min(doc.lineCount, Math.max(top.func.body?.end.line ?? focus.end.line, focus.end.line) + 1);
    return doc.getText(new vscode.Range(start, 0, Math.min(end, start + 40), 0)).slice(0, 1600);
  } catch {
    return '';
  }
}

function markFocus(editor: vscode.TextEditor, range: vscode.Range): void {
  if (!focusDecoration) {
    focusDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('editor.selectionHighlightBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.selectionHighlightForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Center,
    });
  }
  for (const open of vscode.window.visibleTextEditors) {
    open.setDecorations(focusDecoration, []);
  }
  editor.setDecorations(focusDecoration, [range]);
}

async function revealRange(uri: string, range: SrcRange): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const vscodeRange = toVscodeRange(range);
  editor.revealRange(vscodeRange, vscode.TextEditorRevealType.InCenter);
  editor.selection = new vscode.Selection(vscodeRange.start, vscodeRange.end);
  markFocus(editor, vscodeRange);
}

async function revealEntry(entry: HistoryEntry): Promise<void> {
  const focus = focusOf(entry);
  await revealRange(focus.uri, focus.range);
}

function schedulePersist(): void {
  if (!extensionContext || !session) {
    return;
  }
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    if (!extensionContext || !session) {
      return;
    }
    void extensionContext.workspaceState.update(STATE_KEY, toPersisted(session, explanations, followups));
  }, 150);
}

async function refreshPanel(): Promise<void> {
  if (!session || !panel) {
    return;
  }
  const config = await readSettings();
  const keys = session.history.map(explainKey);
  const state: PanelState = {
    entries: session.history,
    cursor: session.cursor,
    explanations,
    keys,
    pending: session.pending,
    notice,
    followups,
    configured: !!config.settings,
  };
  panel.show(state);
  status && (status.text = `$(debug-step-over) ${topFrame(currentEntry(session).stack).func.name}`);
  schedulePersist();
}

async function ensureExplanation(entry: HistoryEntry, force = false): Promise<void> {
  const key = explainKey(entry);
  if (!force && explanations[key]) {
    return;
  }
  const config = await readSettings();
  const next = await buildExplanation({
    entry,
    snippet: await snippetOf(entry),
    settings: config.settings,
  });
  const merged = mergeExplanation(explanations[key], next, force);
  explanations[key] = merged.explanation;
  if (merged.notice) {
    notice = merged.notice;
  }
}

async function afterMove(kind: StepKind): Promise<void> {
  if (!session) {
    return;
  }
  const entry = currentEntry(session);
  await revealEntry(entry);
  await ensureExplanation(entry);
  await refreshPanel();
  adapter?.stopped(kind === 'start' ? 'entry' : 'step');
}

async function applyNav(result: { type: 'ok'; thirdPartyStop: boolean } | { type: 'noop'; message: string }, kind: StepKind): Promise<void> {
  if (result.type === 'noop') {
    vscode.window.showInformationMessage(result.message);
    notice = result.message;
    await refreshPanel();
    adapter?.stopped('step');
    return;
  }
  await afterMove(kind);
}

async function doStepOver(): Promise<void> {
  if (!session) {
    return;
  }
  await applyNav(stepOver(session), 'over');
}

async function doStepInto(): Promise<void> {
  if (!session) {
    return;
  }
  const plan = planStepInto(session);
  if (plan.action === 'noop') {
    vscode.window.showInformationMessage(plan.message);
    notice = plan.message;
    await refreshPanel();
    adapter?.stopped('step');
    return;
  }
  if (plan.action === 'choice') {
    await rankCurrentChoice();
    notice = '有多个实现，请在讲解面板选择。';
    const site = topFrame(session.stack).sites[plan.siteIndex];
    if (site) {
      await revealRange(topFrame(session.stack).func.uri, site.from);
    }
    await refreshPanel();
    adapter?.stopped('step');
    return;
  }
  if (plan.action === 'third-party') {
    noteThirdParty(session, plan.siteIndex);
    notice = `${plan.target.func.name} 来自第三方库，默认不进入。`;
    await afterMove('over');
    return;
  }
  await enterTarget(plan.target, 'into', plan.siteIndex);
}

async function rankCurrentChoice(): Promise<void> {
  if (!session?.pending) {
    return;
  }
  const frame = topFrame(session.stack);
  const site = frame.sites[session.pending.siteIndex];
  if (!site) {
    return;
  }
  const config = await readSettings();
  const ranked = await rankCandidates({ caller: frame, site, settings: config.settings });
  if (ranked) {
    setRecommendation(session, ranked.index, ranked.reason);
  }
}

async function enterTarget(target: { func: FuncRef; thirdParty: boolean }, kind: StepKind, siteIndex: number): Promise<void> {
  if (!session) {
    return;
  }
  const sites = await sitesOf(target.func);
  commitEnter(session, target, sites, kind, siteIndex);
  notice = undefined;
  const visit = topFrame(session.stack).visit;
  if (visit > 1) {
    vscode.window.showInformationMessage(`${target.func.name} 已访问第 ${visit} 次，复用已有讲解。`);
  }
  await afterMove(kind);
}

async function doStepOut(): Promise<void> {
  if (!session) {
    return;
  }
  await applyNav(stepOut(session), 'out');
}

async function doForceInto(): Promise<void> {
  if (!session) {
    return;
  }
  const plan = planForceEnter(session);
  if (plan.action === 'noop') {
    notice = plan.message;
    vscode.window.showInformationMessage(plan.message);
    await refreshPanel();
    return;
  }
  if (plan.action === 'choice') {
    await rankCurrentChoice();
    await refreshPanel();
    return;
  }
  if (plan.action === 'third-party') {
    return;
  }
  await enterTarget(plan.target, 'into', plan.siteIndex);
}

async function doPick(index: number): Promise<void> {
  if (!session) {
    return;
  }
  const picked = takeChoice(session, index);
  if (picked.action === 'noop') {
    notice = picked.message;
    await refreshPanel();
    return;
  }
  await enterTarget(picked.target, 'pick', picked.siteIndex);
}

async function jumpToHistory(index: number): Promise<void> {
  if (!session) {
    return;
  }
  const result = jumpHistory(session, index);
  if (result.type === 'noop') {
    return;
  }
  notice = undefined;
  await afterMove('over');
}

async function retryExplain(): Promise<void> {
  if (!session) {
    return;
  }
  await ensureExplanation(currentEntry(session), true);
  await refreshPanel();
}

async function ask(question: string): Promise<void> {
  if (!session) {
    return;
  }
  const text = question.trim();
  if (!text) {
    return;
  }
  const config = await readSettings();
  if (!config.settings) {
    notice = config.message;
    vscode.window.showWarningMessage(config.message);
    await refreshPanel();
    return;
  }
  const entry = currentEntry(session);
  try {
    const answer = await answerFollowup({
      question: text,
      entry,
      explanation: explanations[explainKey(entry)],
      settings: config.settings,
    });
    followups.push({ question: text, answer });
    notice = undefined;
  } catch (error) {
    notice = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(notice);
  }
  await refreshPanel();
}

async function startStep(uri?: vscode.Uri, position?: vscode.Position): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const docUri = uri ?? editor?.document.uri;
  const at = position ?? editor?.selection.active;
  if (!docUri || !at) {
    vscode.window.showWarningMessage('请在 TypeScript 文件中选中一个函数再开始');
    return;
  }
  const doc = await vscode.workspace.openTextDocument(docUri);
  if (!isSupportedLanguage(doc.languageId)) {
    vscode.window.showWarningMessage('只支持 TypeScript、JavaScript 和 Python');
    return;
  }
  const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', docUri, at);
  if (!items?.length) {
    vscode.window.showWarningMessage('此处找不到函数定义');
    return;
  }
  const func = funcFromItem(items[0]);
  session = createSession(func, await sitesOf(func));
  explanations = {};
  followups = [];
  notice = undefined;
  adapter = adapter ?? new StepDebugAdapter();
  await afterMove('start');
  await vscode.commands.executeCommand('vscode-debugger-view.explain.focus');
  if (!vscode.debug.activeDebugSession || vscode.debug.activeDebugSession.type !== 'debugger-view') {
    await vscode.debug.startDebugging(undefined, { type: 'debugger-view', request: 'launch', name: `单步讲解: ${func.name}` });
  }
  const config = await readSettings();
  if (!config.settings) {
    vscode.window.showWarningMessage(config.message);
  }
  vscode.window.showInformationMessage(`已开始单步讲解: ${func.name}`);
}

async function offerRestore(): Promise<void> {
  if (!extensionContext) {
    return;
  }
  const saved = parsePersisted(extensionContext.workspaceState.get(STATE_KEY));
  if (!saved) {
    return;
  }
  const name = topFrame(saved.session.history[saved.session.cursor].stack).func.name;
  const choice = await vscode.window.showInformationMessage(`发现上次的单步讲解：${name}，共 ${saved.session.history.length} 步。`, '恢复', '丢弃');
  if (choice !== '恢复') {
    if (choice === '丢弃') {
      await extensionContext.workspaceState.update(STATE_KEY, undefined);
    }
    return;
  }
  session = saved.session;
  explanations = saved.explanations as Record<string, StructuredExplanation>;
  followups = saved.followups;
  notice = undefined;
  adapter = adapter ?? new StepDebugAdapter();
  await afterMove('start');
  await vscode.commands.executeCommand('vscode-debugger-view.explain.focus');
  if (!vscode.debug.activeDebugSession || vscode.debug.activeDebugSession.type !== 'debugger-view') {
    await vscode.debug.startDebugging(undefined, { type: 'debugger-view', request: 'launch', name: `单步讲解: ${name}` });
  }
}

class StepDebugAdapter implements vscode.DebugAdapter {
  private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this.emitter.event;
  dispose(): void { this.emitter.dispose(); }
  handleMessage(message: vscode.DebugProtocolMessage): void { void this.onMessage(message as { type?: string; command?: string; seq?: number }); }
  private send(message: vscode.DebugProtocolMessage): void { this.emitter.fire(message); }
  stopped(reason: string): void {
    this.send({ type: 'event', seq: 0, event: 'stopped', body: { reason, threadId: 1, allThreadsStopped: true } } as vscode.DebugProtocolMessage);
  }
  private onMessage(message: { type?: string; command?: string; seq?: number }): void {
    const driver = {
      session: () => session,
      stepOver: doStepOver,
      stepInto: doStepInto,
      stepOut: doStepOut,
    };
    const run = stepRunner(message, driver);
    if (!run) {
      for (const item of handleDebugRequest(message, driver)) {
        this.send(item as vscode.DebugProtocolMessage);
      }
      return;
    }
    void run().then(() => this.send(stepResponse(message) as vscode.DebugProtocolMessage));
  }
}

class StepCodeLensProvider implements vscode.CodeLensProvider {
  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!isSupportedLanguage(document.languageId)) {
      return [];
    }
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', document.uri);
    const lenses: vscode.CodeLens[] = [];
    const walk = (items: vscode.DocumentSymbol[]) => {
      for (const item of items) {
        if (item.kind === vscode.SymbolKind.Function || item.kind === vscode.SymbolKind.Method) {
          lenses.push(new vscode.CodeLens(item.selectionRange, {
            title: '▶ 开始单步讲解',
            command: 'vscode-debugger-view.startStep',
            arguments: [document.uri, item.selectionRange.start],
          }));
        }
        walk(item.children);
      }
    };
    if (symbols) {
      walk(symbols);
    }
    return lenses;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  panel = new ExplainPanel();
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(ExplainPanel.viewId, {
    resolveWebviewView(view) {
      const host: PanelHost = {
        postCommand(command, args) { void vscode.commands.executeCommand(command, ...args); },
        setHtml(html) { view.webview.html = html; },
      };
      view.webview.options = { enableScripts: true };
      view.webview.onDidReceiveMessage(message => panel?.receive(message));
      panel?.attach(host);
    },
  }));
  adapter = new StepDebugAdapter();
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.name = '单步讲解';
  status.tooltip = '静态单步讲解';
  status.show();
  context.subscriptions.push(status);
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('debugger-view', {
    createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation(adapter ?? new StepDebugAdapter()),
  }));
  context.subscriptions.push(vscode.languages.registerCodeLensProvider([
    { language: 'typescript' },
    { language: 'javascript' },
    { language: 'python' },
  ], new StepCodeLensProvider()));
  context.subscriptions.push(
    vscode.commands.registerCommand('vscode-debugger-view.startStep', (uri?: vscode.Uri, position?: vscode.Position) => startStep(uri, position)),
    vscode.commands.registerCommand('vscode-debugger-view.stepOver', () => doStepOver()),
    vscode.commands.registerCommand('vscode-debugger-view.stepInto', () => doStepInto()),
    vscode.commands.registerCommand('vscode-debugger-view.stepOut', () => doStepOut()),
    vscode.commands.registerCommand('vscode-debugger-view.jumpToHistory', (index: number) => jumpToHistory(index)),
    vscode.commands.registerCommand('vscode-debugger-view.pickCandidate', (index: number) => doPick(index)),
    vscode.commands.registerCommand('vscode-debugger-view.forceInto', () => doForceInto()),
    vscode.commands.registerCommand('vscode-debugger-view.retryExplain', () => retryExplain()),
    vscode.commands.registerCommand('vscode-debugger-view.ask', (question: string) => ask(question)),
    vscode.commands.registerCommand('vscode-debugger-view.restoreSession', () => offerRestore()),
  );
  setTimeout(() => { void offerRestore(); }, 800);
}

export function deactivate(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
  if (extensionContext && session) {
    void extensionContext.workspaceState.update(STATE_KEY, toPersisted(session, explanations, followups));
  }
  adapter?.dispose();
  focusDecoration?.dispose();
}

export const testing = {
  candidateViews,
};
