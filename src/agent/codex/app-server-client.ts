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
  requestTimeoutMs?: number;
}

export interface RpcRequestOptions {
  timeoutMs?: number;
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
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const CHILD_TERMINATE_GRACE_MS = 2_000;

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
  private cleanup: Promise<void> = Promise.resolve();
  private generation = 0;
  private closed = false;
  private endpointValue: string | undefined;
  private websocketUrl: string | undefined;

  constructor(options: CodexAppServerClientOptions) {
    this.options = options;
  }

  get endpoint(): string | undefined {
    return this.endpointValue;
  }

  get processId(): number | undefined {
    return this.child?.pid;
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Codex app-server client is closed'));
    if (this.starting) return this.starting;
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    const generation = ++this.generation;
    const starting = this.startAfterCleanup(generation);
    this.starting = starting;
    void starting.then(
      () => {
        if (this.starting === starting) this.starting = undefined;
      },
      () => {
        if (this.starting === starting) this.starting = undefined;
      },
    );
    return starting;
  }

  async request(
    method: string,
    params?: unknown,
    options: RpcRequestOptions = {},
  ): Promise<unknown> {
    await this.start();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Codex app-server is not connected');
    }
    return this.requestOnSocket(socket, method, params, options);
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
    this.closed = true;
    this.generation++;
    const socket = this.socket;
    this.socket = undefined;
    const child = this.child;
    this.child = undefined;
    this.endpointValue = undefined;
    this.websocketUrl = undefined;
    this.rejectPending(new Error('Codex app-server connection closed'));
    await this.cleanupResources(child, socket);
    await this.starting?.catch(() => undefined);
    await this.cleanup;
  }

  private async startAfterCleanup(generation: number): Promise<void> {
    await this.cleanup;
    this.assertStartCurrent(generation);
    await this.startInner(generation);
  }

  private async startInner(generation: number): Promise<void> {
    let child: AppServerProcess | undefined;
    let socket: WebSocket | undefined;
    try {
      await mkdir(this.options.profileStateDir, { recursive: true });
      this.assertStartCurrent(generation);
      const transport = await createTransport();
      this.assertStartCurrent(generation);
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
      child = spawnProcess(this.options.binary, args, {
        env: mergeProcessEnv(mergeProcessEnv(process.env, this.options.env), envOverrides),
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      this.child = child;
      let stderrTail = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-4_096);
      });
      child.once('error', (err) => this.handleDisconnect(err, child!));
      child.once('exit', (code, signal) => {
        const detail = stderrTail.trim();
        this.handleDisconnect(
          new Error(
            `Codex app-server exited (${code ?? signal ?? 'unknown'})${detail ? `: ${detail}` : ''}`,
          ),
          child!,
        );
      });

      socket = await connectWithRetry(
        transport.websocketUrl,
        child,
        this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        () => this.closed || this.generation !== generation,
      );
      this.assertStartCurrent(generation);
      this.socket = socket;
      socket.on('message', (data) => this.handleMessage(String(data)));
      socket.on('error', (err) => this.handleDisconnect(err, child!, socket!));
      socket.on('close', () => {
        if (!this.closed) {
          this.handleDisconnect(new Error('Codex app-server websocket closed'), child!, socket!);
        }
      });

      await this.requestWithoutStart('initialize', {
        clientInfo: {
          name: 'lark_channel_bridge',
          title: 'Lark Channel Bridge',
          version: '0.7.0',
        },
        capabilities: { experimentalApi: true },
      });
      this.assertStartCurrent(generation);
      this.notify('initialized', {});
      log.info('codex-app-server', 'connected', {
        endpoint: transport.endpoint,
        profile: this.options.profile ?? 'default',
        pid: child.pid ?? null,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (this.generation === generation) this.generation++;
      if (this.child === child) this.child = undefined;
      if (this.socket === socket) this.socket = undefined;
      this.endpointValue = undefined;
      this.websocketUrl = undefined;
      this.rejectPending(error);
      await this.cleanupResources(child, socket);
      throw error;
    }
  }

  private requestWithoutStart(
    method: string,
    params?: unknown,
    options: RpcRequestOptions = {},
  ): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Codex app-server websocket is not open'));
    }
    return this.requestOnSocket(socket, method, params, options);
  }

  private requestOnSocket(
    socket: WebSocket,
    method: string,
    params: unknown,
    options: RpcRequestOptions,
  ): Promise<unknown> {
    const id = this.nextRequestId++;
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.takePending(id);
        pending?.reject(new Error(`Codex RPC ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(
          JSON.stringify({ method, id, ...(params === undefined ? {} : { params }) }),
          (err) => {
            if (!err) return;
            this.takePending(id)?.reject(err);
          },
        );
      } catch (err) {
        this.takePending(id)?.reject(err instanceof Error ? err : new Error(String(err)));
      }
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
      const pending = this.takePending(response.id);
      if (!pending) return;
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

  private handleDisconnect(
    error: Error,
    child: AppServerProcess,
    socket?: WebSocket,
  ): void {
    if (this.closed || this.child !== child) return;
    if (socket && this.socket && this.socket !== socket) return;
    this.generation++;
    const currentSocket = this.socket;
    this.socket = undefined;
    this.child = undefined;
    this.endpointValue = undefined;
    this.websocketUrl = undefined;
    this.rejectPending(error);
    const cleanup = this.cleanupResources(child, socket ?? currentSocket);
    void cleanup.catch((cleanupError) => {
      log.warn('codex-app-server', 'cleanup-failed', { message: String(cleanupError) });
    });
    for (const listener of this.disconnectListeners) listener(error);
    log.warn('codex-app-server', 'disconnected', { message: error.message });
  }

  private assertStartCurrent(generation: number): void {
    if (this.closed || this.generation !== generation) {
      throw new Error('Codex app-server start was cancelled');
    }
  }

  private cleanupResources(
    child: AppServerProcess | undefined,
    socket: WebSocket | undefined,
  ): Promise<void> {
    const cleanup = async (): Promise<void> => {
      terminateSocket(socket);
      await terminateChild(child);
    };
    const next = this.cleanup.then(cleanup, cleanup);
    this.cleanup = next.catch(() => undefined);
    return next;
  }

  private takePending(id: number | string): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    return pending;
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

function terminateSocket(socket: WebSocket | undefined): void {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  try {
    socket.terminate();
  } catch {
    try {
      socket.close();
    } catch {
      // Best-effort; terminating the child below also closes the local socket.
    }
  }
}

async function terminateChild(child: AppServerProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  if (await waitForChildExit(child, CHILD_TERMINATE_GRACE_MS)) return;
  try {
    child.kill('SIGKILL');
  } catch {
    return;
  }
  await waitForChildExit(child, CHILD_TERMINATE_GRACE_MS);
}

function waitForChildExit(child: AppServerProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(child.exitCode !== null || child.signalCode !== null);
    }, timeoutMs);
    child.once('exit', onExit);
  });
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
  isCancelled: () => boolean,
): Promise<WebSocket> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error = new Error('Codex app-server did not accept a connection');
  while (Date.now() < deadline) {
    if (isCancelled()) throw new Error('Codex app-server start was cancelled');
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Codex app-server exited before accepting connections: ${child.exitCode ?? child.signalCode}`);
    }
    try {
      return await openWebSocket(url);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (isCancelled()) throw new Error('Codex app-server start was cancelled');
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
