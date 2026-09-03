import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import WebSocket from 'ws';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess } from '../../platform/spawn';
import { buildCodexAppServerArgs } from './app-server-argv';

type AppServerProcess = ReturnType<typeof spawnProcess>;

export interface CodexAppServerClientOptions {
  binary: string;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  profile?: string;
  env?: NodeJS.ProcessEnv;
  connectTimeoutMs?: number;
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

interface RpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

type NotificationListener = (notification: RpcNotification) => void;
type ServerRequestListener = (request: Record<string, unknown>) => boolean;
type DisconnectListener = (error: Error) => void;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5 * 60_000;

export class CodexAppServerClient {
  private readonly options: CodexAppServerClientOptions;
  private child: AppServerProcess | undefined;
  private socket: WebSocket | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly serverRequestListeners = new Set<ServerRequestListener>();
  private readonly disconnectListeners = new Set<DisconnectListener>();
  private starting: Promise<void> | undefined;
  private closing = false;
  private endpointValue: string | undefined;
  private websocketUrl: string | undefined;
  private stderrTail = '';

  constructor(options: CodexAppServerClientOptions) {
    this.options = options;
  }

  get endpoint(): string | undefined {
    return this.endpointValue;
  }

  get processId(): number | undefined {
    return this.child?.pid;
  }

  async start(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.starting) return this.starting;
    this.starting = this.startInner().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    await this.start();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Codex app-server is not connected');
    }
    const id = this.nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ method, id, ...(params === undefined ? {} : { params }) }), (err) => {
        if (!err) return;
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  notify(method: string, params?: unknown): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ method, ...(params === undefined ? {} : { params }) }));
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(listener: ServerRequestListener): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  onDisconnect(listener: DisconnectListener): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  respond(id: number | string, result: unknown): void {
    this.socket?.send(JSON.stringify({ id, result }));
  }

  respondError(id: number | string, code: number, message: string): void {
    this.socket?.send(JSON.stringify({ id, error: { code, message } }));
  }

  async close(): Promise<void> {
    this.closing = true;
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    this.rejectPending(new Error('Codex app-server connection closed'));
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        resolve();
      }, 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async startInner(): Promise<void> {
    this.closing = false;
    await mkdir(this.options.profileStateDir, { recursive: true });
    const transport = await createTransport();
    this.endpointValue = transport.endpoint;
    this.websocketUrl = transport.websocketUrl;

    const envOverrides: NodeJS.ProcessEnv = {};
    if (this.options.codexHome) {
      envOverrides.CODEX_HOME = this.options.codexHome;
    } else if (this.options.inheritCodexHome === false) {
      envOverrides.CODEX_HOME = join(this.options.profileStateDir, 'codex-home');
    }
    const args = buildCodexAppServerArgs({
      endpoint: transport.endpoint,
    });
    const child = spawnProcess(this.options.binary, args, {
      env: mergeProcessEnv(mergeProcessEnv(process.env, this.options.env), envOverrides),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.child = child;
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-4_096);
    });
    child.once('error', (err) => this.handleDisconnect(err));
    child.once('exit', (code, signal) => {
      const detail = this.stderrTail.trim();
      this.handleDisconnect(
        new Error(
          `Codex app-server exited (${code ?? signal ?? 'unknown'})${detail ? `: ${detail}` : ''}`,
        ),
      );
    });

    const socket = await connectWithRetry(
      transport.websocketUrl,
      child,
      this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    );
    this.socket = socket;
    socket.on('message', (data) => this.handleMessage(String(data)));
    socket.on('error', (err) => this.handleDisconnect(err));
    socket.on('close', () => {
      if (!this.closing) this.handleDisconnect(new Error('Codex app-server websocket closed'));
    });

    await this.requestWithoutStart('initialize', {
      clientInfo: {
        name: 'lark_channel_bridge',
        title: 'Lark Channel Bridge',
        version: '0.7.0',
      },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized', {});
    log.info('codex-app-server', 'connected', {
      endpoint: transport.endpoint,
      profile: this.options.profile ?? 'default',
      pid: child.pid ?? null,
    });
  }

  private requestWithoutStart(method: string, params?: unknown): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Codex app-server websocket is not open'));
    }
    const id = this.nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ method, id, params }), (err) => {
        if (!err) return;
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  private handleMessage(text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      log.warn('codex-app-server', 'invalid-json', { text: text.slice(0, 300) });
      return;
    }
    if (!isRecord(message)) return;
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const response = message as unknown as RpcResponse;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.error) {
        pending.reject(new Error(response.error.message ?? `Codex RPC ${response.error.code ?? 'error'}`));
      } else {
        pending.resolve(response.result);
      }
      return;
    }
    if (message.id !== undefined && typeof message.method === 'string') {
      for (const listener of this.serverRequestListeners) {
        if (listener(message)) return;
      }
      this.respondError(message.id as number | string, -32601, `Unhandled client request: ${message.method}`);
      return;
    }
    if (typeof message.method === 'string') {
      const notification: RpcNotification = {
        method: message.method,
        ...(message.params === undefined ? {} : { params: message.params }),
      };
      for (const listener of this.notificationListeners) listener(notification);
    }
  }

  private handleDisconnect(error: Error): void {
    if (this.closing) return;
    this.socket = undefined;
    this.rejectPending(error);
    for (const listener of this.disconnectListeners) listener(error);
    log.warn('codex-app-server', 'disconnected', { message: error.message });
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

async function createTransport(): Promise<{ endpoint: string; websocketUrl: string }> {
  const port = await reserveTcpPort();
  const endpoint = `ws://127.0.0.1:${port}`;
  return { endpoint, websocketUrl: endpoint };
}

async function reserveTcpPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function connectWithRetry(
  url: string,
  child: AppServerProcess,
  timeoutMs: number,
): Promise<WebSocket> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error = new Error('Codex app-server did not accept a connection');
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Codex app-server exited before accepting connections: ${child.exitCode ?? child.signalCode}`);
    }
    try {
      return await openWebSocket(url);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      await delay(80);
    }
  }
  throw lastError;
}

function openWebSocket(url: string): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url);
    const onOpen = (): void => {
      socket.off('error', onError);
      resolve(socket);
    };
    const onError = (err: Error): void => {
      socket.off('open', onOpen);
      socket.close();
      reject(err);
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
