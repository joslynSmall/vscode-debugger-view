import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const model = await import(pathToFileURL(path.join(root, 'out/model.js')).href);
const ai = await import(pathToFileURL(path.join(root, 'out/ai.js')).href);
const explain = await import(pathToFileURL(path.join(root, 'out/explain.js')).href);
const panel = await import(pathToFileURL(path.join(root, 'out/panel.js')).href);
const protocol = await import(pathToFileURL(path.join(root, 'out/debugProtocol.js')).href);

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}

function pos(line, character = 0) {
  return { line, character };
}
function span(line, character, endLine, endCharacter) {
  return { start: pos(line, character), end: pos(endLine, endCharacter) };
}
function func(name, file, line, character = 0) {
  return {
    name,
    uri: `file://${file}`,
    fsPath: file,
    range: span(line, character, line, character + name.length),
    detail: `function ${name}()`,
  };
}
function target(name, file, line, thirdParty = false) {
  return { func: func(name, file, line), thirdParty };
}
function site(line, character, targets) {
  return { from: span(line, character, line, character + 4), targets };
}

const flow = '/work/src/flow.ts';
const fileReader = '/work/src/file-reader.ts';
const memoryReader = '/work/src/memory-reader.ts';
const lib = '/work/node_modules/leftpad/index.ts';

const startSites = [
  site(10, 16, [target('middle', flow, 20)]),
  site(11, 17, [target('pick', flow, 30)]),
  site(12, 17, [target('again', flow, 40)]),
];
const middleSites = [site(21, 18, [target('leaf', flow, 50)])];
const againSites = [
  site(32, 11, [target('leaf', flow, 21)]),
  site(34, 9, [target('leaf', flow, 21), target('again', flow, 30)]),
];
const pickSites = [
  site(31, 9, [
    target('FileReader.read', fileReader, 4),
    target('MemoryReader.read', memoryReader, 8),
  ]),
];
const useLibSites = [
  site(3, 17, [target('pad', lib, 1, true)]),
  site(4, 9, [target('leaf', flow, 50)]),
];
const sitesByName = {
  start: startSites,
  middle: middleSites,
  again: againSites,
  pick: pickSites,
  leaf: [],
  'FileReader.read': [],
  'MemoryReader.read': [],
  pad: [],
  useLib: useLibSites,
};

function replayInto(session, name) {
  const plan = model.planStepInto(session);
  assert.equal(plan.action, 'enter', `${name} 应能进入唯一实现`);
  model.commitEnter(session, plan.target, sitesByName[plan.target.func.name], 'into', plan.siteIndex);
  return plan;
}

check('验收2 跳过按调用点前进，进入后再跳出回到该调用点', () => {
  const session = model.createSession(func('start', flow, 9), startSites);
  assert.equal(model.focusOf(model.currentEntry(session)).range.start.line, 9);

  assert.equal(model.stepOver(session).type, 'ok');
  assert.equal(model.focusOf(model.currentEntry(session)).range.start.line, 10);
  assert.equal(model.stepOver(session).type, 'ok');
  assert.equal(model.focusOf(model.currentEntry(session)).range.start.line, 11);

  const plan = replayInto(session, 'pick');
  assert.equal(plan.siteIndex, 1);
  assert.equal(model.topFrame(session.stack).func.name, 'pick');
  assert.equal(model.focusOf(model.currentEntry(session)).range.start.line, 30);

  assert.equal(model.stepOut(session).type, 'ok');
  const back = model.currentEntry(session);
  assert.equal(model.topFrame(back.stack).func.name, 'start');
  assert.equal(model.focusOf(back).range.start.line, 11);

  const frames = model.toDapFrames(session);
  assert.equal(frames[0].name, 'start');
  assert.equal(frames[0].line, 12);
  assert.equal(frames[0].path, flow);
});

check('验收2 入口处直接进入第一个调用，不先把光标挪走', () => {
  const session = model.createSession(func('start', flow, 9), startSites);
  const before = model.focusOf(model.currentEntry(session)).range.start.line;
  replayInto(session, 'middle');
  assert.equal(before, 9);
  assert.equal(model.topFrame(session.stack).func.name, 'middle');
  assert.equal(session.stack[0].callIndex, 0);
});

check('验收4 历史倒序可回看，回看后再前进会截断旧分支', () => {
  const session = model.createSession(func('start', flow, 9), startSites);
  model.stepOver(session);
  model.stepOver(session);
  replayInto(session, 'pick');
  assert.equal(session.history.length, 4);

  assert.equal(model.jumpHistory(session, 1).type, 'ok');
  assert.equal(model.topFrame(session.stack).func.name, 'start');
  assert.equal(model.focusOf(model.currentEntry(session)).range.start.line, 10);
  assert.equal(session.history.length, 4);

  model.stepOver(session);
  assert.equal(session.history.length, 3);
  assert.equal(session.cursor, 2);
  assert.equal(model.focusOf(model.currentEntry(session)).range.start.line, 11);
});

check('验收5 多候选先列出，推荐项排到第一，选择后才进入', () => {
  const session = model.createSession(func('pick', flow, 30), pickSites);
  const plan = model.planStepInto(session);
  assert.equal(plan.action, 'choice');
  assert.equal(session.stack.length, 1);
  assert.deepEqual(model.candidateOrder(session), ['FileReader.read', 'MemoryReader.read']);

  model.setRecommendation(session, 1, '调用方传入的是内存实现');
  assert.equal(session.pending.order[0], 1);
  assert.equal(session.pending.reason, '调用方传入的是内存实现');
  assert.deepEqual(model.candidateOrder(session), ['MemoryReader.read', 'FileReader.read']);

  const picked = model.takeChoice(session, 0);
  assert.equal(picked.action, 'enter');
  assert.equal(picked.target.func.name, 'MemoryReader.read');
  model.commitEnter(session, picked.target, [], 'pick', picked.siteIndex);
  assert.equal(model.topFrame(session.stack).func.name, 'MemoryReader.read');
  assert.equal(session.stack[0].callIndex, 0);
  assert.equal(session.pending, undefined);
});

check('验收7 第三方库跳过和进入都停在调用点，手动进入才进实现', () => {
  const session = model.createSession(func('useLib', '/work/src/with-lib.ts', 2), useLibSites);
  const over = model.stepOver(session);
  assert.equal(over.thirdPartyStop, true);
  assert.equal(session.stack.length, 1);
  assert.equal(model.focusOf(model.currentEntry(session)).range.start.line, 3);

  const blocked = model.planStepInto(session);
  assert.equal(blocked.action, 'third-party');
  assert.equal(session.stack.length, 1);

  model.noteThirdParty(session, blocked.siteIndex);
  const forced = model.planForceEnter(session);
  assert.equal(forced.action, 'enter');
  assert.equal(forced.target.func.name, 'pad');
  model.commitEnter(session, forced.target, [], 'into', forced.siteIndex);
  assert.equal(model.topFrame(session.stack).func.name, 'pad');
  assert.equal(model.topFrame(session.stack).func.fsPath, lib);
});

check('验收8 递归再进保留第一次讲解，并记下第二次访问', () => {
  const session = model.createSession(func('again', flow, 30), againSites);
  model.stepOver(session);
  model.stepOver(session);
  const plan = model.planStepInto(session);
  assert.equal(plan.action, 'choice');
  assert.equal(plan.siteIndex, 1);
  const picked = model.takeChoice(session, 1);
  assert.equal(picked.target.func.name, 'again');
  model.commitEnter(session, picked.target, againSites, 'pick', picked.siteIndex);
  assert.equal(model.topFrame(session.stack).visit, 2);
  assert.equal(session.stack[0].visit, 1);

  const firstKey = model.explainKey(session.history[0]);
  const secondKey = model.explainKey(model.currentEntry(session));
  assert.equal(firstKey, secondKey);
  assert.equal(model.toDapFrames(session)[0].name, 'again (已访问第2次)');
  assert.equal(model.toDapFrames(session)[1].name, 'again');
});

check('验收11 持久化后能回到同一调用栈和讲解', () => {
  const session = model.createSession(func('start', flow, 9), startSites);
  model.stepOver(session);
  replayInto(session, 'middle');
  const saved = model.toPersisted(session, { [model.explainKey(model.currentEntry(session))]: { summary: '清洗后继续' } }, [
    { question: '为什么先 middle', answer: '先清洗输入' },
  ]);
  const text = JSON.stringify(saved);
  const restored = model.parsePersisted(JSON.parse(text));
  assert.equal(restored.session.stack.map(frame => frame.func.name).join('>'), 'start>middle');
  assert.equal(restored.session.cursor, saved.session.cursor);
  assert.equal(Object.values(restored.explanations)[0].summary, '清洗后继续');
  assert.equal(restored.followups[0].answer, '先清洗输入');
  assert.equal(model.parsePersisted({ version: 2 }), undefined);
});

check('验收9/10 未配置提示完整，地址拼接正确，日志抹掉密钥', () => {
  const message = ai.missingConfigMessage({ baseURL: '', model: 'm', apiKey: '' });
  assert.match(message, /baseURL/);
  assert.match(message, /apiKey/);
  assert.doesNotMatch(message, /model/);
  assert.equal(ai.missingConfigMessage({ baseURL: 'http://127.0.0.1:9', model: 'm', apiKey: 'secret' }), '');
  assert.equal(ai.resolveChatUrl('http://127.0.0.1:9'), 'http://127.0.0.1:9/v1/chat/completions');
  assert.equal(ai.resolveChatUrl('http://127.0.0.1:9/v1/'), 'http://127.0.0.1:9/v1/chat/completions');
  assert.equal(ai.resolveChatUrl('http://127.0.0.1:9/v1/chat/completions'), 'http://127.0.0.1:9/v1/chat/completions');
  const secret = 'sk-test-secret-value';
  assert.equal(ai.redactSecrets(`失败 Bearer ${secret} 以及 ${secret}`, [secret]).includes(secret), false);
});

await checkAsync('验收3/5/6/9 本地 OpenAI 兼容接口生成讲解、推荐和追问', async () => {
  const seen = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body);
      seen.push({
        url: request.url,
        authorization: request.headers.authorization,
        model: parsed.model,
        user: parsed.messages.at(-1).content,
      });
      const ask = parsed.messages.at(-1).content;
      let content = '追问回答：先清洗再选择实现';
      if (ask.includes('候选：')) {
        content = JSON.stringify({ index: 1, reason: '第二个实现更贴近当前参数' });
      } else if (ask.includes('当前函数：')) {
        content = JSON.stringify({
          summary: 'middle 先把输入交给 leaf 清洗',
          purpose: '整理输入',
          params: '入参 value:string，出参 string',
          logic: '调用 leaf 后返回',
          whyHere: 'start 需要先得到清洗结果',
        });
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const settings = { baseURL: `http://127.0.0.1:${port}`, model: 'fixture-model', apiKey: 'sk-local-acceptance-key' };
  try {
    const session = model.createSession(func('start', flow, 9), startSites);
    replayInto(session, 'middle');
    const entry = model.currentEntry(session);
    const built = await explain.buildExplanation({
      entry,
      snippet: 'export function middle(value: string) { return leaf(value); }',
      settings,
    });
    assert.equal(built.fromAi, true);
    assert.equal(built.summary, 'middle 先把输入交给 leaf 清洗');
    assert.match(built.params, /入参/);
    assert.match(built.logic, /leaf/);
    assert.match(built.whyHere, /start/);

    const broken = await explain.buildExplanation({ entry, snippet: 'x', settings: undefined });
    assert.equal(broken.fromAi, false);
    assert.match(broken.error, /未配置 AI/);

    const ranked = await explain.rankCandidates({
      caller: session.stack[0],
      site: pickSites[0],
      settings,
    });
    assert.equal(ranked.index, 1);
    assert.match(ranked.reason, /第二个实现/);

    const answer = await explain.answerFollowup({
      question: '为什么现在在 middle',
      entry,
      explanation: built,
      settings,
    });
    assert.match(answer, /追问回答/);
    assert.equal(seen.length, 3);
    assert.ok(seen.every(item => item.url === '/v1/chat/completions'));
    assert.ok(seen.every(item => item.authorization === 'Bearer sk-local-acceptance-key'));
    assert.ok(seen.every(item => item.model === 'fixture-model'));
    assert.match(seen[2].user, /1\. start/);
    assert.match(seen[2].user, /2\. middle/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

await checkAsync('验收9 接口失败时保留明确错误且不回显密钥', async () => {
  const secret = 'sk-should-not-leak-body';
  const server = http.createServer((request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: `bad key ${secret}` }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const settings = { baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: 'm', apiKey: secret };
  try {
    const session = model.createSession(func('leaf', flow, 50), []);
    const built = await explain.buildExplanation({ entry: model.currentEntry(session), snippet: 'return value', settings });
    assert.equal(built.fromAi, false);
    assert.match(built.error, /HTTP 401/);
    assert.equal(built.error.includes(secret), false);
    const objectResponse = new Response(JSON.stringify({ choices: [{ message: { content: { summary: '对象形式的结论', purpose: { channel: '桥接通道' } } } }] }), { status: 200 });
    const objectBuilt = await explain.buildExplanation({
      entry: model.currentEntry(session),
      snippet: 'return value',
      settings,
      fetchImpl: async () => objectResponse,
    });
    assert.equal(objectBuilt.fromAi, true);
    assert.equal(objectBuilt.summary, '对象形式的结论');
    assert.equal(objectBuilt.purpose, 'channel：桥接通道');
    const kept = explain.mergeExplanation({ ...built, summary: '上一次的 AI 讲解', fromAi: true, error: undefined }, built, true);
    assert.equal(kept.explanation.summary, '上一次的 AI 讲解');
    assert.equal(kept.explanation.fromAi, true);
    assert.match(kept.explanation.error, /HTTP 401/);
    assert.equal(kept.explanation.error.includes(secret), false);
    const first = explain.mergeExplanation(undefined, built, false);
    assert.equal(first.explanation.fromAi, false);
    assert.match(first.notice, /HTTP 401/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

function functionAt(sourceFile, name) {
  let found;
  const visit = (node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name) && node.name.text === name && !found) {
      found = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.ok(found, `找不到函数 ${name}`);
  return found;
}

function prepare(project, file, position) {
  const prepared = project.prepareCallHierarchy(file, position);
  const item = Array.isArray(prepared) ? prepared[0] : prepared;
  assert.ok(item, `prepareCallHierarchy 没有结果 ${file}:${position}`);
  return item;
}

function lineOf(sourceFile, offset) {
  return sourceFile.getLineAndCharacterOfPosition(offset).line;
}

await checkAsync('验收2/7 真实 TypeScript 语言服务给出调用点并识别 node_modules', async () => {
  const fixture = path.join(root, 'test/fixture');
  const configPath = path.join(fixture, 'tsconfig.json');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, fixture);
  const scriptFiles = [...parsed.fileNames];
  for (const name of ['src/flow.js', 'src/with-lib.js', 'node_modules/leftpad/index.js']) {
    const fileName = path.join(fixture, name);
    if (!scriptFiles.includes(fileName)) scriptFiles.push(fileName);
  }
  const project = ts.createLanguageService({
    getCompilationSettings: () => ({ ...parsed.options, allowJs: true }),
    getScriptFileNames: () => scriptFiles,
    getScriptVersion: () => '1',
    getScriptSnapshot: (fileName) => {
      const text = ts.sys.readFile(fileName);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => fixture,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
  });
  const flowFile = path.join(fixture, 'src/flow.ts');
  const flowSource = ts.createSourceFile(flowFile, ts.sys.readFile(flowFile), ts.ScriptTarget.Latest, true);
  const startNode = functionAt(flowSource, 'start');
  const startItem = prepare(project, flowFile, startNode.name.getStart(flowSource));
  const calls = project.provideCallHierarchyOutgoingCalls(flowFile, startItem.selectionSpan.start);
  const raw = [];
  for (const call of calls) {
    const seen = new Set();
    for (const from of call.fromSpans) {
      const line = lineOf(flowSource, from.start);
      if (seen.has(line)) continue;
      seen.add(line);
      raw.push({ name: call.to.name, line });
    }
  }
  assert.deepEqual(raw.map(item => item.name), ['middle', 'pick', 'again']);
  const startLine = lineOf(flowSource, startItem.selectionSpan.start);
  assert.ok(raw.every(item => item.line > startLine));
  assert.deepEqual(raw.map(item => item.line), [37, 38, 39]);

  const libFile = path.join(fixture, 'src/with-lib.ts');
  const libSource = ts.createSourceFile(libFile, ts.sys.readFile(libFile), ts.ScriptTarget.Latest, true);
  const useLib = functionAt(libSource, 'useLib');
  const useItem = prepare(project, libFile, useLib.name.getStart(libSource));
  const libCalls = project.provideCallHierarchyOutgoingCalls(libFile, useItem.selectionSpan.start);
  const resolved = libCalls.map(call => {
    const impls = project.getImplementationAtPosition(call.to.file, call.to.selectionSpan.start) ?? [];
    return {
      fromRanges: [...new Map(call.fromSpans.map(from => {
        const start = libSource.getLineAndCharacterOfPosition(from.start);
        const end = libSource.getLineAndCharacterOfPosition(from.start + from.length);
        return [`${start.line}:${start.character}`, { start, end }];
      })).values()],
      declared: {
        func: {
          name: call.to.name,
          uri: pathToFileURL(call.to.file).href,
          fsPath: call.to.file,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
        thirdParty: model.isThirdPartyPath(call.to.file),
      },
      implementations: impls.map(impl => ({
        name: call.to.name,
        uri: pathToFileURL(impl.fileName).href,
        fsPath: impl.fileName,
        range: { start: { line: 0, character: impl.textSpan.start }, end: { line: 0, character: impl.textSpan.start + 1 } },
      })),
    };
  });
  const sites = model.toCallSites(model.rawFromResolved(resolved));
  assert.deepEqual(sites.map(item => item.targets[0].func.name), ['pad', 'leaf']);
  assert.equal(sites[0].targets[0].thirdParty, true);
  assert.equal(sites[1].targets[0].thirdParty, false);
  assert.equal(model.stepOver(model.createSession(func('useLib', libFile, 3), sites)).thirdPartyStop, true);

  const pickNode = functionAt(flowSource, 'pick');
  const pickItem = prepare(project, flowFile, pickNode.name.getStart(flowSource));
  const pickCalls = project.provideCallHierarchyOutgoingCalls(flowFile, pickItem.selectionSpan.start);
  const readCall = pickCalls.find(call => call.to.name === 'read');
  assert.ok(readCall, 'pick 应调用 read');
  const impls = project.getImplementationAtPosition(readCall.to.file, readCall.to.selectionSpan.start) ?? [];
  const implItems = impls.map(impl => prepare(project, impl.fileName, impl.textSpan.start));
  assert.equal(implItems.length, 2);
  const named = implItems.map(item => model.hierarchyName(item.name, item.containerName, item.kind === 'method'));
  assert.deepEqual(named, ['FileReader.read', 'MemoryReader.read']);
  const merged = model.toCallSites(model.rawFromResolved([{
    fromRanges: [...new Map(readCall.fromSpans.map(from => {
      const start = flowSource.getLineAndCharacterOfPosition(from.start);
      const end = flowSource.getLineAndCharacterOfPosition(from.start + from.length);
      return [`${start.line}:${start.character}`, { start, end }];
    })).values()],
    declared: { func: func('read', flowFile, 17), thirdParty: false },
    implementations: implItems.map(item => ({
      name: model.hierarchyName(item.name, item.containerName, item.kind === 'method'),
      uri: pathToFileURL(item.file).href,
      fsPath: item.file,
      range: {
        start: flowSource.getLineAndCharacterOfPosition(item.selectionSpan.start),
        end: flowSource.getLineAndCharacterOfPosition(item.selectionSpan.start + item.selectionSpan.length),
      },
    })),
  }]));
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].targets.map(item => item.func.name), ['FileReader.read', 'MemoryReader.read']);
  const choice = model.planStepInto(model.createSession(func('pick', flowFile, 16), merged));
  assert.equal(choice.action, 'choice');
  assert.equal(choice.targets.length, 2);

  const jsFile = path.join(fixture, 'src/flow.js');
  const jsSource = ts.createSourceFile(jsFile, ts.sys.readFile(jsFile), ts.ScriptTarget.Latest, true);
  const jsStart = functionAt(jsSource, 'start');
  const jsItem = prepare(project, jsFile, jsStart.name.getStart(jsSource));
  const jsCalls = project.provideCallHierarchyOutgoingCalls(jsFile, jsItem.selectionSpan.start);
  const jsNames = [];
  for (const call of jsCalls) {
    const seen = new Set();
    for (const from of call.fromSpans) {
      const line = lineOf(jsSource, from.start);
      if (seen.has(line)) continue;
      seen.add(line);
      jsNames.push(call.to.name);
    }
  }
  assert.deepEqual(jsNames, ['middle', 'leaf']);

  const jsLibFile = path.join(fixture, 'src/with-lib.js');
  const jsLibSource = ts.createSourceFile(jsLibFile, ts.sys.readFile(jsLibFile), ts.ScriptTarget.Latest, true);
  const jsUse = functionAt(jsLibSource, 'useLib');
  const jsUseItem = prepare(project, jsLibFile, jsUse.name.getStart(jsLibSource));
  const jsLibCalls = project.provideCallHierarchyOutgoingCalls(jsLibFile, jsUseItem.selectionSpan.start);
  const jsLibResolved = jsLibCalls.map(call => ({
    fromRanges: [...new Map(call.fromSpans.map(from => {
      const start = jsLibSource.getLineAndCharacterOfPosition(from.start);
      return [`${start.line}:${start.character}`, { start, end: start }];
    })).values()],
    to: {
      name: call.to.name,
      uri: pathToFileURL(call.to.file).href,
      fsPath: call.to.file,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    },
    thirdParty: model.isThirdPartyPath(call.to.file),
  }));
  const jsSites = model.toCallSites(jsLibResolved);
  assert.deepEqual(jsSites.map(item => [item.targets[0].func.name, item.targets[0].thirdParty]), [['pad', true], ['leaf', false]]);
});

const manifest = JSON.parse(ts.sys.readFile(path.join(root, 'package.json')));
check('验收1/9/10/12 清单包含入口、设置和调试器，不含明文密钥字段', () => {
  const commands = manifest.contributes.commands.map(item => item.command);
  for (const command of [
    'vscode-debugger-view.startStep',
    'vscode-debugger-view.stepOver',
    'vscode-debugger-view.stepInto',
    'vscode-debugger-view.stepOut',
  ]) {
    assert.ok(commands.includes(command), command);
  }
  const context = manifest.contributes.menus['editor/context'];
  assert.equal(context[0].command, 'vscode-debugger-view.startStep');
  assert.match(context[0].when, /typescript/);
  assert.match(context[0].when, /javascript/);
  assert.match(context[0].when, /python/);
  assert.equal(model.isSupportedLanguage('javascript'), true);
  assert.equal(model.isSupportedLanguage('python'), true);
  assert.equal(model.isSupportedLanguage('go'), false);
  assert.equal(model.isThirdPartyPath('/work/site-packages/leftpad.py'), true);
  assert.equal(model.isThirdPartyPath('/work/src/flow.py'), false);
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].id, 'vscode-debugger-view');
  assert.equal(manifest.contributes.views['vscode-debugger-view'][0].id, 'vscode-debugger-view.explain');
  assert.equal(manifest.contributes.views['vscode-debugger-view'][0].type, 'webview');
  assert.ok(manifest.contributes.configuration.properties['vscode-debugger-view.baseURL']);
  assert.ok(manifest.contributes.configuration.properties['vscode-debugger-view.model']);
  assert.equal(manifest.contributes.configuration.properties['vscode-debugger-view.apiKey'].type, 'string');
  assert.equal(manifest.contributes.debuggers[0].type, 'debugger-view');
  assert.equal(JSON.stringify(manifest).includes('sk-'), false);
});

check('验收1/3/4/5/6/7 面板渲染当前讲解、推荐候选、追问和手动进入', () => {
  const session = model.createSession(func('pick', flow, 30), pickSites);
  const planned = model.planStepInto(session);
  assert.equal(planned.action, 'choice');
  model.setRecommendation(session, 1, '第二个实现更贴近当前参数');
  const entry = model.currentEntry(session);
  const key = model.explainKey(entry);
  const html = panel.renderPanel({
    entries: session.history,
    cursor: session.cursor,
    keys: [key],
    explanations: {
      [key]: {
        summary: 'pick 把选择交给 reader.read',
        purpose: '按传入的 reader 取值',
        params: '入参 reader，出参 string',
        logic: '调用 reader.read',
        whyHere: 'start 需要选中的值',
        snippet: 'return reader.read("item")',
        fromAi: true,
      },
    },
    pending: session.pending,
    notice: undefined,
    followups: [{ question: '为什么有两个 read', answer: '接口有两个实现' }],
    configured: true,
  }, value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  assert.match(html, /<details class="node current"[^>]*open>/);
  assert.match(html, /<i class="badge">当前<\/i>pick/);
  assert.match(html, /<span class="brief">pick 把选择交给 reader\.read<\/span>/);
  assert.match(html, /结论：pick 把选择交给 reader.read/);
  assert.match(html, /作用：按传入的 reader 取值/);
  assert.match(html, /入参出参：入参 reader，出参 string/);
  assert.match(html, /关键逻辑：调用 reader.read/);
  assert.match(html, /为何在此调用：start 需要选中的值/);
  assert.equal(html.includes('<pre>'), false, '代码块应留在编辑器高亮里，不放进面板');
  const recommendAt = html.indexOf('推荐：MemoryReader.read');
  const otherAt = html.indexOf('候选 2：FileReader.read');
  assert.ok(recommendAt >= 0 && otherAt > recommendAt);
  assert.match(html, /第二个实现更贴近当前参数/);
  assert.match(html, /问：<\/b>为什么有两个 read/);
  assert.match(html, /答：<\/b>接口有两个实现/);
  assert.equal(html.includes('未配置 AI'), false);
  assert.equal(html.includes('<button id="force">'), false);
  assert.deepEqual(panel.panelCommand({ type: 'pick', index: 0 }), { command: 'vscode-debugger-view.pickCandidate', args: [0] });
  assert.deepEqual(panel.panelCommand({ type: 'ask', question: '为什么' }), { command: 'vscode-debugger-view.ask', args: ['为什么'] });
  assert.deepEqual(panel.panelCommand({ type: 'jump', index: 0 }), { command: 'vscode-debugger-view.jumpToHistory', args: [0] });

  const nested = model.createSession(func('start', flow, 9), startSites);
  model.stepOver(nested);
  replayInto(nested, 'middle');
  const nestedKeys = nested.history.map(model.explainKey);
  const nestedHtml = panel.renderPanel({
    entries: nested.history,
    cursor: nested.cursor,
    keys: nestedKeys,
    explanations: {
      [nestedKeys[0]]: { summary: 'start 组织整个流程', purpose: '', params: '', logic: '', whyHere: '', snippet: '', fromAi: true },
      [nestedKeys[nested.cursor]]: { summary: 'middle 清洗输入', purpose: '', params: '', logic: '', whyHere: '', snippet: '', fromAi: true },
    },
    pending: undefined,
    notice: undefined,
    followups: [],
    configured: true,
  }, value => value);
  assert.match(nestedHtml, /start<span> › <\/span>middle/);
  assert.match(nestedHtml, /--depth:0/);
  assert.match(nestedHtml, /--depth:1/);
  assert.equal((nestedHtml.match(/<details/g) || []).length, 3);
  assert.equal((nestedHtml.match(/<details[^>]* open>/g) || []).length, 1);
  assert.match(nestedHtml, /<span class="brief">start 组织整个流程<\/span>/);

  const stopped = model.createSession(func('useLib', '/work/src/with-lib.ts', 2), useLibSites);
  model.stepOver(stopped);
  const stoppedHtml = panel.renderPanel({
    entries: stopped.history,
    cursor: stopped.cursor,
    keys: stopped.history.map(model.explainKey),
    explanations: {},
    pending: undefined,
    notice: 'pad 来自第三方库，默认不进入。<script>',
    followups: [],
    configured: false,
  }, value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
  assert.match(stoppedHtml, /手动进入第三方库/);
  assert.match(stoppedHtml, /API Key/);
  assert.equal(panel.panelCommand({ type: 'force' }).command, 'vscode-debugger-view.forceInto');
  assert.match(stoppedHtml, /&lt;script&gt;/, '讲解文本不能把脚本原样写进页面');
  assert.equal(stoppedHtml.includes('<script>'), false);
});

await checkAsync('验收2/4 调试协议的跳过和进入会刷新调用栈', async () => {
  let session = model.createSession(func('start', flow, 9), startSites);
  const driver = {
    session: () => session,
    stepOver: async () => { model.stepOver(session); },
    stepInto: async () => {
      const plan = model.planStepInto(session);
      assert.equal(plan.action, 'enter');
      model.commitEnter(session, plan.target, sitesByName[plan.target.func.name], 'into', plan.siteIndex);
    },
    stepOut: async () => { model.stepOut(session); },
  };
  const launched = protocol.handleDebugRequest({ type: 'request', command: 'launch', seq: 1 }, driver);
  assert.equal(launched.at(-1).event, 'stopped');
  const overRequest = { type: 'request', command: 'next', seq: 2 };
  await protocol.stepRunner(overRequest, driver)();
  const over = protocol.stepResponse(overRequest);
  assert.equal(over.command, 'next');
  assert.equal(over.request_seq, 2);
  const intoRequest = { type: 'request', command: 'stepIn', seq: 3 };
  await protocol.stepRunner(intoRequest, driver)();
  const into = protocol.stepResponse(intoRequest);
  assert.equal(into.success, true);
  const traced = protocol.handleDebugRequest({ type: 'request', command: 'stackTrace', seq: 4 }, driver);
  const frames = traced[0].body.stackFrames;
  assert.deepEqual(frames.map(frame => frame.name), ['middle', 'start']);
  assert.equal(frames[0].line, 21);
  assert.equal(frames[0].source.path, flow);
  assert.equal(frames[1].line, 11);
  const variables = protocol.handleDebugRequest({ type: 'request', command: 'variables', seq: 5 }, driver);
  assert.deepEqual(variables[0].body.variables, []);
  const outRequest = { type: 'request', command: 'stepOut', seq: 6 };
  await protocol.stepRunner(outRequest, driver)();
  const out = protocol.stepResponse(outRequest);
  assert.equal(out.command, 'stepOut');
  const after = protocol.handleDebugRequest({ type: 'request', command: 'stackTrace', seq: 7 }, driver);
  assert.deepEqual(after[0].body.stackFrames.map(frame => frame.name), ['start']);
  assert.equal(after[0].body.stackFrames[0].line, 11);
});

await checkAsync('JavaScript 和 Python 的调用点进入同一套单步，第三方库按目录识别', async () => {
  const { execFileSync } = await import('node:child_process');
  const python = JSON.parse(execFileSync('python3', ['test/python-calls.py', path.join(root, 'test/fixture')], { encoding: 'utf8' }));
  assert.deepEqual(python.start.map(item => item.name), ['middle', 'leaf']);
  assert.deepEqual(python.use_lib.map(item => item.name), ['pad', 'leaf']);
  const pySites = python.use_lib.map(item => ({
    from: { start: { line: item.line - 1, character: 4 }, end: { line: item.line - 1, character: 8 } },
    targets: [{ func: func(item.name, item.file, 0), thirdParty: model.isThirdPartyPath(item.file) }],
  }));
  assert.deepEqual(pySites.map(item => [item.targets[0].func.name, item.targets[0].thirdParty]), [['pad', true], ['leaf', false]]);
  const session = model.createSession(func('use_lib', path.join(root, 'test/fixture/src/with_lib.py'), 4), pySites);
  assert.equal(model.stepOver(session).thirdPartyStop, true);
  const blocked = model.planStepInto(session);
  assert.equal(blocked.action, 'third-party');
  const forced = model.planForceEnter(session);
  assert.equal(forced.action, 'enter');
  assert.equal(forced.target.func.name, 'pad');
});

check('验收12 源码不读取 launch.json，也不要求目标项目启动', () => {
  const extension = ts.sys.readFile(path.join(root, 'src/extension.ts'));
  assert.equal(extension.includes('launch.json'), false);
  assert.equal(extension.includes('createTerminal'), false);
  assert.equal(extension.includes('node_modules'), false);
  assert.match(extension, /prepareCallHierarchy/);
  assert.match(extension, /provideOutgoingCalls/);
  assert.match(extension, /config.get<string>\('apiKey'\)/);
  assert.equal(extension.includes('secrets.store'), false);
  assert.match(extension, /workspaceState\.update/);
  assert.match(extension, /createTextEditorDecorationType/);
  assert.match(extension, /setDecorations\(focusDecoration/);
  assert.equal(ts.sys.readFile(path.join(root, 'src/panel.ts')).includes('<pre>'), false);
});

if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log('\n全部验收检查通过');
