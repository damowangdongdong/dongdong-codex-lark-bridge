import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServerClient } from '../../src/agent/codex/app-server-client.js';

interface FakeCodex {
  path: string;
  dir: string;
  pidPath: string;
  recordPath: string;
}

type FakeMode = 'never-listen' | 'server' | 'delayed-initialize';

describe.skipIf(process.platform === 'win32')('CodexAppServerClient process lifecycle', () => {
  const clients: CodexAppServerClient[] = [];
  const fakes: FakeCodex[] = [];

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    for (const fake of fakes.splice(0)) {
      await stopRecordedProcesses(fake.pidPath);
      await rm(fake.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    }
  });

  it('terminates every child when connection startup times out, including retries', async () => {
    const fake = await createFakeCodex('never-listen');
    fakes.push(fake);
    const client = track(new CodexAppServerClient({
      binary: fake.path,
      profileStateDir: fake.dir,
      connectTimeoutMs: 120,
      requestTimeoutMs: 120,
    }), clients);

    await expect(client.start()).rejects.toThrow();
    const firstPid = (await readPids(fake.pidPath))[0];
    expect(firstPid).toBeTypeOf('number');
    await expectProcessDead(firstPid!);
    expect(client.processId).toBeUndefined();

    await expect(client.start()).rejects.toThrow();
    const pids = await readPids(fake.pidPath);
    expect(pids).toHaveLength(2);
    expect(pids[1]).not.toBe(firstPid);
    await Promise.all(pids.map(expectProcessDead));
  });

  it('terminates a live child after its websocket closes before reconnecting', async () => {
    const fake = await createFakeCodex('server');
    fakes.push(fake);
    const client = track(new CodexAppServerClient({
      binary: fake.path,
      profileStateDir: fake.dir,
      connectTimeoutMs: 500,
      requestTimeoutMs: 500,
    }), clients);
    await client.start();
    const oldPid = client.processId;
    expect(oldPid).toBeTypeOf('number');
    const disconnected = new Promise<void>((resolve) => {
      const unsubscribe = client.onDisconnect(() => {
        unsubscribe();
        resolve();
      });
    });

    await client.request('test/closeSocket');
    await within(disconnected, 1_000);
    await client.start();

    expect(client.processId).toBeTypeOf('number');
    expect(client.processId).not.toBe(oldPid);
    await expectProcessDead(oldPid!);
    expect(await client.request('test/ping')).toBe('pong');
  });

  it('times out an ignored RPC and ignores its late response', async () => {
    const fake = await createFakeCodex('server');
    fakes.push(fake);
    const client = track(new CodexAppServerClient({
      binary: fake.path,
      profileStateDir: fake.dir,
      connectTimeoutMs: 500,
      requestTimeoutMs: 500,
    }), clients);
    await client.start();

    await expect(client.request('test/slow', undefined, { timeoutMs: 40 })).rejects.toThrow(
      'Codex RPC test/slow timed out after 40ms',
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(client.request('test/ping')).resolves.toBe('pong');
  });

  it('cancels an in-progress startup and cannot spawn again after close', async () => {
    const fake = await createFakeCodex('delayed-initialize');
    fakes.push(fake);
    const client = track(new CodexAppServerClient({
      binary: fake.path,
      profileStateDir: fake.dir,
      connectTimeoutMs: 500,
      requestTimeoutMs: 2_000,
    }), clients);
    const starting = client.start();
    await waitForMethod(fake.recordPath, 'initialize');
    const pid = client.processId;
    expect(pid).toBeTypeOf('number');

    await client.close();

    await expect(starting).rejects.toThrow();
    await expect(client.start()).rejects.toThrow('Codex app-server client is closed');
    await expectProcessDead(pid!);
    expect(await readPids(fake.pidPath)).toEqual([pid]);
  });
});

function track(
  client: CodexAppServerClient,
  clients: CodexAppServerClient[],
): CodexAppServerClient {
  clients.push(client);
  return client;
}

async function createFakeCodex(mode: FakeMode): Promise<FakeCodex> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-app-server-lifecycle-'));
  const path = join(dir, 'fake-codex.mjs');
  const pidPath = join(dir, 'pids.txt');
  const recordPath = join(dir, 'record.json');
  const wsEntry = createRequire(import.meta.url).resolve('ws');
  await writeFile(path, `#!${process.execPath}\n${fakeServerSource({
    mode,
    pidPath,
    recordPath,
    wsEntry,
  })}`, 'utf8');
  await chmod(path, 0o755);
  return { path, dir, pidPath, recordPath };
}

function fakeServerSource(input: {
  mode: FakeMode;
  pidPath: string;
  recordPath: string;
  wsEntry: string;
}): string {
  return `
import { appendFileSync, writeFileSync } from 'node:fs';
import ws from ${JSON.stringify(input.wsEntry)};
const { WebSocketServer } = ws;

appendFileSync(${JSON.stringify(input.pidPath)}, String(process.pid) + '\\n');
const methods = [];
const record = () => writeFileSync(${JSON.stringify(input.recordPath)}, JSON.stringify({ methods }));
record();
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

if (${JSON.stringify(input.mode)} === 'never-listen') {
  setInterval(() => {}, 1_000);
} else {
  const argv = process.argv.slice(2);
  const endpoint = new URL(argv[argv.indexOf('--listen') + 1]);
  const wss = new WebSocketServer({ port: Number(endpoint.port), host: endpoint.hostname });
  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      methods.push(message.method);
      record();
      const respond = (result) => socket.send(JSON.stringify({ id: message.id, result }));
      if (message.method === 'initialize') {
        if (${JSON.stringify(input.mode)} === 'delayed-initialize') {
          return setTimeout(() => respond({ userAgent: 'fake' }), 1_000);
        }
        return respond({ userAgent: 'fake' });
      }
      if (message.method === 'initialized') return;
      if (message.method === 'test/closeSocket') {
        respond({});
        return setTimeout(() => socket.close(), 10);
      }
      if (message.method === 'test/slow') {
        return setTimeout(() => respond('late'), 120);
      }
      if (message.method === 'test/ping') return respond('pong');
    });
  });
}
`;
}

async function readPids(path: string): Promise<number[]> {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text.split(/\s+/).filter(Boolean).map(Number);
}

async function waitForMethod(path: string, method: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const record = await readFile(path, 'utf8')
      .then((text) => JSON.parse(text) as { methods?: string[] })
      .catch(() => undefined);
    if (record?.methods?.includes(method)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`fake app-server did not receive ${method}`);
}

async function expectProcessDead(pid: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(isProcessAlive(pid), `process ${pid} is still alive`).toBe(false);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopRecordedProcesses(path: string): Promise<void> {
  for (const pid of await readPids(path)) {
    if (!isProcessAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The process exited between the liveness check and signal.
    }
  }
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
