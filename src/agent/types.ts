import type { AgentAvailability } from './preflight';
import type { ClaudePermissionMode, CodexSandboxMode } from '../config/permissions';

export type { ClaudePermissionMode } from '../config/permissions';

export type AgentNoticeLevel = 'warning' | 'error' | 'retry' | 'recovered';

export type AgentEvent =
  | { type: 'system'; sessionId?: string; threadId?: string; cwd?: string; model?: string }
  | { type: 'user_text'; content: string }
  | { type: 'text'; delta: string }
  | { type: 'final_text'; content: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_progress'; id: string; delta: string }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  | {
      type: 'notice';
      level: AgentNoticeLevel;
      message: string;
      attempt?: number;
      maxAttempts?: number;
      delaySeconds?: number;
    }
  | {
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      reasoningOutputTokens?: number;
      costUsd?: number;
    }
  | {
      type: 'done';
      sessionId?: string;
      threadId?: string;
      terminationReason: 'normal' | 'interrupted' | 'timeout';
    }
  | { type: 'error'; message: string; terminationReason: 'failed' | 'interrupted' | 'timeout' };

export const CLAUDE_DEFAULT_PERMISSION_MODE: ClaudePermissionMode = 'bypassPermissions';

export interface AgentRunOptions {
  runId: string;
  prompt: string;
  cwd?: string;
  sessionId?: string;
  threadId?: string;
  model?: string;
  personality?: 'friendly' | 'pragmatic' | 'none';
  /** Optional named Codex CLI config profile (`codex --profile <name>`). */
  profile?: string;
  images?: readonly string[];
  sandbox?: CodexSandboxMode;
  permissionMode?: ClaudePermissionMode;
  /**
   * Grace period (ms) between SIGTERM and SIGKILL when stop() is called on
   * the returned run. Lets the agent (and any subprocess it spawned, e.g.
   * lark-cli mid-OAuth) clean up before the kernel reaps the tree.
   * Adapters that don't kill via signals are free to ignore this. Defaults
   * are adapter-specific.
  */
  stopGraceMs?: number;
}

export interface AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  /** Append instructions to the currently running turn (Codex Enter semantics). */
  steer?(prompt: string, images?: readonly string[]): Promise<void>;
  /** Local app-server endpoint and loaded thread for attaching a Codex TUI. */
  remoteSession?(): { endpoint: string; threadId?: string; profile?: string };
  stop(): Promise<void>;
  /**
   * Wait up to `timeoutMs` for the agent process to exit on its own.
   * Resolves true if it exited within the window, false if the timer
   * fired first (caller usually wants to fall back to stop()).
   *
   * Use this after a terminal stream event (`done` / `error`): the
   * stream-json `result` line arrives before claude has actually closed
   * stdout — there's a brief telemetry/cleanup tail in between. Calling
   * stop() in that window forces a SIGTERM and the run exits with code
   * 143 instead of 0; waiting it out lets it exit cleanly.
   */
  waitForExit(timeoutMs: number): Promise<boolean>;
}

/**
 * The bridge bot's own IM identity, resolved by the channel after the WS
 * handshake (`/open-apis/bot/v3/info`). Injected into adapters so the agent
 * system prompt can state "this open_id is you" with the real value.
 */
export interface AgentBotIdentity {
  openId: string;
  name?: string;
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  checkAvailability?(): Promise<AgentAvailability>;
  prepareRun?(opts: AgentRunOptions): Promise<void>;
  run(opts: AgentRunOptions): AgentRun;
  /**
   * Late-bound identity injection: the adapter is constructed before the
   * channel connects, so the channel calls this once botIdentity is known.
   * Adapters that don't bake identity into their prompts may omit it.
   */
  setBotIdentity?(identity: AgentBotIdentity): void;
  /** Release persistent transport processes owned by this adapter. */
  close?(): Promise<void>;
  /** Low-level Codex app-server access for bridge slash commands. */
  appServerRequest?(profile: string | undefined, method: string, params?: unknown): Promise<unknown>;
  appServerEndpoint?(profile?: string): Promise<string>;
  bindRemoteThread?(binding: AgentRemoteThreadBinding): void;
  onExternalRun?(listener: (run: AgentExternalRun) => void): () => void;
}

export interface AgentRemoteThreadBinding {
  scopeId: string;
  chatId: string;
  threadId: string;
  messageThreadId?: string;
  replyTo?: string;
  operatorOpenId: string;
  profile?: string;
  cwd: string;
  sandbox: CodexSandboxMode;
  policyFingerprint?: string;
}

export interface AgentExternalRun {
  binding: AgentRemoteThreadBinding;
  run: AgentRun;
}
