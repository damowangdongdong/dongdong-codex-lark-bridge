import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/agent/codex/adapter.js';
import type { AgentEvent, AgentExternalRun } from '../../src/agent/types.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

describe.skipIf(process.platform === 'win32')('CodexAdapter app-server process contract', () => {
  const cleanup: string[] = [];
  const adapters: CodexAdapter[] = [];
  const oldCodexHome = process.env.CODEX_HOME;

  afterEach(async () => {
    await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('starts a profiled app-server and streams a complete new turn', async () => {
    const fake = await createFakeCodex();
    cleanup.push(fake.dir);
    const codexHome = join(fake.dir, 'codex-home');
    await mkdir(codexHome);
    await writeFile(join(codexHome, 'freerouter.config.toml'), `
model = "free-model"
[model_providers.freerouter]
base_url = "https://example.test/v1"
experimental_bearer_token = "secret-token"
`);
    process.env.CODEX_HOME = codexHome;
    const cwd = await realpath(fake.dir);
    const adapter = track(
      new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir }),
      adapters,
    );
    adapter.setBotIdentity({ openId: 'ou_bot_self', name: 'Bridge' });
    const run = adapter.run({
      runId: 'run-new',
      prompt: 'hello from lark',
      cwd,
      profile: 'freerouter',
      sandbox: 'workspace-write',
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: 'thread-new', cwd, model: 'fake-model' },
      { type: 'text', delta: 'Working.' },
      {
        type: 'tool_use',
        id: 'cmd-1',
        name: 'command_execution',
        input: { command: 'pwd', cwd },
      },
      { type: 'tool_progress', id: 'cmd-1', delta: `${cwd}\n` },
      { type: 'tool_result', id: 'cmd-1', output: `${cwd}\n`, isError: false },
      { type: 'final_text', content: 'Done.' },
      {
        type: 'usage',
        inputTokens: 5,
        outputTokens: 2,
        cachedInputTokens: 1,
        reasoningOutputTokens: 0,
      },
      { type: 'done', threadId: 'thread-new', terminationReason: 'normal' },
    ]);

    const record = await readRecord(fake.recordPath);
    expect(record.argv).not.toContain('--profile');
    expect(record.argv).not.toContain('--ignore-rules');
    expect(record.argv.join(' ')).not.toContain('secret-token');
    expect(record.env.CODEX_HOME).toBe(codexHome);
    expect(record.messages.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'thread/goal/get',
      'turn/start',
    ]);
    const threadStart = record.messages.find((message) => message.method === 'thread/start');
    expect(threadStart?.params).toMatchObject({
      config: {
        model: 'free-model',
        model_providers: {
          freerouter: {
            base_url: 'https://example.test/v1',
            experimental_bearer_token: 'secret-token',
          },
        },
      },
    });
    const turnStart = record.messages.find((message) => message.method === 'turn/start');
    expect(turnStart?.params).toMatchObject({
      threadId: 'thread-new',
      cwd,
      approvalPolicy: 'never',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
    expect(JSON.stringify(turnStart?.params)).not.toContain('readOnlyAccess');
    expect(JSON.stringify(turnStart?.params)).toContain('hello from lark');
    expect(JSON.stringify(turnStart?.params)).toContain('ou_bot_self');
    expect(run.remoteSession?.()).toMatchObject({ threadId: 'thread-new', profile: 'freerouter' });
    expect(run.remoteSession?.().endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:/);
  });

  it('resumes a thread, steers the active turn, and interrupts it', async () => {
    const fake = await createFakeCodex({ keepTurnOpen: true });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const adapter = track(
      new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir }),
      adapters,
    );
    const run = adapter.run({
      runId: 'run-resume',
      prompt: 'continue',
      cwd,
      threadId: 'thread-old',
      sandbox: 'read-only',
    });
    const iterator = run.events[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'system', threadId: 'thread-old', cwd, model: 'fake-model' },
    });
    await waitForMethod(fake.recordPath, 'turn/start');
    await run.steer?.('insert now');
    await waitForMethod(fake.recordPath, 'turn/steer');
    await run.stop();
    expect(await collectIterator(iterator)).toEqual([
      { type: 'done', threadId: 'thread-old', terminationReason: 'interrupted' },
    ]);

    const record = await readRecord(fake.recordPath);
    expect(record.argv).not.toContain('--profile');
    expect(record.messages.map((message) => message.method)).toContain('thread/resume');
    expect(record.messages.find((message) => message.method === 'turn/steer')?.params).toMatchObject({
      threadId: 'thread-old',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'insert now', text_elements: [] }],
    });
    expect(record.messages.find((message) => message.method === 'turn/interrupt')?.params).toEqual({
      threadId: 'thread-old',
      turnId: 'turn-1',
    });
    expect(record.messages.find((message) => message.method === 'turn/start')?.params).toMatchObject({
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
  });

  it('ends an active run with a visible error when the app-server disconnects', async () => {
    const fake = await createFakeCodex({ keepTurnOpen: true });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const adapter = track(
      new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir }),
      adapters,
    );
    const run = adapter.run({ runId: 'run-disconnect', prompt: 'stay open', cwd });
    const iterator = run.events[Symbol.asyncIterator]();

    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { type: 'system', threadId: 'thread-new' },
    });
    await waitForMethod(fake.recordPath, 'turn/start');
    await adapter.appServerRequest(undefined, 'test/disconnect', {});

    const tail = await within(collectIterator(iterator), 2_000);
    expect(tail).toHaveLength(1);
    expect(tail[0]).toMatchObject({ type: 'error', terminationReason: 'failed' });
    expect((tail[0] as Extract<AgentEvent, { type: 'error' }>).message).toContain(
      'Codex app-server disconnected',
    );
    await expect(run.waitForExit(50)).resolves.toBe(true);
  });

  it('publishes turns started by another attached client for the bound Feishu scope', async () => {
    const fake = await createFakeCodex();
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const adapter = track(
      new CodexAdapter({ binary: fake.path, profileStateDir: fake.dir }),
      adapters,
    );
    const first = adapter.run({ runId: 'run-bind', prompt: 'bind', cwd });
    await collect(first.events);
    adapter.bindRemoteThread({
      scopeId: 'chat-1',
      chatId: 'chat-1',
      threadId: 'thread-new',
      operatorOpenId: 'ou-user',
      cwd,
      sandbox: 'workspace-write',
    });
    const externalPromise = new Promise<AgentExternalRun>((resolve) => {
      const unsubscribe = adapter.onExternalRun((external) => {
        unsubscribe();
        resolve(external);
      });
    });

    await adapter.appServerRequest(undefined, 'thread/goal/set', {
      threadId: 'thread-new',
      objective: 'Ship the bridge',
      status: 'active',
    });
    await adapter.appServerRequest(undefined, 'test/externalTurn', {});
    const external = await externalPromise;

    expect(external.binding).toMatchObject({ scopeId: 'chat-1', threadId: 'thread-new' });
    expect(await collect(external.run.events)).toEqual([
      { type: 'system', threadId: 'thread-new', cwd },
      {
        type: 'goal_update',
        goal: {
          objective: 'Ship the bridge',
          status: 'active',
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 10,
          updatedAt: 10,
          observedAtMs: expect.any(Number),
        },
      },
      { type: 'user_text', content: 'typed in terminal' },
      { type: 'final_text', content: 'terminal answer' },
      { type: 'done', threadId: 'thread-new', terminationReason: 'normal' },
    ]);
  });

  it('requires cwd before starting an app-server run', () => {
    const adapter = track(
      new CodexAdapter({ binary: 'unused', profileStateDir: tmpdir() }),
      adapters,
    );
    expect(() => adapter.run({ runId: 'missing-cwd', prompt: 'hi' })).toThrow(/cwd is required/);
  });
});

function track(adapter: CodexAdapter, adapters: CodexAdapter[]): CodexAdapter {
  adapters.push(adapter);
  return adapter;
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  return collectIterator(events[Symbol.asyncIterator]());
}

async function collectIterator(iterator: AsyncIterator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) return out;
    out.push(next.value);
  }
}

async function createFakeCodex(options: { keepTurnOpen?: boolean } = {}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-app-server-test-'));
  const path = join(dir, 'fake-codex.mjs');
  const recordPath = join(dir, 'record.json');
  const wsEntry = createRequire(import.meta.url).resolve('ws');
  await writeFile(
    path,
    `#!${process.execPath}\n${fakeServerSource({ recordPath, wsEntry, ...options })}`,
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

function fakeServerSource(input: {
  recordPath: string;
  wsEntry: string;
  keepTurnOpen?: boolean;
}): string {
  return `
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import ws from ${JSON.stringify(input.wsEntry)};
const { WebSocketServer } = ws;

const argv = process.argv.slice(2);
const endpoint = argv[argv.indexOf('--listen') + 1];
const listenUrl = new URL(endpoint);
const recordPath = ${JSON.stringify(input.recordPath)};
const messages = [];
const record = () => writeFileSync(recordPath, JSON.stringify({
  argv,
  messages,
  env: {
    CODEX_HOME: process.env.CODEX_HOME,
    LARK_CHANNEL: process.env.LARK_CHANNEL,
    LARK_CHANNEL_PROFILE: process.env.LARK_CHANNEL_PROFILE,
  },
}));
record();

const server = createServer();
const wss = new WebSocketServer({ server });
wss.on('connection', (socket) => {
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    messages.push(message);
    record();
    const respond = (result) => socket.send(JSON.stringify({ id: message.id, result }));
    const notify = (method, params) => socket.send(JSON.stringify({ method, params }));
    if (message.method === 'initialize') return respond({ userAgent: 'fake', platformFamily: 'unix', platformOs: 'linux' });
    if (message.method === 'initialized') return;
    if (message.method === 'thread/start') return respond({ thread: { id: 'thread-new' }, cwd: message.params.cwd, model: 'fake-model' });
    if (message.method === 'thread/resume') return respond({ thread: { id: message.params.threadId }, cwd: message.params.cwd, model: 'fake-model' });
    if (message.method === 'thread/goal/get') return respond({ goal: null });
    if (message.method === 'thread/goal/set') return respond({ goal: {
      threadId: message.params.threadId,
      objective: message.params.objective,
      status: message.params.status,
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 10,
      updatedAt: 10,
    } });
    if (message.method === 'turn/start') {
      respond({ turn: { id: 'turn-1', status: 'inProgress' } });
      if (${JSON.stringify(Boolean(input.keepTurnOpen))}) return;
      const base = { threadId: message.params.threadId, turnId: 'turn-1' };
      notify('item/started', { ...base, item: { id: 'commentary', type: 'agentMessage', phase: 'commentary' } });
      notify('item/agentMessage/delta', { ...base, itemId: 'commentary', delta: 'Working.' });
      notify('item/started', { ...base, item: { id: 'cmd-1', type: 'commandExecution', command: 'pwd', cwd: message.params.cwd } });
      notify('item/commandExecution/outputDelta', { ...base, itemId: 'cmd-1', delta: message.params.cwd + '\\n' });
      notify('item/completed', { ...base, item: { id: 'cmd-1', type: 'commandExecution', aggregatedOutput: message.params.cwd + '\\n', exitCode: 0 } });
      notify('item/completed', { ...base, item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Done.' } });
      notify('thread/tokenUsage/updated', { ...base, tokenUsage: { last: { inputTokens: 5, outputTokens: 2, cachedInputTokens: 1, reasoningOutputTokens: 0 } } });
      notify('turn/completed', { ...base, turn: { id: 'turn-1', status: 'completed' } });
      return;
    }
    if (message.method === 'turn/steer') return respond({ turnId: 'turn-1' });
    if (message.method === 'test/disconnect') {
      respond({});
      return setTimeout(() => process.exit(17), 10);
    }
    if (message.method === 'test/externalTurn') {
      respond({});
      const base = { threadId: 'thread-new', turnId: 'turn-external' };
      notify('turn/started', { ...base, turn: { id: 'turn-external', status: 'inProgress' } });
      notify('item/started', { ...base, item: { id: 'user-external', type: 'userMessage', content: [{ type: 'text', text: 'typed in terminal' }] } });
      notify('item/completed', { ...base, item: { id: 'user-external', type: 'userMessage', content: [{ type: 'text', text: 'typed in terminal' }] } });
      notify('item/completed', { ...base, item: { id: 'answer-external', type: 'agentMessage', phase: 'final_answer', text: 'terminal answer' } });
      notify('turn/completed', { ...base, turn: { id: 'turn-external', status: 'completed' } });
      return;
    }
    if (message.method === 'turn/interrupt') {
      respond({});
      notify('turn/completed', { threadId: message.params.threadId, turnId: message.params.turnId, turn: { id: message.params.turnId, status: 'interrupted' } });
    }
  });
});
server.listen(Number(listenUrl.port), listenUrl.hostname);
const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`;
}

async function readRecord(path: string): Promise<{
  argv: string[];
  messages: Array<{ method: string; params?: Record<string, unknown> }>;
  env: { CODEX_HOME?: string; LARK_CHANNEL?: string; LARK_CHANNEL_PROFILE?: string };
}> {
  return JSON.parse(await readFile(path, 'utf8')) as {
    argv: string[];
    messages: Array<{ method: string; params?: Record<string, unknown> }>;
    env: { CODEX_HOME?: string; LARK_CHANNEL?: string; LARK_CHANNEL_PROFILE?: string };
  };
}

async function waitForMethod(path: string, method: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const record = await readRecord(path).catch(() => undefined);
    if (record?.messages.some((message) => message.method === method)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`fake app-server did not receive ${method}`);
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
