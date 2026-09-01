import { join } from 'node:path';
import { loadCodexProfileConfig, resolveCodexHome } from '../../config/codex-profiles';
import type { SandboxMode } from '../../config/profile-schema';
import { log } from '../../core/logger';
import { SpawnFailed } from '../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentExternalRun,
  AgentRemoteThreadBinding,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { CodexAppServerClient, type RpcNotification } from './app-server-client';
import { CodexAppServerEventTranslator } from './app-server-events';
import {
  findThreadWriterPids,
  isCodexProcess,
  terminateProcess,
} from './thread-writer';

export interface CodexAdapterOptions {
  binary: string;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  sandbox?: SandboxMode;
  profile?: string;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex CLI';

  private readonly options: CodexAdapterOptions;
  private readonly clients = new Map<string, CodexAppServerClient>();
  private readonly remoteBindings = new Map<string, AgentRemoteThreadBinding>();
  private readonly bridgeActiveThreads = new Set<string>();
  private readonly externalRuns = new Map<string, CodexExternalRun>();
  private readonly externalRunListeners = new Set<(run: AgentExternalRun) => void>();
  private botIdentity: AgentBotIdentity | undefined;

  constructor(options: CodexAdapterOptions) {
    this.options = options;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'codex',
      agentName: 'Codex CLI',
      command: this.options.binary,
      binaryPath: this.options.binary,
    });
  }

  async prepareRun(options?: AgentRunOptions): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'codex binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
    try {
      if (options) await this.clientFor(options.profile).start();
    } catch (err) {
      throw new SpawnFailed('codex app-server failed to start', err, 'agent-prepare-failed');
    }
  }

  run(options: AgentRunOptions): AgentRun {
    if (!options.cwd) throw new Error('cwd is required for CodexAdapter.run');
    const profile = options.profile ?? this.options.profile;
    const codexHome = this.codexHome();
    const client = this.clientFor(profile);
    return new CodexAppServerRun({
      client,
      options: {
        ...options,
        cwd: options.cwd,
        sandbox: options.sandbox ?? this.options.sandbox ?? 'danger-full-access',
        profile,
      },
      ...(profile
        ? {
            loadProfileConfig: () => loadCodexProfileConfig({
              cwd: options.cwd!,
              codexHome,
              profile,
            }),
          }
        : {}),
      botIdentity: this.botIdentity,
      setBridgeThreadActive: (selectedProfile, threadId, active) => {
        this.setBridgeThreadActive(selectedProfile, threadId, active);
      },
    });
  }

  async close(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(clients.map((client) => client.close()));
  }

  async appServerRequest(
    profile: string | undefined,
    method: string,
    params?: unknown,
  ): Promise<unknown> {
    return this.clientFor(profile).request(method, params);
  }

  async appServerEndpoint(profile?: string): Promise<string> {
    const client = this.clientFor(profile);
    await client.start();
    if (!client.endpoint) throw new Error('Codex app-server returned no endpoint');
    return client.endpoint;
  }

  async takeoverThreadWriter(threadId: string): Promise<{ terminatedPids: number[] }> {
    const pids = await findThreadWriterPids(this.codexHome(), threadId);
    if (pids.includes(process.pid)) {
      throw new Error('thread writer 由当前 bridge 进程持有，无法安全接管');
    }

    const owned = new Map<number, { key: string; client: CodexAppServerClient }>();
    for (const [key, client] of this.clients.entries()) {
      if (client.processId) owned.set(client.processId, { key, client });
    }

    const externalPids = pids.filter((pid) => !owned.has(pid));
    for (const pid of externalPids) {
      if (!await isCodexProcess(pid, this.options.binary)) {
        throw new Error(`thread writer 进程 ${pid} 不是 Codex，已拒绝终止`);
      }
    }

    const terminatedPids: number[] = [];
    for (const pid of pids) {
      const ownedClient = owned.get(pid);
      if (ownedClient) {
        await ownedClient.client.close();
        this.clients.delete(ownedClient.key);
      } else {
        await terminateProcess(pid);
      }
      terminatedPids.push(pid);
    }
    return { terminatedPids };
  }

  bindRemoteThread(binding: AgentRemoteThreadBinding): void {
    this.remoteBindings.set(remoteThreadKey(binding.profile, binding.threadId), { ...binding });
  }

  onExternalRun(listener: (run: AgentExternalRun) => void): () => void {
    this.externalRunListeners.add(listener);
    return () => this.externalRunListeners.delete(listener);
  }

  private clientFor(profile: string | undefined): CodexAppServerClient {
    const selected = profile ?? this.options.profile;
    const key = selected ?? '';
    const existing = this.clients.get(key);
    if (existing) return existing;
    const client = new CodexAppServerClient({
      binary: this.options.binary,
      profileStateDir: join(
        this.options.profileStateDir,
        'codex-app-server',
        selected ? safeSegment(selected) : 'default',
      ),
      codexHome: this.codexHome(),
      profile: selected,
      env: buildLarkChannelEnv(this.options.larkChannel),
    });
    client.onNotification((notification) => {
      this.handleAdapterNotification(selected, client, notification);
    });
    this.clients.set(key, client);
    return client;
  }

  private codexHome(): string {
    return resolveCodexHome({
      cwd: process.cwd(),
      codexHome: this.options.codexHome,
      inheritCodexHome: this.options.inheritCodexHome,
      profileStateDir: this.options.profileStateDir,
    }, process.env);
  }

  private handleAdapterNotification(
    profile: string | undefined,
    client: CodexAppServerClient,
    notification: RpcNotification,
  ): void {
    if (notification.method !== 'turn/started') return;
    const params = recordValue(notification.params);
    const threadId = stringValue(params?.threadId);
    const turnId = stringValue(recordValue(params?.turn)?.id) ?? stringValue(params?.turnId);
    if (!threadId || !turnId) return;
    const threadKey = remoteThreadKey(profile, threadId);
    if (this.bridgeActiveThreads.has(threadKey)) return;
    const binding = this.remoteBindings.get(threadKey);
    if (!binding) return;
    const externalKey = `${threadKey}\u001f${turnId}`;
    if (this.externalRuns.has(externalKey)) return;
    const run = new CodexExternalRun({
      client,
      binding,
      turnId,
      onFinish: () => this.externalRuns.delete(externalKey),
    });
    this.externalRuns.set(externalKey, run);
    for (const listener of this.externalRunListeners) listener({ binding: { ...binding }, run });
  }

  private setBridgeThreadActive(profile: string | undefined, threadId: string, active: boolean): void {
    const key = remoteThreadKey(profile, threadId);
    if (active) this.bridgeActiveThreads.add(key);
    else this.bridgeActiveThreads.delete(key);
  }
}

interface CodexAppServerRunInput {
  client: CodexAppServerClient;
  options: AgentRunOptions & { cwd: string; sandbox: SandboxMode };
  loadProfileConfig?: () => Promise<Record<string, unknown>>;
  botIdentity?: AgentBotIdentity;
  setBridgeThreadActive(profile: string | undefined, threadId: string, active: boolean): void;
}

class CodexAppServerRun implements AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;

  private readonly client: CodexAppServerClient;
  private readonly options: CodexAppServerRunInput['options'];
  private readonly loadProfileConfig: CodexAppServerRunInput['loadProfileConfig'];
  private readonly botIdentity: AgentBotIdentity | undefined;
  private readonly setBridgeThreadActive: CodexAppServerRunInput['setBridgeThreadActive'];
  private readonly queue = new AsyncEventQueue<AgentEvent>();
  private readonly exited: Promise<void>;
  private resolveExited!: () => void;
  private unsubscribe: (() => void) | undefined;
  private unsubscribeDisconnect: (() => void) | undefined;
  private translator: CodexAppServerEventTranslator | undefined;
  private threadId: string | undefined;
  private turnId: string | undefined;
  private stopRequested = false;
  private terminal = false;
  private bridgeThreadMarked = false;

  constructor(input: CodexAppServerRunInput) {
    this.client = input.client;
    this.options = input.options;
    this.loadProfileConfig = input.loadProfileConfig;
    this.botIdentity = input.botIdentity;
    this.setBridgeThreadActive = input.setBridgeThreadActive;
    this.runId = input.options.runId;
    this.events = this.queue;
    this.exited = new Promise<void>((resolve) => {
      this.resolveExited = resolve;
    });
    this.unsubscribe = this.client.onNotification((notification) => {
      this.handleNotification(notification);
    });
    this.unsubscribeDisconnect = this.client.onDisconnect((error) => {
      this.handleDisconnect(error);
    });
    void this.start();
  }

  async steer(prompt: string, images: readonly string[] = []): Promise<void> {
    if (!this.threadId || !this.turnId || this.terminal) {
      throw new Error('Codex turn is not active');
    }
    await this.client.request('turn/steer', {
      threadId: this.threadId,
      expectedTurnId: this.turnId,
      input: userInput(prompt, images),
    });
  }

  remoteSession(): { endpoint: string; threadId?: string; profile?: string } {
    return {
      endpoint: this.client.endpoint ?? '',
      ...(this.threadId ? { threadId: this.threadId } : {}),
      ...(this.options.profile ? { profile: this.options.profile } : {}),
    };
  }

  async stop(): Promise<void> {
    if (this.terminal) return;
    this.stopRequested = true;
    if (this.threadId && this.turnId) {
      await this.client
        .request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId })
        .catch((err) => log.warn('codex-app-server', 'interrupt-failed', { message: String(err) }));
    }
  }

  async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.terminal) return true;
    return Promise.race([
      this.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }

  private async start(): Promise<void> {
    try {
      await this.client.start();
      const threadResponse = this.options.threadId
        ? await this.client.request('thread/resume', await this.threadParams(this.options.threadId))
        : await this.client.request('thread/start', await this.threadParams());
      const response = recordValue(threadResponse);
      const thread = recordValue(response?.thread);
      const threadId = stringValue(thread?.id);
      if (!threadId) throw new Error('Codex app-server returned no thread id');
      this.threadId = threadId;
      this.translator = new CodexAppServerEventTranslator(threadId);
      this.queue.push({
        type: 'system',
        threadId,
        cwd: stringValue(response?.cwd) ?? this.options.cwd,
        model: stringValue(response?.model) ?? this.options.model,
      });

      if (this.stopRequested) {
        this.finish(this.translator.interrupt());
        return;
      }
      this.setBridgeThreadActive(this.options.profile, threadId, true);
      this.bridgeThreadMarked = true;
      const turnResponse = await this.client.request('turn/start', {
        threadId,
        input: userInput(
          prefixBridgeSystemPrompt(this.options.prompt, this.botIdentity),
          this.options.images,
        ),
        cwd: this.options.cwd,
        approvalPolicy: 'never',
        sandboxPolicy: sandboxPolicy(this.options.sandbox, this.options.cwd),
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.options.personality ? { personality: this.options.personality } : {}),
      });
      const turnId = stringValue(recordValue(recordValue(turnResponse)?.turn)?.id);
      if (!turnId) throw new Error('Codex app-server returned no turn id');
      this.turnId = turnId;
      this.translator.setTurnId(turnId);
      log.info('agent', 'app-server-turn-started', {
        runId: this.runId,
        threadId,
        turnId,
        cwd: this.options.cwd,
        profile: this.options.profile ?? 'default',
      });
      if (this.stopRequested) await this.stop();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.finish(
        this.translator?.fail(`Codex app-server run failed: ${message}`) ?? [
          {
            type: 'error',
            message: `Codex app-server run failed: ${message}`,
            terminationReason: 'failed',
          },
        ],
      );
    }
  }

  private async threadParams(threadId?: string): Promise<Record<string, unknown>> {
    const config = await this.loadProfileConfig?.();
    return {
      ...(threadId ? { threadId } : {}),
      cwd: this.options.cwd,
      approvalPolicy: 'never',
      sandbox: this.options.sandbox,
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.personality ? { personality: this.options.personality } : {}),
      ...(config ? { config } : {}),
    };
  }

  private handleNotification(notification: RpcNotification): void {
    const translated = this.translator?.translate(notification) ?? [];
    if (translated.length === 0) return;
    const terminal = translated.some((event) => event.type === 'done' || event.type === 'error');
    if (terminal) {
      this.finish(translated);
    } else {
      for (const event of translated) this.queue.push(event);
    }
  }

  private handleDisconnect(error: Error): void {
    const message = `Codex app-server disconnected: ${error.message}`;
    this.finish(this.translator?.fail(message) ?? [{
      type: 'error',
      message,
      terminationReason: 'failed',
    }]);
  }

  private finish(events: AgentEvent[]): void {
    if (this.terminal) return;
    this.terminal = true;
    for (const event of events) this.queue.push(event);
    this.queue.end();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeDisconnect?.();
    this.unsubscribeDisconnect = undefined;
    if (this.bridgeThreadMarked && this.threadId) {
      this.setBridgeThreadActive(this.options.profile, this.threadId, false);
      this.bridgeThreadMarked = false;
    }
    this.resolveExited();
  }
}

interface CodexExternalRunInput {
  client: CodexAppServerClient;
  binding: AgentRemoteThreadBinding;
  turnId: string;
  onFinish(): void;
}

class CodexExternalRun implements AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  private readonly client: CodexAppServerClient;
  private readonly binding: AgentRemoteThreadBinding;
  private readonly turnId: string;
  private readonly translator: CodexAppServerEventTranslator;
  private readonly queue = new AsyncEventQueue<AgentEvent>();
  private readonly exited: Promise<void>;
  private readonly onFinish: () => void;
  private resolveExited!: () => void;
  private unsubscribe: (() => void) | undefined;
  private unsubscribeDisconnect: (() => void) | undefined;
  private terminal = false;

  constructor(input: CodexExternalRunInput) {
    this.client = input.client;
    this.binding = input.binding;
    this.turnId = input.turnId;
    this.onFinish = input.onFinish;
    this.runId = `codex-remote:${input.turnId}`;
    this.events = this.queue;
    this.translator = new CodexAppServerEventTranslator(input.binding.threadId);
    this.translator.setTurnId(input.turnId);
    this.exited = new Promise<void>((resolve) => {
      this.resolveExited = resolve;
    });
    this.queue.push({
      type: 'system',
      threadId: input.binding.threadId,
      cwd: input.binding.cwd,
    });
    this.unsubscribe = this.client.onNotification((notification) => {
      const events = this.translator.translate(notification);
      if (!events.length) return;
      if (events.some((event) => event.type === 'done' || event.type === 'error')) {
        this.finish(events);
      } else {
        for (const event of events) this.queue.push(event);
      }
    });
    this.unsubscribeDisconnect = this.client.onDisconnect((error) => {
      this.finish(this.translator.fail(`Codex app-server disconnected: ${error.message}`));
    });
  }

  async steer(prompt: string, images: readonly string[] = []): Promise<void> {
    if (this.terminal) throw new Error('Codex turn is not active');
    await this.client.request('turn/steer', {
      threadId: this.binding.threadId,
      expectedTurnId: this.turnId,
      input: userInput(prompt, images),
    });
  }

  remoteSession(): { endpoint: string; threadId?: string; profile?: string } {
    return {
      endpoint: this.client.endpoint ?? '',
      threadId: this.binding.threadId,
      ...(this.binding.profile ? { profile: this.binding.profile } : {}),
    };
  }

  async stop(): Promise<void> {
    if (this.terminal) return;
    await this.client.request('turn/interrupt', {
      threadId: this.binding.threadId,
      turnId: this.turnId,
    });
  }

  async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.terminal) return true;
    return Promise.race([
      this.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }

  private finish(events: AgentEvent[]): void {
    if (this.terminal) return;
    this.terminal = true;
    for (const event of events) this.queue.push(event);
    this.queue.end();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeDisconnect?.();
    this.unsubscribeDisconnect = undefined;
    this.onFinish();
    this.resolveExited();
  }
}

function userInput(prompt: string, images: readonly string[] = []): unknown[] {
  return [
    { type: 'text', text: prompt, text_elements: [] },
    ...images.map((path) => ({ type: 'localImage', path })),
  ];
}

function sandboxPolicy(mode: SandboxMode, cwd: string): Record<string, unknown> {
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (mode === 'read-only') return { type: 'readOnly', networkAccess: false };
  return {
    type: 'workspaceWrite',
    writableRoots: [cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 64) || 'default';
}

function remoteThreadKey(profile: string | undefined, threadId: string): string {
  return `${profile ?? ''}\u001f${threadId}`;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<() => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    this.values.push(value);
    this.waiters.shift()?.();
  }

  end(): void {
    this.closed = true;
    for (const wake of this.waiters.splice(0)) wake();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (!this.closed || this.values.length > 0) {
      const value = this.values.shift();
      if (value !== undefined) {
        yield value;
        continue;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}
