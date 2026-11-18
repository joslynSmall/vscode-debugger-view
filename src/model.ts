// 纯数据的单步状态机。不引入 vscode，便于用真实调用点数据重放导航。

export interface Pos {
  line: number;
  character: number;
}

export interface SrcRange {
  start: Pos;
  end: Pos;
}

export interface FuncRef {
  name: string;
  uri: string;
  fsPath: string;
  /** 函数名选区，不是整段函数体。 */
  range: SrcRange;
  body?: SrcRange;
  detail?: string;
}

export interface Target {
  func: FuncRef;
  thirdParty: boolean;
}

export interface CallSite {
  from: SrcRange;
  targets: Target[];
}

export interface Frame {
  func: FuncRef;
  /** -1 表示停在函数入口，尚未落到某个调用点。 */
  callIndex: number;
  sites: CallSite[];
  /** 这一帧压栈当时的访问次数，不随后来的递归改写。 */
  visit: number;
}

export type StepKind = 'start' | 'over' | 'into' | 'out' | 'pick';

export interface HistoryEntry {
  kind: StepKind;
  stack: Frame[];
  thirdPartyStop: boolean;
}

export interface PendingChoice {
  siteIndex: number;
  targets: Target[];
  /** 展示顺序，元素是 targets 的下标。推荐项放在 0。 */
  order: number[];
  reason?: string;
  recommended: boolean;
}

export interface Session {
  stack: Frame[];
  history: HistoryEntry[];
  cursor: number;
  visited: Record<string, number>;
  pending?: PendingChoice;
}

export interface RawOutgoing {
  fromRanges: SrcRange[];
  to: FuncRef;
  thirdParty: boolean;
}

export type Plan =
  | { action: 'noop'; message: string }
  | { action: 'choice'; targets: Target[]; siteIndex: number }
  | { action: 'third-party'; target: Target; siteIndex: number }
  | { action: 'enter'; target: Target; siteIndex: number };

export type NavResult =
  | { type: 'ok'; thirdPartyStop: boolean }
  | { type: 'noop'; message: string };

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function funcKey(func: FuncRef): string {
  return `${func.uri}#${func.range.start.line}:${func.range.start.character}:${func.name}`;
}

const THIRD_PARTY_DIRS = new Set(['node_modules', 'site-packages', 'dist-packages']);

export function isThirdPartyPath(fsPath: string): boolean {
  return fsPath.split(/[/\\]/).some(part => THIRD_PARTY_DIRS.has(part));
}

export const SUPPORTED_LANGUAGES = ['typescript', 'javascript', 'python'] as const;

export function isSupportedLanguage(languageId: string): boolean {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(languageId);
}

export function hierarchyName(name: string, containerName: string | undefined, isMethod: boolean): string {
  return isMethod && containerName ? `${containerName}.${name}` : name;
}

/** 多个实现替换接口或签名；没有别的实现时保留调用层级给出的目标。 */
export function targetsForCall(declared: Target, implementations: FuncRef[]): Target[] {
  const unique: FuncRef[] = [];
  for (const impl of implementations) {
    if (!unique.some(item => funcKey(item) === funcKey(impl))) {
      unique.push(impl);
    }
  }
  const bodies = unique.filter(impl => funcKey(impl) !== funcKey(declared.func));
  if (!bodies.length) {
    return [declared];
  }
  return bodies.map(impl => ({ func: clone(impl), thirdParty: isThirdPartyPath(impl.fsPath) }));
}

export interface ResolvedCall {
  fromRanges: SrcRange[];
  declared: Target;
  implementations: FuncRef[];
}

export function rawFromResolved(calls: ResolvedCall[]): RawOutgoing[] {
  const raw: RawOutgoing[] = [];
  for (const call of calls) {
    for (const target of targetsForCall(call.declared, call.implementations)) {
      raw.push({ fromRanges: call.fromRanges, to: target.func, thirdParty: target.thirdParty });
    }
  }
  return raw;
}

export function baseName(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}

function comparePos(a: Pos, b: Pos): number {
  return a.line - b.line || a.character - b.character;
}

function startKey(range: SrcRange): string {
  return `${range.start.line}:${range.start.character}`;
}

/** 按调用点起始位置合并。同一起始位置的多个目标是候选实现，不是两次调用。 */
export function toCallSites(raw: RawOutgoing[]): CallSite[] {
  const flat: { from: SrcRange; target: Target }[] = [];
  for (const call of raw) {
    for (const from of call.fromRanges) {
      flat.push({ from, target: { func: call.to, thirdParty: call.thirdParty } });
    }
  }
  flat.sort((a, b) => comparePos(a.from.start, b.from.start) || comparePos(a.from.end, b.from.end) || a.target.func.name.localeCompare(b.target.func.name));
  const sites: CallSite[] = [];
  for (const item of flat) {
    const key = startKey(item.from);
    const last = sites[sites.length - 1];
    if (last && startKey(last.from) === key) {
      if (!last.targets.some(target => funcKey(target.func) === funcKey(item.target.func))) {
        last.targets.push(item.target);
      }
      continue;
    }
    sites.push({ from: item.from, targets: [item.target] });
  }
  return sites;
}

function sameStackPos(a: Frame[], b: Frame[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (funcKey(a[i].func) !== funcKey(b[i].func) || a[i].callIndex !== b[i].callIndex) {
      return false;
    }
  }
  return true;
}

function truncateForward(session: Session): void {
  if (session.cursor < session.history.length - 1) {
    session.history = session.history.slice(0, session.cursor + 1);
  }
}

function pushHistory(session: Session, kind: StepKind, thirdPartyStop: boolean): void {
  truncateForward(session);
  session.history.push({
    kind,
    stack: clone(session.stack),
    thirdPartyStop,
  });
  session.cursor = session.history.length - 1;
}

export function createSession(func: FuncRef, sites: CallSite[]): Session {
  const key = funcKey(func);
  const session: Session = {
    stack: [{ func: clone(func), callIndex: -1, sites: clone(sites), visit: 1 }],
    history: [],
    cursor: -1,
    visited: { [key]: 1 },
  };
  pushHistory(session, 'start', false);
  return session;
}

export function currentEntry(session: Session): HistoryEntry {
  return session.history[session.cursor];
}

export function topFrame(stack: Frame[]): Frame {
  return stack[stack.length - 1];
}

export function explainKey(entry: HistoryEntry): string {
  const top = topFrame(entry.stack);
  if (entry.thirdPartyStop && top.callIndex >= 0 && top.sites[top.callIndex]) {
    return `tp:${funcKey(top.func)}:${startKey(top.sites[top.callIndex].from)}`;
  }
  if (top.callIndex < 0) {
    return `fn:${funcKey(top.func)}`;
  }
  const site = top.sites[top.callIndex];
  const names = site ? site.targets.map(target => funcKey(target.func)).join('|') : '';
  return `call:${funcKey(top.func)}:${site ? startKey(site.from) : top.callIndex}:${names}`;
}

export function focusOf(entry: HistoryEntry): { uri: string; fsPath: string; range: SrcRange } {
  const top = topFrame(entry.stack);
  if (top.callIndex >= 0 && top.sites[top.callIndex]) {
    return { uri: top.func.uri, fsPath: top.func.fsPath, range: top.sites[top.callIndex].from };
  }
  return { uri: top.func.uri, fsPath: top.func.fsPath, range: top.func.range };
}

export function entryTitle(entry: HistoryEntry): string {
  const top = topFrame(entry.stack);
  if (top.callIndex >= 0 && top.sites[top.callIndex]) {
    const names = top.sites[top.callIndex].targets.map(target => target.func.name).join(' / ');
    return `${top.func.name} → ${names}`;
  }
  return top.func.name;
}

export function formatStack(stack: Frame[]): string {
  return stack.map((frame, index) => {
    const at = frame.callIndex >= 0 && frame.sites[frame.callIndex]
      ? `调用点 ${frame.sites[frame.callIndex].from.start.line + 1}行`
      : `定义 ${frame.func.range.start.line + 1}行`;
    return `${index + 1}. ${frame.func.name} ${baseName(frame.func.fsPath)} ${at}`;
  }).join('\n');
}

function siteIndexForEnter(frame: Frame): number {
  return frame.callIndex < 0 ? 0 : frame.callIndex;
}

export function stepOver(session: Session): NavResult {
  if (!session.stack.length) {
    return { type: 'noop', message: '请先开始单步讲解' };
  }
  const frame = topFrame(session.stack);
  const next = frame.callIndex + 1;
  if (next >= frame.sites.length) {
    return { type: 'noop', message: '当前函数没有下一个调用点' };
  }
  truncateForward(session);
  session.pending = undefined;
  frame.callIndex = next;
  const thirdPartyStop = frame.sites[next].targets.length > 0 && frame.sites[next].targets.every(target => target.thirdParty);
  pushHistory(session, 'over', thirdPartyStop);
  return { type: 'ok', thirdPartyStop };
}

export function planStepInto(session: Session): Plan {
  if (!session.stack.length) {
    return { action: 'noop', message: '请先开始单步讲解' };
  }
  if (session.pending) {
    return { action: 'choice', targets: session.pending.targets, siteIndex: session.pending.siteIndex };
  }
  const frame = topFrame(session.stack);
  const siteIndex = siteIndexForEnter(frame);
  if (!frame.sites.length || siteIndex >= frame.sites.length) {
    return { action: 'noop', message: '当前函数没有可进入的调用' };
  }
  const site = frame.sites[siteIndex];
  if (!site?.targets.length) {
    return { action: 'noop', message: '当前函数没有可进入的调用' };
  }
  truncateForward(session);
  if (site.targets.length > 1) {
    session.pending = {
      siteIndex,
      targets: site.targets,
      order: site.targets.map((_, index) => index),
      recommended: false,
    };
    return { action: 'choice', targets: site.targets, siteIndex };
  }
  if (site.targets[0].thirdParty) {
    return { action: 'third-party', target: site.targets[0], siteIndex };
  }
  return { action: 'enter', target: site.targets[0], siteIndex };
}

export function planForceEnter(session: Session): Plan {
  if (!session.stack.length) {
    return { action: 'noop', message: '请先开始单步讲解' };
  }
  if (session.pending) {
    return { action: 'choice', targets: session.pending.targets, siteIndex: session.pending.siteIndex };
  }
  const frame = topFrame(session.stack);
  if (frame.callIndex < 0 || !frame.sites[frame.callIndex]?.targets.length) {
    return { action: 'noop', message: '请先单步到第三方库调用点' };
  }
  const site = frame.sites[frame.callIndex];
  if (!site.targets.every(target => target.thirdParty)) {
    return { action: 'noop', message: '当前调用不是第三方库' };
  }
  if (site.targets.length > 1) {
    session.pending = {
      siteIndex: frame.callIndex,
      targets: site.targets,
      order: site.targets.map((_, index) => index),
      recommended: false,
    };
    return { action: 'choice', targets: site.targets, siteIndex: frame.callIndex };
  }
  return { action: 'enter', target: site.targets[0], siteIndex: frame.callIndex };
}

export function noteThirdParty(session: Session, siteIndex: number): void {
  const frame = topFrame(session.stack);
  frame.callIndex = siteIndex;
  const current = session.history[session.cursor];
  if (current && current.thirdPartyStop && sameStackPos(current.stack, session.stack)) {
    return;
  }
  pushHistory(session, 'over', true);
}

export function commitEnter(session: Session, target: Target, sites: CallSite[], kind: StepKind, siteIndex: number): void {
  const caller = topFrame(session.stack);
  caller.callIndex = siteIndex;
  const key = funcKey(target.func);
  const visit = (session.visited[key] ?? 0) + 1;
  session.visited[key] = visit;
  session.pending = undefined;
  session.stack.push({ func: clone(target.func), callIndex: -1, sites: clone(sites), visit });
  pushHistory(session, kind, false);
}

export function takeChoice(session: Session, displayIndex: number): { action: 'noop'; message: string } | { action: 'enter'; target: Target; siteIndex: number } {
  const pending = session.pending;
  if (!pending) {
    return { action: 'noop', message: '当前没有待选实现' };
  }
  const original = pending.order[displayIndex];
  const target = pending.targets[original];
  if (!target) {
    return { action: 'noop', message: '没有这个候选' };
  }
  const siteIndex = pending.siteIndex;
  session.pending = undefined;
  return { action: 'enter', target, siteIndex };
}

export function candidateOrder(session: Session): string[] {
  return session.pending?.order.map(index => session.pending?.targets[index]?.func.name ?? '') ?? [];
}

export function setRecommendation(session: Session, originalIndex: number, reason: string): void {
  const pending = session.pending;
  if (!pending || originalIndex < 0 || originalIndex >= pending.targets.length) {
    return;
  }
  const order = pending.targets.map((_, index) => index).filter(index => index !== originalIndex);
  pending.order = [originalIndex, ...order];
  pending.reason = reason;
  pending.recommended = true;
}

export function stepOut(session: Session): NavResult {
  if (session.stack.length <= 1) {
    return { type: 'noop', message: '已在起点函数' };
  }
  truncateForward(session);
  session.pending = undefined;
  session.stack.pop();
  pushHistory(session, 'out', false);
  return { type: 'ok', thirdPartyStop: false };
}

export function jumpHistory(session: Session, index: number): NavResult {
  if (index < 0 || index >= session.history.length) {
    return { type: 'noop', message: '没有这一步' };
  }
  session.cursor = index;
  session.stack = clone(session.history[index].stack);
  session.pending = undefined;
  return { type: 'ok', thirdPartyStop: session.history[index].thirdPartyStop };
}

export interface DapFrame {
  id: number;
  name: string;
  path: string;
  sourceName: string;
  line: number;
  column: number;
}

export function toDapFrames(session: Session): DapFrame[] {
  const ordered = [...session.stack].reverse();
  return ordered.map((frame, index) => {
    const range = frame.callIndex >= 0 && frame.sites[frame.callIndex]
      ? frame.sites[frame.callIndex].from
      : frame.func.range;
    const visit = frame.visit > 1 ? ` (已访问第${frame.visit}次)` : '';
    return {
      id: session.stack.length - index,
      name: `${frame.func.name}${visit}`,
      path: frame.func.fsPath,
      sourceName: baseName(frame.func.fsPath),
      line: range.start.line + 1,
      column: range.start.character + 1,
    };
  });
}

export interface PersistedState {
  version: 1;
  session: Session;
  explanations: Record<string, unknown>;
  followups: { question: string; answer: string }[];
}

export function toPersisted(session: Session, explanations: Record<string, unknown>, followups: { question: string; answer: string }[]): PersistedState {
  return {
    version: 1,
    session: clone(session),
    explanations: clone(explanations),
    followups: followups.map(item => ({ question: item.question, answer: item.answer })),
  };
}

export function parsePersisted(input: unknown): PersistedState | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const value = input as PersistedState;
  if (value.version !== 1 || !value.session || !Array.isArray(value.session.stack) || value.session.stack.length === 0) {
    return undefined;
  }
  if (!Array.isArray(value.session.history) || value.session.history.length === 0) {
    return undefined;
  }
  if (typeof value.session.cursor !== 'number' || value.session.cursor < 0 || value.session.cursor >= value.session.history.length) {
    return undefined;
  }
  return {
    version: 1,
    session: value.session,
    explanations: value.explanations && typeof value.explanations === 'object' ? value.explanations : {},
    followups: Array.isArray(value.followups) ? value.followups : [],
  };
}
