import { toDapFrames, type Session } from './model';

export interface ProtocolMessage {
  type?: string;
  command?: string;
  seq?: number;
  event?: string;
  request_seq?: number;
  success?: boolean;
  body?: unknown;
}

export interface StepDriver {
  session: () => Session | undefined;
  stepOver: () => Promise<void>;
  stepInto: () => Promise<void>;
  stepOut: () => Promise<void>;
}

export function handleDebugRequest(message: ProtocolMessage, driver: StepDriver): ProtocolMessage[] {
  if (message.type !== 'request') {
    return [];
  }
  const out: ProtocolMessage[] = [];
  const reply = (body?: unknown) => out.push({
    type: 'response', seq: 0, request_seq: message.seq ?? 0, success: true, command: message.command, body,
  });
  const event = (eventName: string, body?: unknown) => out.push({ type: 'event', seq: 0, event: eventName, body });
  if (message.command === 'initialize') {
    reply({ supportsConfigurationDoneRequest: true, supportsTerminateRequest: true });
    event('initialized');
    return out;
  }
  if (message.command === 'launch') {
    reply({});
    event('stopped', { reason: 'entry', threadId: 1, allThreadsStopped: true });
    return out;
  }
  if (message.command === 'configurationDone') {
    reply({});
    return out;
  }
  if (message.command === 'threads') {
    reply({ threads: [{ id: 1, name: '单步讲解' }] });
    return out;
  }
  if (message.command === 'stackTrace') {
    const current = driver.session();
    const frames = current ? toDapFrames(current) : [];
    reply({
      stackFrames: frames.map(frame => ({
        id: frame.id,
        name: frame.name,
        source: { name: frame.sourceName, path: frame.path },
        line: frame.line,
        column: frame.column,
      })),
      totalFrames: frames.length,
    });
    return out;
  }
  if (message.command === 'scopes') {
    reply({ scopes: [{ name: '静态调用链（无运行时变量）', variablesReference: 0, expensive: false }] });
    return out;
  }
  if (message.command === 'variables') {
    reply({ variables: [] });
    return out;
  }
  if (message.command === 'disconnect' || message.command === 'terminate') {
    reply({});
    event('terminated');
    return out;
  }
  reply({});
  return out;
}

export function stepRunner(message: ProtocolMessage, driver: StepDriver): (() => Promise<void>) | undefined {
  if (message.command === 'next' || message.command === 'continue') {
    return driver.stepOver;
  }
  if (message.command === 'stepIn') {
    return driver.stepInto;
  }
  if (message.command === 'stepOut') {
    return driver.stepOut;
  }
  return undefined;
}

export function stepResponse(message: ProtocolMessage): ProtocolMessage {
  return {
    type: 'response',
    seq: 0,
    request_seq: message.seq ?? 0,
    success: true,
    command: message.command,
    body: { allThreadsContinued: false },
  };
}
