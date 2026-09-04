import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute } from 'node:path';
import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { claudeCapability, codexCapability } from '../agent/capability';
import {
  CODEX_GOAL_CONTINUATION_CLIENT_ID,
  parseCodexGoal,
} from '../agent/goal';
import { discoverCodexProfiles, loadCodexProfileConfig } from '../config/codex-profiles';
import { DEFAULT_MODEL, normalizeModelSelection, resolveModelArg, supportedModels } from '../agent/models';
import type { AgentAdapter } from '../agent/types';
import type { ActiveRuns } from '../bot/active-runs';
import {
  accountCurrentCard,
  accountFailureCard,
  accountFormCard,
  accountSuccessCard,
} from '../card/account-cards';
import {
  configCancelledCard,
  configFailedCard,
  configFormCard,
  configSavedCard,
  groupMsgScopeGrantCard,
  groupMsgScopeGrantedCard,
} from '../card/config-card';
import { GROUP_MSG_SCOPE, hasGroupMsgScope } from '../bot/app-scope';
import { requestScopeGrantLink } from '../bot/wizard';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../card/managed';
import {
  codexSkillsCard,
  helpCard,
  codexProfileCard,
  permissionsCard,
  resumeCard,
  resumeHistoryChoiceCard,
  resumeTakeoverCard,
  statusCard,
  workspaceLaunchCard,
  workspaceNewCard,
  workspacesCard,
} from '../card/templates';
import type { AppConfig, AppPreferences, MessageReplyMode, TenantBrand } from '../config/schema';
import {
  getAgentStopGraceMs,
  getCotMessages,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getRequireMentionInGroup,
  getRunIdleTimeoutMs,
  getShowToolCalls,
} from '../config/schema';
import type {
  LarkCliIdentityPreset,
  ProfileAccess,
  ProfileConfig,
  ProfileMode,
} from '../config/profile-schema';
import { effectiveLarkCliIdentity } from '../config/profile-schema';
import { resolveAppPaths } from '../config/app-paths';
import {
  accessToClaudePermissionMode,
  accessToCodexSandbox,
  clampAccess,
  codexSandboxToAccess,
  type CodexSandboxMode,
} from '../config/permissions';
import {
  canRunAdminCommand,
  canUseDm,
  canUseGroup,
  type OwnerRefreshState,
} from '../policy/access';
import { buildEncryptedAccountConfig } from '../config/store';
import * as configOps from '../config/config-ops';
import { log, reportMetric } from '../core/logger';
import { renderCard } from '../card/run-renderer';
import { formatGoalSummary } from '../card/run-status';
import { renderCodexHistoryCards } from '../card/codex-trace';
import { codexThreadIdMarkdown, copyableShellCommandMarkdown } from '../card/copyable-code';
import {
  finalizeIfRunning,
  initialState,
  markInterrupted,
  reduce,
  type RunState,
} from '../card/run-state';
import { formatRelTime, listRecentSessions, type SessionSummary } from '../session/history';
import {
  listCodexThreadHistory,
  type CodexThreadHistoryEntry,
  type ListCodexThreadHistoryOptions,
} from '../session/codex-history';
import type { SessionCatalog, SessionCatalogIdentity } from '../session/catalog';
import { isAlive, readAndPrune, resolveTarget } from '../runtime/registry';
import { readUiSidecar } from '../ui/sidecar';
import type { SessionStore } from '../session/store';
import { resolveWorkingDirectory } from '../policy/workspace';
import { evaluateRunPolicy } from '../policy/run-policy';
import type { ProcessPool } from '../bot/process-pool';
import type { PendingQueue } from '../bot/pending-queue';
import type { RunExecutor } from '../runtime/run-executor';
import { RunRejected } from '../runtime/errors';
import { validateAppCredentials } from '../utils/feishu-auth';
import type { WorkspaceStore } from '../workspace/store';
import { createBoundChat, defaultChatName } from '../bot/group';
import { fetchKnownChats, type KnownChat } from '../bot/lark-info';
import { describeMeetingError, type MeetingManager } from '../meeting/manager';
import { isMeetingNo } from '../meeting/api';
import { answerInMeeting, meetingScopeId } from '../meeting/orchestrator';
import type { MeetingSession } from '../meeting/session';
import { hasStructuredLarkCliUserAuth } from '../lark-cli/identity-policy';
import { CODEX_SLASH_COMMANDS, codexSlashSurface } from './codex-slash';

export interface Controls {
  profile: string;
  profileConfig: ProfileConfig;
  botOwnerId?: string;
  ownerRefreshState: OwnerRefreshState;
  ownerRefreshedAt?: number;
  ownerRefreshError?: string;
  refreshOwner(channel?: LarkChannel): Promise<void>;
  /** Restart the bridge in-process: disconnect WS, kill claude runs, reload
   * config, reconnect with the new credentials. */
  restart(opts?: { wait?: boolean }): Promise<void>;
  /** Stop this whole process gracefully (disconnect + exit). Used by /exit
   * when the user targets the receiving process itself. */
  exit(): Promise<void>;
  /** Path to the config file the bridge was started with. */
  configPath: string;
  /** The current app config (snapshot at startChannel time). */
  cfg: AppConfig;
  /** This process's short id in the registry. Used by /ps to highlight the
   * receiving process and by /exit to detect self-target. */
  processId: string;
  /** Groups the bot currently belongs to, used to render and bulk-manage access. */
  knownChats?: KnownChat[];
  /** In-meeting agent manager; present only while the channel is connected and
   * `meeting.enabled` is on. Late-bound by startChannel. */
  meeting?: MeetingManager;
}

export interface CommandContext {
  channel: LarkChannel;
  msg: NormalizedMessage;
  /**
   * Session scope string. For p2p / regular group it equals `msg.chatId`;
   * for topic groups it's `${chatId}:${threadId}` (so each topic gets its
   * own session / cwd / active-run). All handlers should read/write
   * session / workspace / activeRuns through this — never through
   * `msg.chatId` directly.
   */
  scope: string;
  /** Resolved chat mode for `msg.chatId`. Used by /status to surface the
   * scope semantic to the user (`topic` shows "话题独立 session"). */
  chatMode: 'p2p' | 'group' | 'topic';
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  sessionCatalogIdentity?: SessionCatalogIdentity;
  workspaces: WorkspaceStore;
  agent: AgentAdapter;
  activeRuns: ActiveRuns;
  processPool?: ProcessPool;
  pending?: PendingQueue;
  runExecutor?: RunExecutor;
  controls: Controls;
  codexHistoryProvider?: (
    options: ListCodexThreadHistoryOptions,
  ) => Promise<CodexThreadHistoryEntry[]>;
  claudeHistoryProvider?: (cwd: string, limit: number) => Promise<SessionSummary[]>;
  /** Set when invoked from a CardKit 2.0 form submit. Keys are input `name`s. */
  formValue?: Record<string, unknown>;
  /** True when this invocation came from a card button click rather than a
   * text command. Determines whether to update the existing card vs send a
   * new one. */
  fromCardAction?: boolean;
}

type Handler = (args: string, ctx: CommandContext) => Promise<void>;

interface ResumeCandidate {
  scopeId: string;
  agentId: 'claude' | 'codex';
  cwdRealpath: string;
  policyFingerprint: string;
  sessionId?: string;
  threadId?: string;
  kind: 'resume' | 'takeover' | 'history';
  expiresAt: number;
}

const RESUME_CANDIDATE_TTL_MS = 10 * 60 * 1000;
const resumeCandidates = new Map<string, ResumeCandidate>();
const projectChatResolutions = new Map<string, Promise<ResolvedProjectChat | undefined>>();
const AUDIT_SAFE_COMMAND_REPLY = '命令已处理。';
const RESUME_APPLIED_REPLY = '已完成，请继续发送下一条消息。';
// Feishu chat/member reads can be slow when the tenant is under load. Keep
// the idempotency guard alive long enough for a retried callback to join the
// same in-flight resolution instead of starting a second group creation.
const PROJECT_CHAT_LOOKUP_TIMEOUT_MS = 5 * 60_000;

const handlers: Record<string, Handler> = {
  '/new': handleNew,
  '/clear': handleNew,
  '/reset': handleNew,
  '/cd': handleCd,
  '/ws': handleWs,
  '/resume': handleResume,
  '/status': handleStatus,
  '/help': handleHelp,
  '/account': handleAccount,
  '/config': handleConfig,
  '/stop': handleStop,
  '/interupt': handleInterrupt,
  '/interrupt': handleInterrupt,
  '/timeout': handleTimeout,
  '/ps': handlePs,
  '/exit': handleExit,
  '/doctor': handleDoctor,
  '/reconnect': handleReconnect,
  '/doc': handleDoc,
  '/invite': handleInvite,
  '/remove': handleRemove,
  '/meeting': handleMeeting,
  '/codex': handleCodexControl,
  '/permissions': handlePermissions,
  '/permission': handlePermissions,
  '/profile': handleProfile,
  '/attach': handleAttach,
};

/**
 * Commands that can mutate credentials, lifecycle, filesystem reach, or
 * surface sensitive runtime state. Gated by unified access policy; runtime
 * owner is always allowed, while empty admin list means no listed admins.
 */
const ADMIN_COMMANDS = new Set([
  '/account',
  '/config',
  '/ps',
  '/exit',
  '/reconnect',
  '/doctor',
  '/cd',
  '/ws',
  '/invite',
  '/remove',
  // Joining a meeting makes the bot visible to every participant and exposes
  // meeting content to the agent — owner/admin only.
  '/meeting',
  '/permissions',
  '/permission',
  '/profile',
  '/logout',
  '/debug-config',
  '/experimental',
  '/delete',
]);

function isAdminCommand(cmd: string): boolean {
  return ADMIN_COMMANDS.has(cmd.startsWith('/') ? cmd : `/${cmd}`);
}

export async function tryHandleCommand(ctx: CommandContext): Promise<boolean> {
  const trimmed = ctx.msg.content.trim();
  if (!trimmed.startsWith('/')) return false;
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0] ?? '';
  const args = parts.slice(1).join(' ');
  const h = handlers[cmd];
  // `/queue` is bridge-native for Codex, but remains ordinary agent input for
  // Claude where no queue contract exists. Keep it in the shared dispatcher
  // so text commands and card actions use the same implementation.
  if (cmd === '/queue' && ctx.agent.id === 'codex') {
    await handleQueue(args, ctx);
    return true;
  }
  if (!h && ctx.agent.id !== 'codex') return false;
  if (
    isAdminCommand(cmd) &&
    !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
  ) {
    log.info('command', 'admin-deny', {
      cmd,
      sender: ctx.msg.senderId.slice(-6),
    });
    await reply(ctx, '❌ 此命令仅管理员可用。');
    return true;
  }
  if (!h) {
    try {
      await handleCodexSlash(cmd, args, ctx);
    } catch (err) {
      log.fail('command', err, { cmd, step: 'codex-slash' });
      await reply(
        ctx,
        `❌ Codex 命令执行失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return true;
  }
  try {
    await h(args, ctx);
  } catch (err) {
    log.fail('command', err, { cmd });
    reportMetric('command_fail', 1, { step: 'dispatch' });
  }
  return true;
}

/** Invoke a named command handler (e.g. from a card button click). */
export async function runCommandHandler(
  name: string,
  args: string,
  ctx: CommandContext,
): Promise<boolean> {
  const h = handlers[`/${name}`];
  if (!h) return false;
  if (
    isAdminCommand(name) &&
    !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
  ) {
    log.info('command', 'admin-deny', {
      cmd: name,
      sender: ctx.msg.senderId.slice(-6),
      via: 'card',
    });
    // Card actions can't reply naturally (the `msg` is synthesized); the
    // click is silently denied. The button only renders for users who got
    // the original admin card in the first place, so this is an edge case.
    return true;
  }
  try {
    await h(args, ctx);
  } catch (err) {
    log.fail('command', err, { cmd: name });
    reportMetric('command_fail', 1, { step: 'handler' });
  }
  return true;
}

/**
 * Send a plain markdown reply, swallowing any send error. Used by command
 * handlers where a failed reply shouldn't bubble up and crash the bot —
 * losing the message is better than dying.
 */
async function reply(ctx: CommandContext, markdown: string): Promise<void> {
  try {
    await ctx.channel.send(ctx.msg.chatId, { markdown }, commandReplyOptions(ctx));
  } catch (err) {
    log.fail('command', err, { step: 'reply' });
    reportMetric('command_fail', 1, { step: 'reply' });
    if (!isMessageAuditReject(err) || markdown === AUDIT_SAFE_COMMAND_REPLY) return;
    try {
      await ctx.channel.send(
        ctx.msg.chatId,
        { markdown: AUDIT_SAFE_COMMAND_REPLY },
        commandReplyOptions(ctx),
      );
    } catch (fallbackErr) {
      log.fail('command', fallbackErr, { step: 'reply-audit-fallback' });
      reportMetric('command_fail', 1, { step: 'reply-audit-fallback' });
    }
  }
}

function commandReplyOptions(ctx: CommandContext): { replyTo: string; replyInThread?: true } {
  return {
    replyTo: ctx.msg.messageId,
    ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true as const } : {}),
  };
}

function isMessageAuditReject(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const record = err as Record<string, unknown>;
  if (record.code === 230028) return true;
  const message = String(record.message ?? record.msg ?? '');
  return /not pass the audit/i.test(message);
}

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return `${homedir()}${p.slice(1)}`;
  return p;
}

function isAbsoluteOrTilde(p: string): boolean {
  return isAbsolute(p) || p === '~' || p.startsWith('~/');
}

async function handleNew(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim();

  // /new chat [name]  — spin up a fresh group chat bound to a fresh session
  if (trimmed === 'chat' || trimmed.startsWith('chat ')) {
    const rawName = trimmed === 'chat' ? '' : trimmed.slice(5).trim();
    return handleNewChat(rawName, ctx);
  }

  const previousCodexThreadId = ctx.agent.id === 'codex'
    ? await currentCodexThreadId(ctx)
    : undefined;
  const wasRunning = ctx.activeRuns.interrupt(ctx.scope);
  if (ctx.sessionCatalog && ctx.sessionCatalogIdentity) {
    ctx.sessionCatalog.archiveActive({
      ...ctx.sessionCatalogIdentity,
      now: Date.now(),
    });
  }
  ctx.sessions.clear(ctx.scope);
  if (previousCodexThreadId) {
    await reply(ctx, `上一个 Codex 会话：\n\n${codexThreadIdMarkdown(previousCodexThreadId)}`);
  }
  await reply(ctx, wasRunning ? '已中断当前任务并开始新会话。' : '已开始新会话。');
}

async function handleCodexControl(args: string, ctx: CommandContext): Promise<void> {
  if (ctx.agent.id !== 'codex') return;
  const action = args.trim();
  const skillsPage = action.match(/^skills(?:[ .])page(?:\s+(\d+))?$/);
  if (skillsPage) {
    const requestedPage = Number(skillsPage[1] ?? '1');
    await handleCodexSkillsList(ctx, Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1);
    return;
  }
  if (action === 'commands' || action === 'help') {
    const groups = Object.entries(CODEX_SLASH_COMMANDS).reduce<Record<string, string[]>>(
      (result, [command, surface]) => {
        (result[surface] ??= []).push(command);
        return result;
      },
      {},
    );
    await reply(
      ctx,
      [
        '**Codex 0.152.x 命令覆盖**',
        '',
        `- 飞书原生：${groups.bridge?.map((command) => `\`${command}\``).join(' ')}`,
        `- app-server：${groups['app-server']?.map((command) => `\`${command}\``).join(' ')}`,
        `- 双重语义：${groups.hybrid?.map((command) => `\`${command}\``).join(' ')}`,
        `- 附着 TUI：${groups['attached-tui']?.map((command) => `\`${command}\``).join(' ')}`,
      ].join('\n'),
    );
    return;
  }
  const input = typeof ctx.formValue?.codex_input === 'string'
    ? ctx.formValue.codex_input.trim()
    : '';
  if (!input) {
    await reply(ctx, '请输入要插入或排队的指令。');
    return;
  }
  if (action === 'inject') {
    const active = ctx.activeRuns.get(ctx.scope);
    if (!active?.run.steer) {
      await reply(ctx, '当前没有可插入指令的 Codex turn；请直接发送消息开始新一轮。');
      return;
    }
    await active.run.steer(input);
    ctx.activeRuns.requestPresentationSplit(ctx.scope, {
      replyTo: ctx.msg.messageId,
      ...(ctx.chatMode === 'topic' ? { replyInThread: true } : {}),
    });
    await reply(ctx, '↵ 已立即插入当前 Codex turn。');
    return;
  }
  if (action === 'queue') {
    if (!ctx.pending) {
      await reply(ctx, '当前 queue 不可用，请直接发送消息。');
      return;
    }
    ctx.pending.push(ctx.scope, { ...ctx.msg, content: input });
    await reply(ctx, '⇥ 已排队，将在当前 turn 完成后执行。');
  }
}

async function handlePermissions(args: string, ctx: CommandContext): Promise<void> {
  if (ctx.agent.id !== 'codex') {
    await reply(ctx, '此命令仅适用于 Codex CLI。');
    return;
  }
  const raw = args.trim().replace(/^set\s+/, '');
  const requested = parseCodexSandbox(raw);
  if (!raw) {
    const card = permissionsCard({
      current: effectiveCodexSandbox(ctx),
      max: accessToCodexSandbox(ctx.controls.profileConfig.permissions.maxAccess),
      activeRun: Boolean(ctx.activeRuns.get(ctx.scope)),
    });
    await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
    return;
  }
  if (!requested) {
    await reply(
      ctx,
      '用法：`/permissions [read-only|workspace-write|danger-full-access]`（也支持 `/permission`）',
    );
    return;
  }
  const cwd = effectiveWorkspaceCwd(ctx);
  if (!cwd) {
    await reply(ctx, '请先使用 `/cd <path>` 选择工作目录。');
    return;
  }
  if (!ctx.workspaces.cwdFor(ctx.scope)) ctx.workspaces.setCwd(ctx.scope, cwd);
  const access = clampAccess(
    codexSandboxToAccess(requested),
    ctx.controls.profileConfig.permissions.maxAccess,
    codexCapability(ctx.controls.profileConfig).permissions.maxAccess,
  );
  const effective = accessToCodexSandbox(access);
  const activeRun = Boolean(ctx.activeRuns.get(ctx.scope));
  const currentThreadId = await currentCodexThreadId(ctx);
  ctx.workspaces.setCodexSandbox(ctx.scope, effective);
  if (currentThreadId) {
    const settings = {
      approvalPolicy: 'never',
      sandboxPolicy: codexSandboxPolicy(effective, cwd),
    };
    if (activeRun) {
      await codexRpc(ctx, 'thread/settings/update', { threadId: currentThreadId, ...settings });
    } else {
      await updateCodexThreadSettings(ctx, currentThreadId, settings);
    }
    const nextIdentity = await currentSessionCatalogIdentity(ctx, cwd);
    if (nextIdentity && ctx.sessionCatalog) {
      if (ctx.sessionCatalogIdentity) {
        ctx.sessionCatalog.archiveActive({ ...ctx.sessionCatalogIdentity, now: Date.now() });
      }
      ctx.sessionCatalog.upsertActive({ ...nextIdentity, threadId: currentThreadId, now: Date.now() });
      bindCodexThread(ctx, currentThreadId, cwd, nextIdentity.policyFingerprint);
    }
  }
  await reply(
    ctx,
    requested === effective
      ? `✓ Codex 权限已设为 **${effective}**，后续 turn 持续使用。`
      : `✓ 请求的权限超过配置上限，已使用 **${effective}**，后续 turn 持续使用。`,
  );
}

async function handleProfile(args: string, ctx: CommandContext): Promise<void> {
  if (ctx.agent.id !== 'codex') {
    await reply(ctx, '此命令仅适用于 Codex CLI。');
    return;
  }
  if (ctx.chatMode === 'p2p') {
    await handleDefaultCodexProfile(args, ctx);
    return;
  }
  if (args.trim()) {
    await reply(ctx, '直接发送 `/profile`，然后在卡片中选择 profile 与新建/恢复会话。');
    return;
  }
  const cwd = effectiveWorkspaceCwd(ctx);
  if (!cwd) {
    await reply(ctx, '请先使用 `/cd <path>` 选择工作目录。');
    return;
  }
  ctx.workspaces.prepareCodexLaunch(ctx.scope, cwd);
  await showWorkspaceLaunchCard(ctx, cwd);
}

async function handleDefaultCodexProfile(args: string, ctx: CommandContext): Promise<void> {
  const cwd = effectiveWorkspaceCwd(ctx) ?? homedir();
  let profiles = await discoverCommandCodexProfiles(ctx, cwd);
  const configured = ctx.workspaces.defaultCodexProfile(ctx.controls.profileConfig.codex?.profile);
  if (configured && !profiles.includes(configured)) profiles.push(configured);
  profiles.sort((a, b) => a.localeCompare(b));

  const input = args.trim();
  if (!input) {
    const card = codexProfileCard({
      botName: ctx.channel.botIdentity?.name ?? ctx.agent.displayName,
      profiles,
      configuredProfile: configured,
    });
    await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
    return;
  }

  const directValue = input.startsWith('set ') ? input.slice(4).trim() : input;
  const rawProfile = String(ctx.formValue?.codex_profile ?? directValue).trim();
  if (!rawProfile || rawProfile === 'set') {
    await reply(ctx, '请选择一个 Codex profile；也可发送 `/profile <名称>` 或 `/profile default`。');
    return;
  }
  const profile = rawProfile === '__default__' || rawProfile === 'default' ? null : rawProfile;
  if (profile && !profiles.includes(profile)) {
    await reply(
      ctx,
      `未找到 Codex profile：\`${profile}\`。请重新发送 \`/profile\` 从列表选择。`,
    );
    return;
  }
  ctx.workspaces.setDefaultCodexProfile(profile);
  const label = profile ? `\`${profile}\`` : '默认配置（不传 `--profile`）';
  const botName = ctx.channel.botIdentity?.name ?? ctx.agent.displayName;
  await reply(
    ctx,
    `✓ **${botName}** 的默认 Codex profile 已切换为 ${label}。\n\n` +
      '之后从本私聊选择项目时会默认使用它；已有项目群保持各自设置。',
  );
}

async function handleAttach(_args: string, ctx: CommandContext): Promise<void> {
  if (ctx.agent.id !== 'codex') {
    await reply(ctx, '此命令仅适用于 Codex CLI。');
    return;
  }
  const remote = await codexRemoteContext(ctx);
  if (!remote.threadId) {
    await reply(ctx, '当前 scope 还没有 Codex thread；请先新建或恢复一次会话。');
    return;
  }
  await reply(
    ctx,
    [
      codexThreadIdMarkdown(remote.threadId),
      '',
      '在本机终端运行以下命令，即可附着到与飞书相同的 Codex thread：',
      '',
      copyableShellCommandMarkdown(codexAttachCommand(remote.endpoint, remote.threadId, remote.profile)),
      '',
      '附着后，终端与飞书共享同一个 app-server 和 thread。',
    ].join('\n'),
  );
}

async function handleCodexSlash(cmd: string, args: string, ctx: CommandContext): Promise<void> {
  switch (cmd) {
    case '/model':
      return handleCodexModel(args, ctx);
    case '/personality':
      return handleCodexPersonality(args, ctx);
    case '/fast':
      return handleCodexFast(args, ctx);
    case '/plan':
      return handleCodexPlan(args, ctx);
    case '/rename':
      return handleThreadRpc(ctx, 'thread/name/set', args, (threadId) => ({ threadId, name: args.trim() }), '会话已重命名', true, '/rename <name>');
    case '/title':
      return handleThreadRpc(ctx, 'thread/name/set', args, (threadId) => ({ threadId, name: args.trim() }), '会话已重命名', true, '/title <name>');
    case '/logout':
      return handleCodexLogout(ctx);
    case '/archive':
      return handleCodexArchive(ctx);
    case '/delete':
      return handleCodexDelete(args, ctx);
    case '/compact':
      return handleThreadRpc(ctx, 'thread/compact/start', args, (threadId) => ({ threadId }), '已开始压缩会话上下文');
    case '/fork':
      return handleCodexFork(ctx);
    case '/goal':
      return handleCodexGoal(args, ctx);
    case '/review':
      return handleThreadRpc(
        ctx,
        'review/start',
        args,
        (threadId) => ({
          threadId,
          target: args.trim()
            ? { type: 'custom', instructions: args.trim() }
            : { type: 'uncommittedChanges' },
          delivery: 'inline',
        }),
        '已开始 Codex review',
      );
    case '/usage':
      return handleGlobalRpc(ctx, 'account/usage/read', undefined, 'Codex 用量');
    case '/debug-config':
      return handleCodexDebugConfig(ctx);
    case '/experimental':
      return handleCodexExperimental(args, ctx);
    case '/memories':
      return handleCodexMemories(args, ctx);
    case '/clean':
      return handleCodexBackgroundTerminalsStop(ctx);
    case '/mcp': {
      const remote = await codexRemoteContext(ctx);
      return handleGlobalRpc(
        ctx,
        'mcpServerStatus/list',
        { threadId: remote.threadId, detail: args.trim() === 'verbose' ? 'full' : 'toolsAndAuthOnly' },
        'MCP 状态',
      );
    }
    case '/skills':
      return handleCodexSkillsList(ctx);
    case '/skill':
      return handleCodexSkill(args, ctx);
    case '/apps': {
      const remote = await codexRemoteContext(ctx);
      return handleGlobalRpc(ctx, 'app/list', { threadId: remote.threadId, limit: 100, forceRefetch: false }, 'Apps');
    }
    case '/plugins':
      return handleGlobalRpc(ctx, 'plugin/list', { cwds: [effectiveWorkspaceCwd(ctx)].filter(Boolean), forceRefetch: false }, 'Plugins');
    case '/hooks':
      return handleGlobalRpc(ctx, 'hooks/list', { cwds: [effectiveWorkspaceCwd(ctx)].filter(Boolean) }, 'Hooks');
    case '/approve':
    case '/diff':
      return replyWithAttachHint(ctx, `${cmd} 需要 Codex TUI 中当前可见的交互状态`);
    default:
      if (codexSlashSurface(cmd) === 'attached-tui') {
        return replyWithAttachHint(ctx, `${cmd} 是终端本地/交互命令`);
      }
      await reply(ctx, `未识别 Codex 命令：\`${cmd}\`。发送 \`/help\` 查看 bridge 命令，或用 \`/attach\` 进入完整 TUI。`);
  }
}

async function handleCodexModel(args: string, ctx: CommandContext): Promise<void> {
  const value = args.trim();
  if (value) {
    const cwd = await requireCodexWorkspace(ctx);
    if (!cwd) return;
    ctx.workspaces.setCodexModel(ctx.scope, value === 'default' ? null : value);
    if (!ctx.activeRuns.get(ctx.scope)) {
      const effectiveModel = value === 'default'
        ? resolveModelArg('codex', ctx.controls.profileConfig.preferences.model)
        : value;
      if (effectiveModel) {
        await updateCodexThreadSettingsIfPresent(ctx, { model: effectiveModel });
      }
    }
    await reply(ctx, value === 'default' ? '✓ 后续 turn 跟随 Codex 默认模型。' : `✓ 后续 turn 使用模型 **${value}**。`);
    return;
  }
  const result = await codexRpc(ctx, 'model/list', { limit: 100, includeHidden: false });
  const models = resultData(result)
    .map((entry) => recordValue(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => String(entry.displayName ?? entry.model ?? entry.id ?? ''))
    .filter(Boolean);
  const current = ctx.workspaces.codexModelFor(
    ctx.scope,
    resolveModelArg('codex', ctx.controls.profileConfig.preferences.model),
  ) ?? '默认';
  await reply(ctx, `当前模型：**${current}**\n\n${models.length ? models.map((model) => `- ${model}`).join('\n') : '没有可用模型信息。'}\n\n设置：\`/model <model-id>\`；恢复默认：\`/model default\``);
}

async function handleCodexPersonality(args: string, ctx: CommandContext): Promise<void> {
  const value = args.trim().toLowerCase();
  if (!value) {
    await reply(ctx, `当前 personality：**${ctx.workspaces.codexPersonalityFor(ctx.scope) ?? 'none'}**\n可选：\`friendly\`、\`pragmatic\`、\`none\``);
    return;
  }
  if (value !== 'friendly' && value !== 'pragmatic' && value !== 'none') {
    await reply(ctx, '用法：`/personality [friendly|pragmatic|none]`');
    return;
  }
  if (!await requireCodexWorkspace(ctx)) return;
  ctx.workspaces.setCodexPersonality(ctx.scope, value);
  if (!ctx.activeRuns.get(ctx.scope)) {
    await updateCodexThreadSettingsIfPresent(ctx, { personality: value });
  }
  await reply(ctx, `✓ 后续 turn 的 personality 已设为 **${value}**。`);
}

async function handleCodexFast(args: string, ctx: CommandContext): Promise<void> {
  const value = args.trim().toLowerCase();
  if (value && value !== 'on' && value !== 'off' && value !== 'status') {
    await reply(ctx, '用法：`/fast [on|off|status]`');
    return;
  }
  const threadId = await requireCodexThread(ctx);
  if (!threadId) return;
  const resumed = recordValue(await codexRpc(ctx, 'thread/resume', {
    threadId,
    excludeTurns: true,
  }));
  const current = stringValue(resumed?.serviceTier);
  if (value === 'status') {
    await reply(ctx, `Codex Fast mode：**${current === 'fast' ? 'on' : 'off'}**`);
    return;
  }
  const enabled = value === 'on' || (value === '' && current !== 'fast');
  await codexRpc(ctx, 'thread/settings/update', {
    threadId,
    serviceTier: enabled ? 'fast' : null,
  });
  await reply(ctx, `✓ Codex Fast mode 已${enabled ? '开启' : '关闭'}。`);
}

async function handleCodexPlan(args: string, ctx: CommandContext): Promise<void> {
  if (ctx.activeRuns.get(ctx.scope)) {
    await reply(ctx, '当前 turn 运行中，请完成或终止后再切换 Plan mode。');
    return;
  }
  const value = args.trim();
  const disable = value === 'off' || value === 'default';
  const prompt = disable || value === 'on' ? '' : value;
  const threadId = await requireCodexThread(ctx);
  if (!threadId) return;
  const [resumed, available] = await Promise.all([
    codexRpc(ctx, 'thread/resume', { threadId, excludeTurns: true }),
    codexRpc(ctx, 'collaborationMode/list', {}),
  ]);
  const mode = disable ? 'default' : 'plan';
  const mask = resultData(available)
    .map(recordValue)
    .find((entry) => entry?.mode === mode);
  const selectedModel = stringValue(mask?.model)
    ?? stringValue(recordValue(resumed)?.model)
    ?? ctx.workspaces.codexModelFor(
      ctx.scope,
      resolveModelArg('codex', ctx.controls.profileConfig.preferences.model),
    )
    ?? DEFAULT_MODEL;
  const collaborationMode = {
    mode,
    settings: {
      model: selectedModel,
      reasoning_effort: stringValue(mask?.reasoning_effort) ?? null,
      developer_instructions: null,
    },
  };
  if (prompt) {
    await codexRpc(ctx, 'turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      collaborationMode,
    });
    await reply(ctx, '✓ 已在 Plan mode 中启动该指令。');
    return;
  }
  await codexRpc(ctx, 'thread/settings/update', { threadId, collaborationMode });
  await reply(ctx, `✓ Codex 已切换到 **${disable ? 'Default' : 'Plan'} mode**。`);
}

async function handleCodexArchive(ctx: CommandContext): Promise<void> {
  const remote = await codexRemoteContext(ctx);
  if (!remote.threadId) return reply(ctx, '当前 scope 没有可归档的 Codex thread。');
  await codexRpc(ctx, 'thread/archive', { threadId: remote.threadId });
  const cwd = effectiveWorkspaceCwd(ctx);
  const identity = cwd ? await currentSessionCatalogIdentity(ctx, cwd) : undefined;
  if (identity) ctx.sessionCatalog?.archiveActive({ ...identity, now: Date.now() });
  await reply(ctx, '✓ 当前 Codex 会话已归档；下一条消息将创建新会话。');
}

async function handleCodexDelete(args: string, ctx: CommandContext): Promise<void> {
  const threadId = await currentCodexThreadId(ctx);
  if (!threadId) {
    await reply(ctx, '当前 scope 没有可删除的 Codex thread。');
    return;
  }
  if (args.trim().toLowerCase() !== 'confirm') {
    await reply(
      ctx,
      `将永久删除此 thread 及其子会话：\n\n${codexThreadIdMarkdown(threadId)}` +
      '\n\n确认请发送 `/delete confirm`。',
    );
    return;
  }
  if (ctx.activeRuns.get(ctx.scope)) {
    await reply(ctx, '当前 turn 运行中，请先终止后再删除会话。');
    return;
  }
  await codexRpc(ctx, 'thread/delete', { threadId });
  const cwd = effectiveWorkspaceCwd(ctx);
  const identity = cwd ? await currentSessionCatalogIdentity(ctx, cwd) : undefined;
  if (identity) ctx.sessionCatalog?.archiveActive({ ...identity, now: Date.now() });
  await reply(ctx, '✓ 当前 Codex 会话已永久删除；下一条消息将创建新会话。');
}

async function handleCodexFork(ctx: CommandContext): Promise<void> {
  const remote = await codexRemoteContext(ctx);
  if (!remote.threadId) return reply(ctx, '当前 scope 没有可 fork 的 Codex thread。');
  const result = recordValue(await codexRpc(ctx, 'thread/fork', { threadId: remote.threadId }));
  const newThreadId = stringValue(recordValue(result?.thread)?.id);
  const cwd = effectiveWorkspaceCwd(ctx);
  const identity = cwd ? await currentSessionCatalogIdentity(ctx, cwd) : undefined;
  if (!newThreadId || !identity || !ctx.sessionCatalog) {
    throw new Error('Codex fork response did not include a usable thread');
  }
  ctx.sessionCatalog.upsertActive({ ...identity, threadId: newThreadId, now: Date.now() });
  ctx.workspaces.confirmCodexResume(ctx.scope);
  bindCodexThread(ctx, newThreadId, identity.cwdRealpath);
  await reply(ctx, `✓ 已 fork 并切换到新 thread。\n\n${codexThreadIdMarkdown(newThreadId)}`);
}

async function handleCodexGoal(args: string, ctx: CommandContext): Promise<void> {
  const value = args.trim();
  if (value === 'edit') {
    await reply(ctx, '用法：`/goal edit <新目标>`');
    return;
  }
  const setsObjective = Boolean(
    value
    && value !== 'clear'
    && value !== 'pause'
    && value !== 'resume'
  );
  let createdNewThread = false;
  let remote = await codexRemoteContext(ctx);
  if (!remote.threadId && setsObjective) {
    const started = await startCodexThread(ctx);
    if (!started) return;
    remote = { ...remote, threadId: started.threadId };
    createdNewThread = true;
  }
  if (!remote.threadId) return reply(ctx, '当前 scope 没有 Codex thread。');
  if (!value) {
    const result = await codexRpc(ctx, 'thread/goal/get', { threadId: remote.threadId });
    const goal = parseCodexGoal(recordValue(result)?.goal);
    await reply(
      ctx,
      goal ? `**当前 goal**\n\n${formatGoalSummary(goal)}` : '当前 thread 没有 goal。',
    );
    return;
  }
  if (value === 'clear') {
    await codexRpc(ctx, 'thread/goal/clear', { threadId: remote.threadId });
    await reply(ctx, '✓ 当前 goal 已清除。');
    return;
  }
  if (value === 'pause' || value === 'resume') {
    await codexRpc(ctx, 'thread/goal/set', {
      threadId: remote.threadId,
      status: value === 'pause' ? 'paused' : 'active',
    });
    await reply(ctx, `✓ 当前 goal 已${value === 'pause' ? '暂停' : '恢复'}。`);
    return;
  }
  const objective = value.startsWith('edit ') ? value.slice(5).trim() : value;
  const result = await codexRpc(ctx, 'thread/goal/set', {
    threadId: remote.threadId,
    objective,
    status: 'active',
  });
  const goal = parseCodexGoal(recordValue(result)?.goal);
  const startedGoalTurn = !ctx.activeRuns.get(ctx.scope);
  if (startedGoalTurn) {
    await codexRpc(ctx, 'turn/start', {
      ...codexTurnStartParams(ctx, remote.threadId, '请开始执行当前 goal。'),
      clientUserMessageId: CODEX_GOAL_CONTINUATION_CLIENT_ID,
      turnTrigger: 'goal',
    });
  }
  if (createdNewThread) {
    await reply(
      ctx,
      goal
        ? `✓ 已创建新的 Codex 对话并启动 goal。\n\n${formatGoalSummary(goal)}`
        : '✓ 已创建新的 Codex 对话并启动 goal。',
    );
    return;
  }
  const action = startedGoalTurn ? '已更新并启动' : '已更新，将由当前 turn 继续执行';
  await reply(ctx, goal ? `✓ 当前 goal ${action}。\n\n${formatGoalSummary(goal)}` : `✓ 当前 goal ${action}。`);
}

async function handleCodexSkill(args: string, ctx: CommandContext): Promise<void> {
  const value = args.trim();
  if (!value) {
    await handleCodexSkillsList(ctx);
    return;
  }

  const [rawName, ...rest] = value.split(/\s+/);
  const name = rawName?.startsWith('$') ? rawName.slice(1) : rawName;
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    await reply(ctx, '用法：`/skill <skill-name> [指令]`；查看技能请发送 `/skills`。');
    return;
  }
  if (ctx.activeRuns.get(ctx.scope)) {
    await reply(ctx, '当前 turn 运行中，请等待完成后再调用 skill。');
    return;
  }

  const remote = await codexRemoteContext(ctx);
  let threadId = remote.threadId;
  if (!threadId) {
    const started = await startCodexThread(ctx);
    if (!started) return;
    threadId = started.threadId;
  }
  const prompt = `$${name}${rest.length ? ` ${rest.join(' ')}` : ''}`;
  await codexRpc(ctx, 'turn/start', codexTurnStartParams(ctx, threadId, prompt));
  await reply(ctx, `✓ 已调用 skill **${name}**${rest.length ? ' 并开始执行指令' : ''}。`);
}

const CODEX_SKILLS_PAGE_SIZE = 6;

interface CodexSkillCatalogEntry {
  cwd: string;
  name: string;
  displayName?: string;
  description?: string;
  scope?: string;
  enabled?: boolean;
  path?: string;
}

interface CodexSkillCatalog {
  entries: CodexSkillCatalogEntry[];
  errors: string[];
}

async function handleCodexSkillsList(ctx: CommandContext, requestedPage = 1): Promise<void> {
  const result = await codexRpc(ctx, 'skills/list', {
    cwds: [effectiveWorkspaceCwd(ctx)].filter(Boolean),
    forceReload: false,
  });
  const catalog = parseCodexSkills(result);
  const pageCount = Math.max(1, Math.ceil(catalog.entries.length / CODEX_SKILLS_PAGE_SIZE));
  const page = Math.min(Math.max(requestedPage, 1), pageCount);
  const start = (page - 1) * CODEX_SKILLS_PAGE_SIZE;
  const card = codexSkillsCard({
    entries: catalog.entries.slice(start, start + CODEX_SKILLS_PAGE_SIZE),
    errors: page === 1 ? catalog.errors : [],
    page,
    pageCount,
    total: catalog.entries.length,
  });

  if (ctx.fromCardAction) {
    try {
      await updateManagedCard(ctx.channel, ctx.msg.messageId, card);
      return;
    } catch (err) {
      log.warn('command', 'skills-card-update-fallback', {
        messageId: ctx.msg.messageId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card, commandReplyOptions(ctx));
}

function parseCodexSkills(result: unknown): CodexSkillCatalog {
  const groups = resultData(result)
    .map(recordValue)
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  const entries: CodexSkillCatalogEntry[] = [];
  const errors: string[] = [];

  for (const group of groups) {
    const cwd = stringValue(group.cwd) ?? '未指定工作区';
    const skills = Array.isArray(group.skills)
      ? group.skills
        .map(recordValue)
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
      : [];
    skills.sort((a, b) => {
      const aName = stringValue(a.name) ?? stringValue(a.id) ?? '';
      const bName = stringValue(b.name) ?? stringValue(b.id) ?? '';
      return aName.localeCompare(bName);
    });
    for (const skill of skills) {
      const name = stringValue(skill.name) ?? stringValue(skill.id) ?? '未命名技能';
      const iface = recordValue(skill.interface);
      const displayName = stringValue(iface?.displayName);
      const description = compactSkillText(
        iface?.shortDescription ?? skill.shortDescription ?? skill.description,
      );
      entries.push({
        cwd,
        name,
        ...(displayName ? { displayName } : {}),
        ...(description ? { description } : {}),
        ...(stringValue(skill.scope) ? { scope: stringValue(skill.scope) } : {}),
        ...(typeof skill.enabled === 'boolean' ? { enabled: skill.enabled } : {}),
        ...(stringValue(skill.path) ? { path: stringValue(skill.path) } : {}),
      });
    }

    if (Array.isArray(group.errors)) {
      for (const error of group.errors) {
        const detail = formatCodexSkillError(error);
        if (detail) errors.push(`${cwd}：${detail}`);
      }
    }
  }

  return { entries, errors };
}

function formatCodexSkillError(error: unknown): string {
  if (typeof error === 'string') return compactSkillText(error);
  const record = recordValue(error);
  if (record) {
    const message = record.message ?? record.error ?? record.detail;
    if (message !== undefined) return compactSkillText(message);
    try {
      return compactSkillText(JSON.stringify(record));
    } catch {
      return '';
    }
  }
  return compactSkillText(error);
}

function compactSkillText(value: unknown, maxLength = 320): string {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

async function handleCodexLogout(ctx: CommandContext): Promise<void> {
  if (ctx.activeRuns.get(ctx.scope)) {
    await reply(ctx, '当前 turn 运行中，请先终止或等待完成后再退出 Codex 账号。');
    return;
  }
  await codexRpc(ctx, 'account/logout');
  await reply(ctx, '✓ 已退出 Codex 账号。');
}

async function startCodexThread(
  ctx: CommandContext,
): Promise<{ threadId: string } | undefined> {
  const cwd = await requireCodexWorkspace(ctx);
  if (!cwd) return undefined;
  const profile = ctx.workspaces.codexProfileFor(
    ctx.scope,
    ctx.controls.profileConfig.codex?.profile,
  );

  // A direct app-server slash command starts a fresh conversation even when
  // the scope was waiting for the workspace launch card. Persist that choice
  // before the thread is created so later turns resume the same thread.
  ctx.workspaces.setCodexLaunch(ctx.scope, profile ?? null, 'new');

  const result = await codexRpc(ctx, 'thread/start', await codexThreadParams(ctx, cwd));
  const threadId = stringValue(recordValue(recordValue(result)?.thread)?.id);
  if (!threadId) {
    await reply(ctx, 'Codex 未返回新 thread，无法启动新对话。请稍后重试。');
    return undefined;
  }
  const identity = await currentSessionCatalogIdentity(ctx, cwd);
  if (!identity) {
    await reply(ctx, '当前工作目录或权限策略不允许启动 Codex 对话。');
    return undefined;
  }
  ctx.sessionCatalog?.upsertActive({ ...identity, threadId, now: Date.now() });
  bindCodexThread(ctx, threadId, cwd, identity.policyFingerprint);
  return { threadId };
}

function codexTurnStartParams(
  ctx: CommandContext,
  threadId: string,
  text: string,
): Record<string, unknown> {
  const cwd = effectiveWorkspaceCwd(ctx);
  if (!cwd) throw new Error('当前 Codex thread 没有关联工作目录');
  const model = ctx.workspaces.codexModelFor(
    ctx.scope,
    resolveModelArg('codex', ctx.controls.profileConfig.preferences.model),
  );
  const personality = ctx.workspaces.codexPersonalityFor(ctx.scope);
  return {
    threadId,
    input: [{ type: 'text', text, text_elements: [] }],
    cwd,
    approvalPolicy: 'never',
    sandboxPolicy: codexSandboxPolicy(effectiveCodexSandbox(ctx), cwd),
    ...(model ? { model } : {}),
    ...(personality ? { personality } : {}),
  };
}

async function handleCodexDebugConfig(ctx: CommandContext): Promise<void> {
  const cwd = effectiveWorkspaceCwd(ctx);
  const [config, requirements] = await Promise.all([
    codexRpc(ctx, 'config/read', { includeLayers: true, ...(cwd ? { cwd } : {}) }),
    codexRpc(ctx, 'configRequirements/read'),
  ]);
  await reply(
    ctx,
    formatJsonResult('Codex config layers / requirements', { config, requirements }),
  );
}

async function handleCodexExperimental(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const result = await codexRpc(ctx, 'experimentalFeature/list', { limit: 100 });
  const features = resultData(result)
    .map(recordValue)
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  if (parts.length === 0 || parts[0] === 'list') {
    const visible = features.filter((feature) =>
      feature.displayName !== null || feature.stage === 'beta' || feature.stage === 'underDevelopment',
    );
    const lines = visible.map((feature) => {
      const name = String(feature.name ?? 'unknown');
      const label = String(feature.displayName ?? name);
      const status = feature.enabled === true ? 'on' : 'off';
      return `- **${label}** (\`${name}\`) · ${status} · ${String(feature.stage ?? 'unknown')}`;
    });
    await reply(ctx, `**Codex experimental features**\n\n${lines.join('\n') || '没有可显示的实验功能。'}\n\n设置：\`/experimental <name> on|off\``);
    return;
  }
  const name = parts[0] ?? '';
  const toggle = parts[1]?.toLowerCase();
  if (!name || (toggle !== 'on' && toggle !== 'off')) {
    await reply(ctx, '用法：`/experimental [list|<name> on|off]`');
    return;
  }
  if (!features.some((feature) => feature.name === name && feature.stage !== 'removed')) {
    await reply(ctx, `未找到可切换的实验功能：\`${name}\`。`);
    return;
  }
  const enabled = toggle === 'on';
  await codexRpc(ctx, 'config/value/write', {
    keyPath: `features.${name}`,
    value: enabled,
    mergeStrategy: 'upsert',
  });
  await codexRpc(ctx, 'experimentalFeature/enablement/set', {
    enablement: { [name]: enabled },
  });
  await reply(ctx, `✓ 实验功能 \`${name}\` 已${enabled ? '开启' : '关闭'}。`);
}

async function handleCodexMemories(args: string, ctx: CommandContext): Promise<void> {
  const value = args.trim().toLowerCase();
  if (!value) {
    await reply(ctx, '用法：`/memories enabled|disabled`（仅设置当前 Codex thread）');
    return;
  }
  const mode = value === 'on' ? 'enabled' : value === 'off' ? 'disabled' : value;
  if (mode !== 'enabled' && mode !== 'disabled') {
    await reply(ctx, '用法：`/memories enabled|disabled`');
    return;
  }
  const threadId = await requireCodexThread(ctx);
  if (!threadId) return;
  await codexRpc(ctx, 'thread/memoryMode/set', { threadId, mode });
  await reply(ctx, `✓ 当前 thread 的 memories 已${mode === 'enabled' ? '开启' : '关闭'}。`);
}

async function handleCodexBackgroundTerminalsStop(ctx: CommandContext): Promise<void> {
  const threadId = await requireCodexThread(ctx);
  if (!threadId) return;
  await codexRpc(ctx, 'thread/backgroundTerminals/clean', { threadId });
  await reply(ctx, '✓ 已停止当前 Codex thread 的所有后台终端。');
}

async function handleThreadRpc(
  ctx: CommandContext,
  method: string,
  args: string,
  params: (threadId: string) => Record<string, unknown>,
  success: string,
  requireArgs = false,
  usage = `/${method}`,
): Promise<void> {
  if (requireArgs && !args.trim()) {
    await reply(ctx, `用法：\`${usage}\``);
    return;
  }
  const remote = await codexRemoteContext(ctx);
  if (!remote.threadId) {
    await reply(ctx, '当前 scope 没有 Codex thread；请先新建或恢复会话。');
    return;
  }
  await codexRpc(ctx, method, params(remote.threadId));
  await reply(ctx, `✓ ${success}。`);
}

async function handleGlobalRpc(
  ctx: CommandContext,
  method: string,
  params: unknown,
  title: string,
): Promise<void> {
  const result = await codexRpc(ctx, method, params);
  await reply(ctx, formatRpcResult(title, result));
}

async function codexRpc(ctx: CommandContext, method: string, params?: unknown): Promise<unknown> {
  if (!ctx.agent.appServerRequest) throw new Error('当前 Codex adapter 不支持 app-server 控制命令');
  const profile = ctx.workspaces.codexProfileFor(ctx.scope, ctx.controls.profileConfig.codex?.profile);
  return ctx.agent.appServerRequest(profile, method, params);
}

async function codexRemoteContext(ctx: CommandContext): Promise<{
  endpoint: string;
  threadId?: string;
  profile?: string;
}> {
  const profile = ctx.workspaces.codexProfileFor(ctx.scope, ctx.controls.profileConfig.codex?.profile);
  const active = ctx.activeRuns.get(ctx.scope)?.run.remoteSession?.();
  const cwd = effectiveWorkspaceCwd(ctx);
  const identity = cwd ? await currentSessionCatalogIdentity(ctx, cwd) : undefined;
  const threadId = active?.threadId ?? (identity ? ctx.sessionCatalog?.activeFor(identity)?.threadId : undefined);
  const endpoint = active?.endpoint
    || await ctx.agent.appServerEndpoint?.(profile)
    || '';
  if (!endpoint) throw new Error('当前 Codex adapter 不支持远程附着');
  if (threadId && cwd) bindCodexThread(ctx, threadId, cwd);
  return { endpoint, threadId, ...(profile ? { profile } : {}) };
}

async function currentCodexThreadId(ctx: CommandContext): Promise<string | undefined> {
  const active = ctx.activeRuns.get(ctx.scope)?.run.remoteSession?.();
  if (active?.threadId) return active.threadId;
  const cwd = effectiveWorkspaceCwd(ctx);
  const identity = cwd ? await currentSessionCatalogIdentity(ctx, cwd) : undefined;
  return identity ? ctx.sessionCatalog?.activeFor(identity)?.threadId : undefined;
}

async function requireCodexThread(ctx: CommandContext): Promise<string | undefined> {
  const remote = await codexRemoteContext(ctx);
  if (remote.threadId) return remote.threadId;
  await reply(ctx, '当前 scope 还没有 Codex thread；请先新建或恢复会话。');
  return undefined;
}

async function updateCodexThreadSettingsIfPresent(
  ctx: CommandContext,
  settings: Record<string, unknown>,
): Promise<boolean> {
  const threadId = await currentCodexThreadId(ctx);
  if (!threadId) return false;
  await updateCodexThreadSettings(ctx, threadId, settings);
  return true;
}

async function updateCodexThreadSettings(
  ctx: CommandContext,
  threadId: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await codexRpc(ctx, 'thread/resume', { threadId, excludeTurns: true });
  await codexRpc(ctx, 'thread/settings/update', { threadId, ...settings });
}

function codexSandboxPolicy(mode: CodexSandboxMode, cwd: string): Record<string, unknown> {
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

function bindCodexThread(
  ctx: CommandContext,
  threadId: string,
  cwd: string,
  policyFingerprint = ctx.sessionCatalogIdentity?.policyFingerprint,
): void {
  const profile = ctx.workspaces.codexProfileFor(
    ctx.scope,
    ctx.controls.profileConfig.codex?.profile,
  );
  ctx.agent.bindRemoteThread?.({
    scopeId: ctx.scope,
    chatId: ctx.msg.chatId,
    threadId,
    ...(ctx.msg.threadId ? { messageThreadId: ctx.msg.threadId } : {}),
    replyTo: ctx.msg.messageId,
    operatorOpenId: ctx.msg.senderId,
    ...(profile ? { profile } : {}),
    cwd,
    sandbox: effectiveCodexSandbox(ctx),
    ...(policyFingerprint
      ? { policyFingerprint }
      : {}),
  });
}

async function replyWithAttachHint(ctx: CommandContext, reason: string): Promise<void> {
  const remote = await codexRemoteContext(ctx);
  if (!remote.threadId) {
    await reply(ctx, `${reason}。请先新建或恢复 Codex 会话，再发送 \`/attach\`。`);
    return;
  }
  await reply(
    ctx,
    `${reason}。\n\n${codexThreadIdMarkdown(remote.threadId)}\n\n` +
      `请在附着终端中执行：\n\n${copyableShellCommandMarkdown(
        codexAttachCommand(remote.endpoint, remote.threadId, remote.profile),
      )}`,
  );
}

async function requireCodexWorkspace(ctx: CommandContext): Promise<string | undefined> {
  const cwd = effectiveWorkspaceCwd(ctx);
  if (!cwd) {
    await reply(ctx, '请先使用 `/cd <path>` 选择工作目录。');
    return undefined;
  }
  if (!ctx.workspaces.cwdFor(ctx.scope)) ctx.workspaces.setCwd(ctx.scope, cwd);
  return cwd;
}

function formatRpcResult(title: string, result: unknown): string {
  const entries = resultData(result);
  if (entries.length) {
    const lines = entries.map((entry, index) => {
      const record = recordValue(entry);
      if (!record) return `${index + 1}. ${String(entry)}`;
      const name = record.displayName ?? record.name ?? record.id ?? record.slug ?? record.title;
      const detail = record.description ?? record.status ?? record.enabled;
      return `${index + 1}. **${String(name ?? 'item')}**${detail === undefined ? '' : ` — ${String(detail)}`}`;
    });
    return `**${title}**\n\n${lines.join('\n')}`;
  }
  const json = JSON.stringify(result ?? {}, null, 2);
  return `**${title}**\n\n\`\`\`json\n${json.slice(0, 16_000)}\n\`\`\``;
}

function formatJsonResult(title: string, result: unknown): string {
  const json = JSON.stringify(result ?? {}, null, 2);
  const limit = 16_000;
  const body = json.length > limit
    ? `${json.slice(0, limit)}\n…（输出已截断；完整配置请在附着 TUI 中查看）`
    : json;
  return `**${title}**\n\n\`\`\`json\n${body}\n\`\`\``;
}

function resultData(result: unknown): unknown[] {
  const record = recordValue(result);
  return Array.isArray(record?.data) ? record.data : [];
}

function shellCommand(args: string[]): string {
  return args.map((arg) => /^[A-Za-z0-9_./:@-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'"'"'`)}'`).join(' ');
}

function codexAttachCommand(endpoint: string, threadId: string, profile?: string): string {
  const args = ['codex'];
  if (profile) args.push('--profile', profile);
  args.push('--remote', endpoint, 'resume', threadId);
  return shellCommand(args);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseCodexSandbox(value: string): CodexSandboxMode | undefined {
  switch (value.toLowerCase()) {
    case 'read':
    case 'readonly':
    case 'read-only':
      return 'read-only';
    case 'workspace':
    case 'workspace-write':
    case 'auto':
      return 'workspace-write';
    case 'full':
    case 'danger':
    case 'danger-full-access':
      return 'danger-full-access';
    default:
      return undefined;
  }
}

async function handleNewChat(rawName: string, ctx: CommandContext): Promise<void> {
  const sourceCwd = effectiveWorkspaceCwd(ctx);
  const projectName = sourceCwd ? basename(sourceCwd) : '';
  const name = rawName || (projectName
    ? `${ctx.agent.displayName} · ${projectName}`
    : defaultChatName(ctx.agent.displayName));

  const project = sourceCwd
    ? await resolveProjectChat(ctx, sourceCwd, name)
    : await createUnboundChat(ctx, name);
  if (!project) return;

  if (sourceCwd) {
    if (project.chatId !== ctx.scope) {
      const existing = ctx.workspaces.selectionFor(project.chatId);
      if (existing) ctx.workspaces.setCwd(project.chatId, sourceCwd);
      else ctx.workspaces.inheritForNewScope(ctx.scope, project.chatId, sourceCwd);
    }
    if (ctx.agent.id === 'codex') {
      const projectProfile = ctx.workspaces.selectionFor(project.chatId)?.codexProfile;
      const sourceProfile = ctx.workspaces.selectionFor(ctx.scope)?.codexProfile;
      const stored = projectProfile !== undefined ? projectProfile : sourceProfile;
      const profile = stored !== undefined
        ? stored
        : ctx.controls.profileConfig.codex?.profile ?? null;
      ctx.workspaces.setCodexLaunch(project.chatId, profile, 'new');
      const projectCtx = project.chatId === ctx.scope
        ? ctx
        : projectCommandContext(ctx, project.chatId, ctx.msg.messageId);
      const identity = await currentSessionCatalogIdentity(projectCtx, sourceCwd);
      if (ctx.sessionCatalog && identity) {
        ctx.sessionCatalog.archiveActive({ ...identity, now: Date.now() });
      }
    }
    ctx.activeRuns.interrupt(project.chatId);
    ctx.sessions.clear(project.chatId);
  }

  const welcome = sourceCwd
    ? `🎉 ${project.created ? '独立项目群已建好' : '已复用现有项目群'}：\`${sourceCwd}\`\n\n已继承当前 Codex profile/权限设置，下一条消息会创建独立新会话。\n\n@我 + 任意消息开始对话。`
    : '🎉 群已建好。\n\n@我 + 任意消息开始对话。';
  try {
    await ctx.channel.send(project.chatId, { markdown: welcome });
  } catch (err) {
    console.warn('[new-chat] welcome message failed:', err);
  }

  await reply(
    ctx,
    `✓ ${project.created ? '已创建' : '已复用'}群 **${project.name}**，去该群继续。`,
  );
}

async function createUnboundChat(
  ctx: CommandContext,
  name: string,
): Promise<ResolvedProjectChat | undefined> {
  try {
    const created = await createBoundChat({
      channel: ctx.channel,
      name,
      inviteOpenId: ctx.msg.senderId,
    });
    return { ...created, created: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await reply(ctx, `❌ 创建群失败：${message}\n\n确认 bot 已开启 \`im:chat\` 权限。`);
    return undefined;
  }
}

async function handleCd(args: string, ctx: CommandContext): Promise<void> {
  const input = args.trim();
  if (!input) {
    await reply(ctx, '用法：`/cd <绝对路径>` 或 `/cd ~/xxx`');
    return;
  }
  if (!isAbsoluteOrTilde(input)) {
    await reply(ctx, '请使用绝对路径，或 `~/xxx` 表示 home 下的子路径。');
    return;
  }
  const absolute = expandTilde(input);
  const workspace = await resolveWorkingDirectory(absolute);
  if (!workspace.ok) {
    await reply(ctx, workspace.userVisible);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  if (ctx.agent.id === 'codex') {
    ctx.workspaces.prepareCodexLaunch(ctx.scope, workspace.cwdRealpath);
    await showWorkspaceLaunchCard(ctx, workspace.cwdRealpath);
    return;
  }
  ctx.workspaces.setCwd(ctx.scope, workspace.cwdRealpath);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, `✓ 已切换 cwd 到 \`${workspace.cwdRealpath}\`\n（session 已重置）`);
}

async function handleWs(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0] ?? '';
  const name = parts.slice(1).join(' ').trim();
  switch (sub) {
    case '':
    case 'list':
      return handleWsList(ctx);
    case 'save':
      return handleWsSave(name, ctx);
    case 'use':
      return handleWsUse(name, ctx);
    case 'launch':
      return handleWorkspaceLaunch(name, ctx);
    case 'new':
      return handleWorkspaceQuickLaunch('new', ctx);
    case 'resume':
      return handleWorkspaceQuickLaunch('resume', ctx);
    case 'remove':
    case 'rm':
      return handleWsRemove(name, ctx);
    default:
      await reply(ctx, '用法：`/ws [list|save <name>|use <name>|remove <name>]`');
  }
}

async function handleWsList(ctx: CommandContext): Promise<void> {
  const named = listScopedWorkspaces(ctx);
  const currentCwd = effectiveWorkspaceCwd(ctx);
  const card = workspacesCard(
    currentCwd,
    named,
  );
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

async function handleWsSave(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws save <name>`');
    return;
  }
  const cwd = effectiveWorkspaceCwd(ctx);
  if (!cwd) {
    await reply(ctx, '当前 chat 未设置 cwd，先用 `/cd` 设置再保存。');
    return;
  }
  ctx.workspaces.saveNamed(scopedWorkspaceName(ctx, name), cwd);
  await reply(ctx, `✓ 工作目录别名已保存：\`${name}\` → ${cwd}`);
}

async function handleWsUse(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws use <name>`');
    return;
  }
  const cwd = getWorkspaceAlias(ctx, name);
  if (!cwd) {
    await reply(ctx, `未找到工作目录别名：\`${name}\``);
    return;
  }
  const workspace = await resolveWorkingDirectory(cwd);
  if (!workspace.ok) {
    await reply(ctx, workspace.userVisible);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  if (ctx.agent.id === 'codex') {
    ctx.workspaces.prepareCodexLaunch(ctx.scope, workspace.cwdRealpath);
    await showWorkspaceLaunchCard(ctx, workspace.cwdRealpath, name);
    return;
  }
  ctx.workspaces.setCwd(ctx.scope, workspace.cwdRealpath);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, `✓ 已切换到 \`${name}\` (${workspace.cwdRealpath})\n（session 已重置）`);
}

async function showWorkspaceLaunchCard(
  ctx: CommandContext,
  cwd: string,
  alias?: string,
): Promise<void> {
  const configuredProfile = ctx.workspaces.codexProfileFor(
    ctx.scope,
    ctx.controls.profileConfig.codex?.profile,
  );
  let profiles = await discoverCommandCodexProfiles(ctx, cwd);
  if (configuredProfile && !profiles.includes(configuredProfile)) {
    profiles = [...profiles, configuredProfile].sort((a, b) => a.localeCompare(b));
  }
  const card = workspaceLaunchCard({
    cwd,
    profiles,
    configuredProfile,
    routesToProjectGroup: ctx.chatMode === 'p2p',
    ...(ctx.chatMode === 'p2p' ? { projectChatName: projectChatName(ctx, cwd) } : {}),
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
  log.info('command', 'workspace-selected-awaiting-codex-launch', {
    scope: ctx.scope,
    cwd,
    alias: alias ?? null,
    profiles: profiles.length,
  });
}

/** Run one of the quick actions rendered below the workspace/resume cards. */
async function handleWorkspaceQuickLaunch(
  mode: 'new' | 'resume',
  ctx: CommandContext,
): Promise<void> {
  if (ctx.agent.id !== 'codex') return;
  const cwd = ctx.workspaces.pendingCodexCwdFor(ctx.scope) ?? effectiveWorkspaceCwd(ctx);
  if (!cwd) {
    await reply(ctx, '当前工作目录不存在，请重新使用 `/cd <path>`。');
    return;
  }
  const selectedProfile = typeof ctx.formValue?.codex_profile === 'string'
    ? ctx.formValue.codex_profile.trim()
    : '';
  const profile = selectedProfile
    ? selectedProfile === '__default__'
      ? null
      : selectedProfile
    : ctx.workspaces.codexProfileFor(
        ctx.scope,
        ctx.controls.profileConfig.codex?.profile,
      ) ?? null;
  const projectChatName = typeof ctx.formValue?.project_chat_name === 'string'
    ? ctx.formValue.project_chat_name.trim()
    : '';
  await handleWorkspaceLaunch('', {
    ...ctx,
    formValue: {
      ...(ctx.formValue ?? {}),
      codex_profile: profile ?? '__default__',
      launch_mode: mode,
      ...(projectChatName ? { project_chat_name: projectChatName } : {}),
    },
  });
}

async function discoverCommandCodexProfiles(
  ctx: CommandContext,
  cwd: string,
): Promise<string[]> {
  try {
    return await discoverCodexProfiles({
      cwd,
      codexHome: ctx.controls.profileConfig.codex?.codexHome,
      inheritCodexHome: ctx.controls.profileConfig.codex?.inheritCodexHome,
      profileStateDir: commandProfilePaths(ctx).profileDir,
    });
  } catch (err) {
    log.warn('command', 'codex-profile-discovery-failed', {
      cwd,
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function handleWorkspaceLaunch(args: string, ctx: CommandContext): Promise<void> {
  if (ctx.agent.id !== 'codex') return;
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const rawProfile = String(ctx.formValue?.codex_profile ?? parts[0] ?? '').trim();
  const rawMode = String(ctx.formValue?.launch_mode ?? parts[1] ?? '').trim();
  const requestedProjectChatName = String(ctx.formValue?.project_chat_name ?? '').trim() || undefined;
  if (!rawProfile || (rawMode !== 'new' && rawMode !== 'resume')) {
    await reply(ctx, '请在工作目录卡片中选择 Codex profile 和会话方式。');
    return;
  }
  const profile = rawProfile === '__default__' ? null : rawProfile;
  const cwd = ctx.workspaces.pendingCodexCwdFor(ctx.scope) ?? effectiveWorkspaceCwd(ctx);
  if (!cwd) {
    await reply(ctx, '当前工作目录不存在，请重新使用 `/cd <path>`。');
    return;
  }
  const project = await resolveProjectChat(ctx, cwd, requestedProjectChatName);
  if (!project) return;

  let launchCtx = ctx;
  let projectAck: string | undefined;
  if (project.chatId !== ctx.msg.chatId || ctx.chatMode === 'topic') {
    const existing = ctx.workspaces.selectionFor(project.chatId);
    if (existing) ctx.workspaces.setCwd(project.chatId, cwd);
    else ctx.workspaces.inheritForNewScope(ctx.scope, project.chatId, cwd);
    ctx.workspaces.setCodexLaunch(project.chatId, profile, rawMode);
    ctx.workspaces.cancelCodexLaunch(ctx.scope);
    if (ctx.chatMode === 'p2p') ctx.workspaces.removeCwd(ctx.scope);

    let anchor: { messageId: string };
    try {
      anchor = await ctx.channel.send(project.chatId, {
        markdown: rawMode === 'new'
          ? `${project.created ? '🚀 已创建' : '🔁 已复用'}项目群\n已选择 ${formatCodexProfile(profile)}\n📁 \`${cwd}\`\n\n下一条消息将在本项目群创建新 Codex 会话。`
          : `${project.created ? '🚀 已创建' : '🔁 已复用'}项目群\n已选择 ${formatCodexProfile(profile)}\n📁 \`${cwd}\`\n\n正在读取可恢复的 Codex 会话…`,
      });
    } catch (err) {
      log.warn('command', 'project-chat-notify-failed', {
        cwd,
        chatId: project.chatId,
        message: err instanceof Error ? err.message : String(err),
      });
      await reply(
        ctx,
        `${project.created ? '✓ 已创建' : '✓ 已复用'}路径对应的项目群 **${project.name}**，但群内提示发送失败，请在飞书群列表中搜索该群。`,
      );
      return;
    }
    launchCtx = projectCommandContext(ctx, project.chatId, anchor.messageId);
    projectAck = `${project.created ? '✓ 已创建' : '✓ 已复用'}路径对应的项目群 **${project.name}**，请去该群继续。`;
  } else {
    ctx.workspaces.setCodexLaunch(ctx.scope, profile, rawMode);
  }

  const identity = await currentSessionCatalogIdentity(launchCtx, cwd);
  launchCtx.sessionCatalogIdentity = identity;
  if (rawMode === 'new') {
    launchCtx.activeRuns.interrupt(launchCtx.scope);
    if (launchCtx.sessionCatalog && identity) {
      launchCtx.sessionCatalog.archiveActive({ ...identity, now: Date.now() });
    }
    launchCtx.sessions.clear(launchCtx.scope);
    await launchCtx.channel.send(
      launchCtx.msg.chatId,
      {
        card: workspaceNewCard({
          cwd,
          profile: formatCodexProfile(profile),
        }),
      },
      commandReplyOptions(launchCtx),
    ).catch((err) => {
      log.warn('command', 'workspace-new-card-send-failed', {
        cwd,
        scope: launchCtx.scope,
        message: errorMessage(err),
      });
    });
    if (launchCtx === ctx) {
      await reply(
        ctx,
        `✓ 已选择 ${formatCodexProfile(profile)}，下一条消息将创建新会话。`,
      );
    } else if (projectAck) {
      await reply(ctx, projectAck);
    }
    return;
  }
  if (projectAck) await reply(ctx, projectAck);
  await handleResume('', launchCtx);
}

interface ResolvedProjectChat {
  chatId: string;
  name: string;
  created: boolean;
}

async function resolveProjectChat(
  ctx: CommandContext,
  cwd: string,
  requestedName?: string,
): Promise<ResolvedProjectChat | undefined> {
  // A slow Feishu callback can be retried before the first createChat call
  // returns. Serialize resolutions for this bridge profile/app, operator and
  // canonical path so retries observe the same in-flight result instead of
  // creating a second group. Keep the operator in the key because a project
  // group is private and initially contains only its requesting user.
  const key = `${ctx.controls.profile}\u0000${ctx.controls.cfg.accounts.app.id}\u0000${ctx.msg.senderId}\u0000${cwd}`;
  const pending = projectChatResolutions.get(key);
  if (pending) return pending;

  const resolution = resolveProjectChatInternal(ctx, cwd, requestedName);
  projectChatResolutions.set(key, resolution);
  try {
    return await resolution;
  } finally {
    if (projectChatResolutions.get(key) === resolution) projectChatResolutions.delete(key);
  }
}

async function resolveProjectChatInternal(
  ctx: CommandContext,
  cwd: string,
  requestedName?: string,
): Promise<ResolvedProjectChat | undefined> {
  const currentPath = ctx.chatMode === 'group'
    ? ctx.workspaces.projectPathForChat(ctx.msg.chatId)
    : undefined;
  const mapped = ctx.workspaces.projectChatFor(cwd);

  if (ctx.chatMode === 'group' && (!currentPath || currentPath === cwd)) {
    if (!mapped || mapped.chatId === ctx.msg.chatId) {
      const name = mapped?.name
        ?? ctx.controls.knownChats?.find((chat) => chat.id === ctx.msg.chatId)?.name
        ?? requestedName
        ?? projectChatName(ctx, cwd);
      ctx.workspaces.setProjectChat(cwd, { chatId: ctx.msg.chatId, name });
      await ctx.workspaces.flush();
      return { chatId: ctx.msg.chatId, name, created: false };
    }
  }

  if (mapped) {
    try {
      const live = await getProjectChatInfo(ctx.channel, mapped.chatId);
      const members = await getProjectChatMembers(ctx.channel, mapped.chatId);
      if (members.some((member) => member.id === ctx.msg.senderId)) {
        const name = live.name || mapped.name;
        if (name !== mapped.name) {
          ctx.workspaces.setProjectChat(cwd, { chatId: mapped.chatId, name });
        }
        return { chatId: mapped.chatId, name, created: false };
      }
      ctx.workspaces.removeProjectChat(cwd);
    } catch (err) {
      if (isMissingProjectChatError(err)) {
        ctx.workspaces.removeProjectChat(cwd);
      } else {
        log.warn('command', 'project-chat-check-failed', {
          cwd,
          message: err instanceof Error ? err.message : String(err),
        });
        await reply(ctx, '暂时无法确认已有项目群是否仍存在；为避免重复建群，本次没有创建新群，请稍后重试。');
        return undefined;
      }
    }
  }

  const name = requestedName || projectChatName(ctx, cwd);
  try {
    const created = await createBoundChat({
      channel: ctx.channel,
      name,
      inviteOpenId: ctx.msg.senderId,
    });
    ctx.workspaces.setProjectChat(cwd, created);
    // The remote group already exists at this point. Persist its binding
    // before returning so a daemon restart cannot lose the only idempotency
    // record and create a second group for the same path.
    await ctx.workspaces.flush();
    ctx.controls.knownChats = [
      ...(ctx.controls.knownChats ?? []).filter((chat) => chat.id !== created.chatId),
      { id: created.chatId, name: created.name },
    ];
    return { ...created, created: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await reply(ctx, `❌ 创建项目群失败：${message}\n\n确认 bot 已开启 \`im:chat\` 权限。`);
    return undefined;
  }
}

async function getProjectChatInfo(channel: LarkChannel, chatId: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      channel.getChatInfo(chatId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('project chat lookup timed out')),
          PROJECT_CHAT_LOOKUP_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function getProjectChatMembers(channel: LarkChannel, chatId: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      channel.getChatMembers(chatId, { force: true, idType: 'open_id' }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('project chat members lookup timed out')),
          PROJECT_CHAT_LOOKUP_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isMissingProjectChatError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'target_revoked' || code === 'format_error';
}

function projectChatName(ctx: CommandContext, cwd: string): string {
  const agentName = ctx.agent.id === 'codex' ? 'Codex' : ctx.agent.displayName;
  return `${agentName} 项目群｜${basename(cwd)}`;
}

function projectCommandContext(
  ctx: CommandContext,
  chatId: string,
  messageId: string,
): CommandContext {
  const { threadId: _threadId, ...sourceMessage } = ctx.msg;
  return {
    ...ctx,
    msg: {
      ...sourceMessage,
      messageId,
      chatId,
      chatType: 'group',
    },
    scope: chatId,
    chatMode: 'group',
    sessionCatalogIdentity: undefined,
    formValue: undefined,
    fromCardAction: false,
  };
}

async function currentSessionCatalogIdentity(
  ctx: CommandContext,
  cwdRealpath: string,
): Promise<SessionCatalogIdentity | undefined> {
  const access = ctx.chatMode === 'p2p'
    ? canUseDm(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId)
    : canUseGroup(
        ctx.controls.profileConfig,
        ctx.controls,
        ctx.msg.chatId,
        ctx.msg.senderId,
      );
  const capability = codexCapability(ctx.controls.profileConfig);
  const policy = evaluateRunPolicy({
    scope: {
      source: 'im',
      chatId: ctx.msg.chatId,
      actorId: ctx.msg.senderId,
      ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { threadId: ctx.msg.threadId } : {}),
    },
    attachments: [],
    prompt: '',
    requestedCwd: cwdRealpath,
    cwdRealpath,
    access,
    capability,
    profileConfig: ctx.controls.profileConfig,
    now: Date.now(),
    codexHome: ctx.controls.profileConfig.codex?.codexHome,
    inheritCodexHome: ctx.controls.profileConfig.codex?.inheritCodexHome,
    codexProfile: ctx.workspaces.codexProfileFor(
      ctx.scope,
      ctx.controls.profileConfig.codex?.profile,
    ),
    codexSandbox: ctx.workspaces.codexSandboxFor(ctx.scope),
  });
  if (!policy.ok) return undefined;
  return {
    scopeId: ctx.scope,
    agentId: 'codex',
    cwdRealpath,
    policyFingerprint: policy.policyFingerprint,
  };
}

function formatCodexProfile(profile: string | null): string {
  return profile ? `Codex profile \`${profile}\`` : 'Codex 默认配置（无 `--profile`）';
}

async function handleWsRemove(name: string, ctx: CommandContext): Promise<void> {
  if (!name) {
    await reply(ctx, '用法：`/ws remove <name>`');
    return;
  }
  if (!removeWorkspaceAlias(ctx, name)) {
    await reply(ctx, `未找到工作目录别名：\`${name}\``);
    return;
  }
  await reply(ctx, `✓ 已删除工作目录别名：\`${name}\``);
}

async function handleDoc(args: string, ctx: CommandContext): Promise<void> {
  void args;
  await reply(ctx, '云文档评论现在不需要绑定工作区；在支持的文档评论里 @bot 即可触发回复。');
}

const WORKSPACE_NAME_SEPARATOR = '\u001f';

function scopedWorkspaceName(ctx: CommandContext, name: string): string {
  return [
    ctx.controls.profile,
    ctx.controls.botOwnerId ?? 'owner-unknown',
    ctx.scope,
    name,
  ].join(WORKSPACE_NAME_SEPARATOR);
}

function workspaceAliasKeys(ctx: CommandContext, name: string): string[] {
  return [scopedWorkspaceName(ctx, name), name];
}

function getWorkspaceAlias(ctx: CommandContext, name: string): string | undefined {
  for (const key of workspaceAliasKeys(ctx, name)) {
    const cwd = ctx.workspaces.getNamed(key);
    if (cwd) return cwd;
  }
  return undefined;
}

function removeWorkspaceAlias(ctx: CommandContext, name: string): boolean {
  const scopedKey = scopedWorkspaceName(ctx, name);
  if (ctx.workspaces.removeNamed(scopedKey)) return true;
  return ctx.workspaces.removeNamed(name);
}

function isLegacyWorkspaceAlias(key: string): boolean {
  return key !== '' && !key.includes(WORKSPACE_NAME_SEPARATOR);
}

function listScopedWorkspaces(ctx: CommandContext): Record<string, string> {
  const prefix = scopedWorkspaceName(ctx, '');
  const named = ctx.workspaces.listNamed();
  const scoped: Record<string, string> = {};
  for (const [key, cwd] of Object.entries(named)) {
    if (!key.startsWith(prefix)) continue;
    const displayName = key.slice(prefix.length);
    if (displayName) scoped[displayName] = cwd;
  }
  for (const [key, cwd] of Object.entries(named)) {
    if (isLegacyWorkspaceAlias(key) && scoped[key] === undefined) scoped[key] = cwd;
  }
  return scoped;
}

async function handleResume(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? '';
  const rest = parts.slice(1).join(' ').trim();

  if (sub === 'use' && rest) {
    return applyResume(rest, ctx);
  }
  if (sub === 'takeover') {
    if (!rest) {
      await reply(ctx, '请从“终止占用并接管”确认卡执行接管。');
      return;
    }
    return applyResumeTakeover(rest, ctx);
  }
  if (sub === 'history') {
    const [choice, nonce] = rest.split(/\s+/, 2);
    if (!nonce || (choice !== 'send' && choice !== 'skip')) {
      await reply(ctx, '请从历史上下文选择卡执行操作。');
      return;
    }
    return applyResumeHistoryChoice(nonce, choice === 'send', ctx);
  }
  // Default: list recent sessions
  const n = Number.parseInt(sub, 10);
  const limit = Number.isFinite(n) && n > 0 && n <= 20 ? n : 5;

  const cwd = selectedResumeCwd(ctx);
  if (!cwd) {
    await reply(ctx, '请先使用 /cd <path> 选择工作目录，再查看或恢复会话。');
    return;
  }

  const isManagedProjectGroup =
    ctx.chatMode === 'group'
    && ctx.workspaces.projectChatFor(cwd)?.chatId === ctx.msg.chatId;
  if (ctx.chatMode !== 'p2p' && !isManagedProjectGroup) {
    await reply(ctx, '群聊中不展示历史会话详情。请私聊 bot 使用 `/resume` 查看和选择历史会话。');
    return;
  }

  if (ctx.controls.profileConfig.agentKind === 'codex') {
    const identity = ctx.sessionCatalogIdentity;
    const entry =
      ctx.sessionCatalog && identity
        ? ctx.sessionCatalog.activeFor(identity)
        : undefined;
    const history = identity
      ? await listCodexResumeHistory(ctx, cwd, limit)
      : [];
    if (history.length > 0 && identity) {
      const entries = history.map((thread) => {
        const nonce = issueResumeCandidate(identity, { threadId: thread.threadId });
        return {
          sessionId: nonce,
          displayId: thread.threadId,
          preview: thread.name || thread.preview,
          relTime: formatRelTime(thread.updatedAtMs),
          detail: `Codex · ${thread.source}`,
          current: thread.threadId === entry?.threadId,
        };
      });
      const card = resumeCard(cwd, entries, { showNewCodexAction: true, copyableIds: true });
      await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
      return;
    }
    if (entry?.threadId && identity) {
      const nonce = issueResumeCandidate(identity, { threadId: entry.threadId });
      await ctx.channel.send(
        ctx.msg.chatId,
        {
          card: resumeCard(cwd, [{
            sessionId: nonce,
            displayId: entry.threadId,
            preview: '当前 Codex 会话',
            relTime: '当前',
            detail: 'Codex · 当前会话',
            current: true,
          }], { showNewCodexAction: true, copyableIds: true }),
        },
        commandReplyOptions(ctx),
      );
      await reply(
        ctx,
        `当前 Codex thread 可恢复。\n使用 \`/resume use ${nonce}\` 恢复（10 分钟内有效）。`,
      );
      return;
    }
    const card = resumeCard(cwd, [], { showNewCodexAction: true });
    await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
    return;
  }

  const sessions = await listClaudeResumeHistory(ctx, cwd, limit);
  const currentSession = ctx.sessions.getRaw(ctx.scope);
  const identity = ctx.sessionCatalogIdentity;
  const entries = sessions.map((s) => ({
    sessionId: identity
      ? issueResumeCandidate(identity, { sessionId: s.sessionId })
      : s.sessionId,
    displayId: s.sessionId,
    preview: s.preview,
    relTime: formatRelTime(s.mtime),
    lineCount: s.lineCount,
    current: s.sessionId === currentSession?.sessionId,
  }));
  const card = resumeCard(cwd, entries);
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

async function applyResume(sessionId: string, ctx: CommandContext): Promise<void> {
  if (ctx.sessionCatalog && ctx.sessionCatalogIdentity) {
    const entry = ctx.sessionCatalog.activeFor(ctx.sessionCatalogIdentity);
    const resolved = consumeResumeCandidate(sessionId, ctx.sessionCatalogIdentity, 'resume');
    if (resolved) {
      if (ctx.sessionCatalogIdentity.agentId === 'codex') {
        const threadId = resolved.threadId!;
        if (!await resumeCodexThreadOrOfferTakeover(ctx, ctx.sessionCatalogIdentity, threadId)) return;
        await activateCodexResume(ctx, ctx.sessionCatalogIdentity, threadId);
        return;
      } else {
        ctx.activeRuns.interrupt(ctx.scope);
        ctx.sessionCatalog.upsertActive({
          scopeId: ctx.sessionCatalogIdentity.scopeId,
          agentId: 'claude',
          cwdRealpath: ctx.sessionCatalogIdentity.cwdRealpath,
          policyFingerprint: ctx.sessionCatalogIdentity.policyFingerprint,
          sessionId: resolved.sessionId!,
        });
        ctx.sessions.set(ctx.scope, resolved.sessionId!, ctx.sessionCatalogIdentity.cwdRealpath);
      }
      await reply(ctx, RESUME_APPLIED_REPLY);
      return;
    }
    if (ctx.sessionCatalogIdentity.agentId === 'codex') {
      await reply(ctx, '当前上下文不可恢复这个会话，请先用 `/resume` 重新生成恢复候选。');
      return;
    }
    const expected = entry?.sessionId;
    if (expected !== sessionId) {
      await reply(ctx, '当前上下文不可恢复这个会话，请重新选择当前工作区和权限策略下的会话。');
      return;
    }
    ctx.activeRuns.interrupt(ctx.scope);
    if (ctx.sessionCatalogIdentity.agentId === 'claude') {
      ctx.sessions.set(ctx.scope, sessionId, ctx.sessionCatalogIdentity.cwdRealpath);
    }
    await reply(ctx, RESUME_APPLIED_REPLY);
    return;
  }

  if (ctx.controls.profileConfig.agentKind === 'codex') {
    await reply(ctx, '当前上下文没有可恢复的 Codex thread，请先在当前工作区完成一次运行。');
    return;
  }

  const cwd = selectedResumeCwd(ctx);
  if (!cwd) {
    await reply(ctx, '请先使用 /cd <path> 选择工作目录，再查看或恢复会话。');
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.sessions.set(ctx.scope, sessionId, cwd);
  await reply(ctx, RESUME_APPLIED_REPLY);
}

async function applyResumeTakeover(nonce: string, ctx: CommandContext): Promise<void> {
  if (!canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    await reply(ctx, '❌ 此命令仅管理员可用。');
    return;
  }
  const identity = ctx.sessionCatalogIdentity;
  if (!identity || identity.agentId !== 'codex') {
    await reply(ctx, '当前上下文不可接管这个 Codex 会话，请重新使用 `/resume`。');
    return;
  }
  const candidate = consumeResumeCandidate(nonce, identity, 'takeover');
  if (!candidate?.threadId) {
    await reply(ctx, '接管确认已过期或不属于当前上下文，请重新使用 `/resume`。');
    return;
  }
  if (!ctx.agent.takeoverThreadWriter) {
    await reply(ctx, '当前 Codex adapter 不支持终止占用进程。');
    return;
  }

  try {
    await ctx.agent.takeoverThreadWriter(candidate.threadId);
    await resumeCodexThread(ctx, candidate.threadId, identity.cwdRealpath);
  } catch (err) {
    const message = errorMessage(err);
    await reply(
      ctx,
      isActiveWriterError(err)
        ? '接管后该 Codex thread 仍被占用，请重新使用 `/resume` 后再试。'
        : `接管 Codex thread 失败：${message}`,
    );
    return;
  }
  await activateCodexResume(ctx, identity, candidate.threadId, '已终止占用进程并完成接管，请继续发送下一条消息。');
}

async function resumeCodexThreadOrOfferTakeover(
  ctx: CommandContext,
  identity: SessionCatalogIdentity,
  threadId: string,
): Promise<boolean> {
  try {
    await resumeCodexThread(ctx, threadId, identity.cwdRealpath);
    return true;
  } catch (err) {
    if (!isActiveWriterError(err)) {
      await reply(ctx, `恢复 Codex thread 失败：${errorMessage(err)}`);
      return false;
    }
    const nonce = issueResumeCandidate(identity, { threadId }, 'takeover');
    await ctx.channel.send(
      ctx.msg.chatId,
      { card: resumeTakeoverCard(threadId, nonce) },
      commandReplyOptions(ctx),
    );
    return false;
  }
}

async function resumeCodexThread(
  ctx: CommandContext,
  threadId: string,
  cwd: string,
): Promise<void> {
  await codexRpc(ctx, 'thread/resume', await codexResumeParams(ctx, threadId, cwd));
}

async function codexResumeParams(
  ctx: CommandContext,
  threadId: string,
  cwd: string,
): Promise<Record<string, unknown>> {
  return {
    threadId,
    ...(await codexThreadParams(ctx, cwd)),
  };
}

async function codexThreadParams(
  ctx: CommandContext,
  cwd: string,
): Promise<Record<string, unknown>> {
  const codex = ctx.controls.profileConfig.codex;
  const profile = ctx.workspaces.codexProfileFor(ctx.scope, codex?.profile);
  const model = ctx.workspaces.codexModelFor(
    ctx.scope,
    resolveModelArg('codex', ctx.controls.profileConfig.preferences.model),
  );
  const personality = ctx.workspaces.codexPersonalityFor(ctx.scope);
  const config = profile && codex
    ? await loadCodexProfileConfig({
        cwd,
        profile,
        profileStateDir: commandProfilePaths(ctx).profileDir,
        ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
        ...(codex.inheritCodexHome !== undefined
          ? { inheritCodexHome: codex.inheritCodexHome }
          : {}),
      })
    : undefined;
  return {
    cwd,
    approvalPolicy: 'never',
    sandbox: effectiveCodexSandbox(ctx),
    ...(model ? { model } : {}),
    ...(personality ? { personality } : {}),
    ...(config ? { config } : {}),
  };
}

async function activateCodexResume(
  ctx: CommandContext,
  identity: SessionCatalogIdentity,
  threadId: string,
  successMessage = RESUME_APPLIED_REPLY,
): Promise<void> {
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.sessionCatalog?.upsertActive({ ...identity, threadId });
  ctx.workspaces.confirmCodexResume(ctx.scope);
  bindCodexThread(ctx, threadId, identity.cwdRealpath);
  await reply(ctx, successMessage);
  const historyNonce = issueResumeCandidate(identity, { threadId }, 'history');
  await ctx.channel.send(
    ctx.msg.chatId,
    { card: resumeHistoryChoiceCard(historyNonce) },
    commandReplyOptions(ctx),
  );
}

async function applyResumeHistoryChoice(
  nonce: string,
  sendHistory: boolean,
  ctx: CommandContext,
): Promise<void> {
  const identity = ctx.sessionCatalogIdentity;
  if (!identity || identity.agentId !== 'codex') {
    await reply(ctx, '当前上下文没有可发送的 Codex 历史记录。');
    return;
  }
  const candidate = consumeResumeCandidate(nonce, identity, 'history');
  if (!candidate?.threadId) {
    await reply(ctx, '历史上下文选择已过期，请重新使用 `/resume`。');
    return;
  }
  if (!sendHistory) {
    await reply(ctx, '已跳过历史上下文。');
    return;
  }
  await sendCodexResumeHistory(ctx, candidate.threadId, identity.cwdRealpath);
}

function isActiveWriterError(err: unknown): boolean {
  return /already has an active writer/i.test(errorMessage(err));
}

async function sendCodexResumeHistory(
  ctx: CommandContext,
  threadId: string,
  cwd: string,
): Promise<void> {
  if (!ctx.agent.appServerRequest) {
    await reply(ctx, '会话已恢复，但当前 Codex 适配器无法读取历史记录。');
    return;
  }
  const profile = ctx.workspaces.codexProfileFor(
    ctx.scope,
    ctx.controls.profileConfig.codex?.profile,
  );
  try {
    const result = await ctx.agent.appServerRequest(
      profile,
      'thread/read',
      { threadId, includeTurns: true },
    );
    const cards = renderCodexHistoryCards(result, cwd);
    if (cards.length === 0) {
      await reply(ctx, '当前会话没有可显示的历史上下文。');
      return;
    }
    for (const card of cards) {
      await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
    }
  } catch (err) {
    log.warn('session', 'codex-history-read-failed', {
      scope: ctx.scope,
      threadId,
      message: err instanceof Error ? err.message : String(err),
    });
    await reply(ctx, '会话已恢复，但读取历史记录失败；你仍可继续发送消息。');
  }
}

function issueResumeCandidate(
  identity: SessionCatalogIdentity,
  target: { sessionId: string } | { threadId: string },
  kind: ResumeCandidate['kind'] = 'resume',
): string {
  pruneResumeCandidates();
  let nonce = randomUUID().slice(0, 12);
  while (resumeCandidates.has(nonce)) nonce = randomUUID().slice(0, 12);
  resumeCandidates.set(nonce, {
    scopeId: identity.scopeId,
    agentId: identity.agentId,
    cwdRealpath: identity.cwdRealpath,
    policyFingerprint: identity.policyFingerprint,
    ...target,
    kind,
    expiresAt: Date.now() + RESUME_CANDIDATE_TTL_MS,
  });
  return nonce;
}

function consumeResumeCandidate(
  nonce: string,
  identity: SessionCatalogIdentity,
  kind: ResumeCandidate['kind'] = 'resume',
): ResumeCandidate | undefined {
  pruneResumeCandidates();
  const candidate = resumeCandidates.get(nonce);
  if (!candidate) return undefined;
  resumeCandidates.delete(nonce);
  if (
    candidate.scopeId !== identity.scopeId ||
    candidate.agentId !== identity.agentId ||
    candidate.cwdRealpath !== identity.cwdRealpath ||
    candidate.policyFingerprint !== identity.policyFingerprint ||
    candidate.kind !== kind ||
    (identity.agentId === 'claude' && !candidate.sessionId) ||
    (identity.agentId === 'codex' && !candidate.threadId)
  ) {
    return undefined;
  }
  return candidate;
}

function pruneResumeCandidates(now = Date.now()): void {
  for (const [nonce, candidate] of resumeCandidates.entries()) {
    if (candidate.expiresAt <= now) resumeCandidates.delete(nonce);
  }
}

async function listClaudeResumeHistory(
  ctx: CommandContext,
  cwd: string,
  limit: number,
): Promise<SessionSummary[]> {
  const provider = ctx.claudeHistoryProvider ?? listRecentSessions;
  return provider(cwd, limit);
}

async function listCodexResumeHistory(
  ctx: CommandContext,
  cwd: string,
  limit: number,
): Promise<CodexThreadHistoryEntry[]> {
  const codex = ctx.controls.profileConfig.codex;
  const binary = codex?.binaryPath;
  if (!binary) return [];

  const provider = ctx.codexHistoryProvider ?? listCodexThreadHistory;
  try {
    const profile = ctx.workspaces.codexProfileFor(ctx.scope, codex.profile);
    const profileConfig = profile
      ? await loadCodexProfileConfig({
          cwd,
          profile,
          profileStateDir: commandProfilePaths(ctx).profileDir,
          ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
          ...(codex.inheritCodexHome !== undefined
            ? { inheritCodexHome: codex.inheritCodexHome }
            : {}),
        })
      : undefined;
    const modelProvider = stringValue(profileConfig?.model_provider);
    return await provider({
      binary,
      cwd,
      limit,
      profileStateDir: commandProfilePaths(ctx).profileDir,
      ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
      ...(codex.inheritCodexHome !== undefined
        ? { inheritCodexHome: codex.inheritCodexHome }
        : {}),
      ...(profile ? { profile } : {}),
      ...(modelProvider ? { modelProviders: [modelProvider] } : {}),
    });
  } catch (err) {
    log.warn('session', 'codex-history-failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

function effectiveWorkspaceCwd(ctx: CommandContext): string | undefined {
  return ctx.workspaces.pendingCodexCwdFor(ctx.scope)
    ?? ctx.workspaces.cwdFor(ctx.scope)
    ?? ctx.controls.profileConfig.workspaces.default;
}

function selectedResumeCwd(ctx: CommandContext): string | undefined {
  return effectiveWorkspaceCwd(ctx);
}

function runtimeAccessStatus(
  profileConfig: ProfileConfig,
  codexSandbox?: CodexSandboxMode,
): { label: string; value: string } {
  if (profileConfig.agentKind === 'claude') {
    return {
      label: '权限',
      value: accessToClaudePermissionMode(
        profileConfig.permissions.defaultAccess,
        profileConfig.permissions,
      ),
    };
  }
  return {
    label: '权限',
    value: `${codexSandbox ?? profileConfig.sandbox.defaultMode}（上限 ${accessToCodexSandbox(profileConfig.permissions.maxAccess)}）`,
  };
}

function effectiveCodexSandbox(ctx: CommandContext): CodexSandboxMode {
  const stored = ctx.workspaces.codexSandboxFor(ctx.scope);
  const access = clampAccess(
    stored
      ? codexSandboxToAccess(stored)
      : ctx.controls.profileConfig.permissions.defaultAccess,
    ctx.controls.profileConfig.permissions.maxAccess,
    codexCapability(ctx.controls.profileConfig).permissions.maxAccess,
  );
  return accessToCodexSandbox(access);
}

async function larkCliStatus(ctx: CommandContext): Promise<'app' | 'user-ready' | 'user-missing' | 'check-failed'> {
  const appPaths = commandProfilePaths(ctx);
  try {
    const raw = JSON.parse(await readFile(appPaths.larkCliTargetConfigFile, 'utf8')) as {
      apps?: Array<{
        appId?: string;
        brand?: string;
        defaultAs?: string;
        strictMode?: string;
        users?: unknown;
      }>;
    };
    const app = raw.apps?.find(
      (candidate) =>
        candidate.appId === ctx.controls.profileConfig.accounts.app.id &&
        candidate.brand === ctx.controls.profileConfig.accounts.app.tenant,
    );
    if (app?.defaultAs === 'auto' && app.strictMode === 'off' && hasStructuredLarkCliUserAuth(app.users)) {
      return 'user-ready';
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 'check-failed';
  }
  if (
    ctx.controls.profileConfig.larkCli.identityPreset === 'user-default' &&
    canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
  ) {
    return 'user-missing';
  }
  return 'app';
}

async function handleStatus(_args: string, ctx: CommandContext): Promise<void> {
  const cwd = effectiveWorkspaceCwd(ctx);
  const sess = ctx.sessions.getRaw(ctx.scope);
  const isCodex = ctx.controls.profileConfig.agentKind === 'codex';
  const catalogEntry =
    isCodex && ctx.sessionCatalog && ctx.sessionCatalogIdentity
      ? ctx.sessionCatalog.activeFor(ctx.sessionCatalogIdentity)
      : undefined;
  const card = statusCard({
    profileName: ctx.controls.profile,
    cwd,
    sessionId: isCodex ? catalogEntry?.threadId : sess?.sessionId,
    copyableSessionId: isCodex,
    emptySessionText: isCodex ? '(未建立)' : undefined,
    sessionLabel: isCodex ? 'Codex 会话' : '会话',
    sessionStale: !isCodex && Boolean(cwd && sess && sess.cwd !== cwd),
    agentName: ctx.agent.displayName,
    runtimeAccess: runtimeAccessStatus(
      ctx.controls.profileConfig,
      isCodex ? effectiveCodexSandbox(ctx) : undefined,
    ),
    larkCliStatus: await larkCliStatus(ctx),
    activeRun: Boolean(ctx.activeRuns.get(ctx.scope)),
    activeScopes: ctx.activeRuns.scopes().filter((scope) => !scope.startsWith('comment:')),
    activeCommentScopes: ctx.activeRuns.scopes().filter((scope) => scope.startsWith('comment:')),
    queue: ctx.processPool?.snapshot(),
    ownerState: formatOwnerState(ctx),
    scope: ctx.scope,
    chatMode: ctx.chatMode,
    ...(isCodex
      ? {
          codexProfile: ctx.workspaces.codexProfileFor(
            ctx.scope,
            ctx.controls.profileConfig.codex?.profile,
          ) ?? '默认（无 --profile）',
          codexLaunchState: ctx.workspaces.codexLaunchPendingFor(ctx.scope)
            ? '等待选择'
            : ctx.workspaces.selectionFor(ctx.scope)?.launchMode === 'new'
              ? '新建'
              : ctx.workspaces.selectionFor(ctx.scope)?.launchMode === 'resume'
                ? '恢复'
                : '自动',
        }
      : {}),
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

function formatOwnerState(ctx: CommandContext): string {
  const state = ctx.controls.ownerRefreshState;
  const stateLabel = state === 'ok' ? '正常' : state === 'failed' ? '失败' : '未知';
  const owner = ctx.controls.botOwnerId ? '已获取' : '未获取';
  const refreshed = ctx.controls.ownerRefreshedAt
    ? `，刷新时间 ${new Date(ctx.controls.ownerRefreshedAt).toISOString()}`
    : '';
  return `${stateLabel}，管理员 ${owner}${refreshed}`;
}

async function handleStop(args: string, ctx: CommandContext): Promise<void> {
  const targetScope = args.trim();
  const scope = targetScope || ctx.scope;
  const active = ctx.activeRuns.get(scope);
  if (
    ctx.agent.id === 'codex'
    && (
      targetScope === 'terminals'
      || targetScope === 'background'
      || (!targetScope && !active)
    )
  ) {
    ctx.pending?.cancel(scope);
    await handleCodexBackgroundTerminalsStop(ctx);
    return;
  }
  if (targetScope && !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    await reply(ctx, '❌ 指定 scope 停止任务仅管理员可用。');
    return;
  }
  const dropped = ctx.pending?.cancel(scope).length ?? 0;
  const ok = ctx.activeRuns.interrupt(scope);
  log.info('command', 'stop', {
    scope,
    targeted: Boolean(targetScope),
    interrupted: ok,
    droppedPending: dropped,
  });
  if (targetScope) {
    await reply(
      ctx,
      ok
        ? `已请求停止 \`${scope}\`。`
        : `未找到正在运行的任务：\`${scope}\`。`,
    );
  }
  // No reply for the current IM scope: if there was a run, its in-flight
  // render loop will mark the card as interrupted and re-render.
}

async function handleInterrupt(args: string, ctx: CommandContext): Promise<void> {
  if (args.trim()) {
    await reply(ctx, '用法：`/interupt`（`/interrupt` 同义）');
    return;
  }
  const queued = ctx.pending?.size(ctx.scope) ?? 0;
  const interrupted = ctx.activeRuns.interrupt(ctx.scope);
  if (interrupted) {
    await reply(
      ctx,
      queued > 0
        ? `已打断当前 turn，${queued} 条排队消息会直接进入下一轮上下文。`
        : '已打断当前 turn。',
    );
    log.info('command', 'interrupt', { scope: ctx.scope, interrupted: true, queued });
    return;
  }
  if (queued > 0) {
    const flushed = ctx.pending?.flushNow(ctx.scope) ?? 0;
    await reply(ctx, flushed > 0 ? `已立即执行 ${flushed} 条排队消息。` : '排队消息正在等待当前任务结束。');
    log.info('command', 'interrupt', { scope: ctx.scope, interrupted: false, queued, flushed });
    return;
  }
  await reply(ctx, '当前没有正在执行的任务或排队消息。');
  log.info('command', 'interrupt', { scope: ctx.scope, interrupted: false, queued: 0 });
}

async function handleQueue(args: string, ctx: CommandContext): Promise<void> {
  const content = args.trim();
  if (!content) {
    await reply(ctx, '用法：`/queue <下一条指令>`');
    return;
  }
  if (!ctx.pending) {
    await reply(ctx, '当前 queue 不可用，请直接发送消息。');
    return;
  }
  const size = ctx.pending.push(ctx.scope, { ...ctx.msg, content });
  await reply(ctx, `⇥ 已排队（当前等待 ${size} 条），会在当前 turn 完成后执行。`);
}

async function handleTimeout(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim().toLowerCase();
  const parsed = parseTimeoutTarget(trimmed, ctx.scope);
  if (
    parsed.targeted &&
    !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
  ) {
    await reply(ctx, '❌ 指定 scope 设置 timeout 仅管理员可用。');
    return;
  }
  const scope = parsed.scope;
  const value = parsed.value;
  const globalMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const globalMinutes = globalMs ? Math.round(globalMs / 60_000) : 0;
  const formatGlobal = (): string =>
    globalMinutes > 0 ? `${globalMinutes} 分钟` : '未启用';

  // /timeout — show effective value + source
  if (!value) {
    const scopeMinutes = ctx.sessions.getIdleTimeoutMinutes(scope);
    const usage =
      '\n\n用法:\n- `/timeout 15` 当前 session 设 15 分钟\n- `/timeout off` 当前 session 关闭探活\n- `/timeout default` 清除 session 覆盖,回退全局\n- `/timeout comment:<scopeHash> 15` 管理员设置 comment scope\n\n_注:`/new` 会清掉当前 session 的覆盖,回到全局_';
    const scopeLabel = parsed.targeted ? ` (${scope})` : '';
    if (scopeMinutes !== undefined) {
      const effective =
        scopeMinutes > 0 ? `${scopeMinutes} 分钟` : '已关闭（当前 session）';
      await reply(ctx, `⏱ 当前 session${scopeLabel} 探活:${effective}\n全局默认:${formatGlobal()}${usage}`);
      return;
    }
    await reply(ctx, `⏱ 当前 session${scopeLabel} 探活:跟随全局(${formatGlobal()})${usage}`);
    return;
  }

  if (value === 'default') {
    const cleared = ctx.sessions.clearIdleTimeoutOverride(scope);
    log.info('command', 'timeout-clear', { scope, cleared, targeted: parsed.targeted });
    await reply(
      ctx,
      cleared
        ? `✅ 已清除 session 覆盖,回退到全局(${formatGlobal()})。`
        : `当前 session 本来就没设过覆盖,跟随全局(${formatGlobal()})。`,
    );
    return;
  }

  if (value === 'off' || value === '0') {
    ctx.sessions.setIdleTimeoutMinutes(scope, 0);
    log.info('command', 'timeout-off', { scope, targeted: parsed.targeted });
    await reply(ctx, '✅ 已关闭当前 session 的探活。');
    return;
  }

  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1 || n > 120) {
    await reply(ctx, '❌ 用法:`/timeout <1-120>` / `/timeout off` / `/timeout default`');
    return;
  }
  ctx.sessions.setIdleTimeoutMinutes(scope, n);
  log.info('command', 'timeout-set', { scope, minutes: n, targeted: parsed.targeted });
  await reply(ctx, `✅ 当前 session 探活已设为 ${n} 分钟。`);
}

function parseTimeoutTarget(input: string, currentScope: string): {
  scope: string;
  value: string;
  targeted: boolean;
} {
  const parts = input.split(/\s+/).filter(Boolean);
  const first = parts[0] ?? '';
  if (first.startsWith('comment:')) {
    return {
      scope: first,
      value: parts.slice(1).join(' '),
      targeted: true,
    };
  }
  return {
    scope: currentScope,
    value: input,
    targeted: false,
  };
}

async function handlePs(args: string, ctx: CommandContext): Promise<void> {
  const target = args.trim().toLowerCase();
  if (ctx.agent.id === 'codex' && target !== 'bridge' && target !== 'bots') {
    if (target && target !== 'codex' && target !== 'terminals') {
      await reply(ctx, '用法：`/ps [codex|bridge]`');
      return;
    }
    await handleCodexBackgroundTerminalsList(ctx);
    return;
  }
  const live = readAndPrune();
  log.info('command', 'ps', { count: live.length });
  if (live.length === 0) {
    await reply(ctx, '当前没有 bot 在运行(理论上不可能,你正在跟其中之一对话…)');
    return;
  }

  const rows: string[] = [
    '| # | ID | Bot | 启动 |',
    '|---|---|---|---|',
  ];
  for (const [idx, e] of live.entries()) {
    const ago = formatAgo(Date.now() - new Date(e.startedAt).getTime());
    const me = e.id === ctx.controls.processId ? ' ← 当前正在回复' : '';
    const bot = e.botName ? `${e.botName} (\`${e.appId}\`)` : `\`${e.appId}\``;
    rows.push(`| ${idx + 1} | \`${e.id}\`${me} | ${bot} | ${ago} |`);
  }
  const body = [
    `🧭 **当前有 ${live.length} 个 bot 在运行**`,
    '',
    rows.join('\n'),
    '',
    '用 `/exit <id|#>` 关掉某一个;`/exit ' + ctx.controls.processId + '` 关掉正在回复你的这个 bot。',
  ].join('\n');
  await reply(ctx, body);
}

async function handleCodexBackgroundTerminalsList(ctx: CommandContext): Promise<void> {
  const threadId = await requireCodexThread(ctx);
  if (!threadId) return;
  const result = await codexRpc(ctx, 'thread/backgroundTerminals/list', {
    threadId,
    limit: 100,
  });
  const terminals = resultData(result)
    .map(recordValue)
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  if (!terminals.length) {
    await reply(ctx, '当前 Codex thread 没有后台终端。\n\n查看 bridge 进程：`/ps bridge`');
    return;
  }
  const rows = terminals.map((terminal, index) => {
    const processId = String(terminal.processId ?? '?');
    const command = String(terminal.command ?? '(unknown)');
    const cwd = String(terminal.cwd ?? '');
    return `${index + 1}. \`${processId}\` · \`${command.replace(/`/g, "'")}\`${cwd ? `\n   ⌞ \`${cwd.replace(/`/g, "'")}\`` : ''}`;
  });
  await reply(
    ctx,
    `**Codex 后台终端（${terminals.length}）**\n\n${rows.join('\n')}\n\n停止全部：\`/stop terminals\` 或 \`/clean\`；查看 bridge 进程：\`/ps bridge\`。`,
  );
}

async function handleExit(args: string, ctx: CommandContext): Promise<void> {
  const target = args.trim();
  const psCommand = ctx.agent.id === 'codex' ? '/ps bridge' : '/ps';
  if (!target) {
    await reply(
      ctx,
      `用法：\`/exit <id|#>\` —— \`id\` 是 \`${psCommand}\` 显示的短 id，\`#\` 是序号。\n` +
        `当前正在回复你的是 \`${ctx.controls.processId}\`。`,
    );
    return;
  }
  const entry = resolveTarget(target);
  if (!entry) {
    await reply(ctx, `❌ 没找到匹配的 bot：\`${target}\`。发 \`${psCommand}\` 看可选目标。`);
    return;
  }

  // Targeting ourselves — graceful disconnect + process.exit(0) via controls.
  if (entry.id === ctx.controls.processId) {
    log.info('command', 'exit-self', { id: entry.id });
    await reply(ctx, `👋 即将关闭当前 bot \`${entry.id}\`,再见。`);
    // Detach to give the reply send a chance to complete before we tear
    // down. controls.exit() awaits disconnect then process.exit().
    void (async () => {
      await new Promise((r) => setTimeout(r, 300));
      await ctx.controls.exit().catch(() => {});
    })();
    return;
  }

  // Targeting another process — SIGTERM and report back. We can't easily
  // wait for it to die without blocking the command handler; trust the
  // target's own signal handler to unregister + exit.
  log.info('command', 'exit-other', { id: entry.id, pid: entry.pid });
  try {
    process.kill(entry.pid, 'SIGTERM');
  } catch (err) {
    await reply(ctx, `❌ 关掉 bot \`${entry.id}\` 失败:${(err as Error).message}`);
    return;
  }
  // Brief grace before reporting.
  await new Promise((r) => setTimeout(r, 500));
  const stillAlive = isAlive(entry.pid);
  if (stillAlive) {
    await reply(
      ctx,
      `📨 已请求关闭 \`${entry.id}\`,但还在收尾。再发 \`/ps\` 复查一下。`,
    );
  } else {
    await reply(ctx, `✓ 已关闭 bot \`${entry.id}\`。`);
  }
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s 前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m 前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h 前`;
  return `${Math.floor(ms / 86_400_000)}d 前`;
}

async function handleReconnect(args: string, ctx: CommandContext): Promise<void> {
  const wait = args.trim().split(/\s+/).filter(Boolean).includes('--wait');
  log.info('command', 'reconnect', { wait });
  await reply(ctx, wait ? '⏳ 将在当前运行结束后重连…' : '⏳ 正在停止当前运行并重连…');
  let resumeNewRuns: (() => void) | undefined;
  try {
    resumeNewRuns = ctx.activeRuns.pauseNewRuns('reconnect-in-progress');
    if (wait) {
      await ctx.activeRuns.waitForAll();
    } else {
      await ctx.activeRuns.stopAll();
    }
    await ctx.controls.restart({ wait });
    log.info('command', 'reconnect-ok');
  } catch (err) {
    log.fail('command', err, { step: 'reconnect' });
    reportMetric('command_fail', 1, { step: 'reconnect' });
    await reply(ctx, `❌ 重连失败:${err instanceof Error ? err.message : String(err)}`);
  } finally {
    resumeNewRuns?.();
  }
}

const DOCTOR_ECHO_PROMPT =
  'Bridge doctor agent echo check. Do not inspect files, do not use history, and reply exactly: OK';
const DOCTOR_RATE_LIMIT_MS = 30_000;
const doctorInFlightProfiles = new Set<string>();
const doctorLastByOperator = new Map<string, number>();

async function handleDoctor(args: string, ctx: CommandContext): Promise<void> {
  log.info('command', 'doctor', {
    hasDescription: args.trim().length > 0,
    chatMode: ctx.chatMode,
  });

  const rateKey = `${ctx.controls.profile}:${ctx.controls.configPath}:${ctx.msg.senderId}`;
  const now = Date.now();
  const last = doctorLastByOperator.get(rateKey);
  if (last !== undefined && now - last < DOCTOR_RATE_LIMIT_MS) {
    await reply(ctx, 'doctor rate limited: 同一用户 30 秒内只能触发一次。');
    return;
  }

  const requestedCwd = effectiveWorkspaceCwd(ctx);
  if (!requestedCwd) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck:
          '未设置工作目录。先用 `/cd <path>` 或 `/ws use <name>` 选择工作目录后再运行 agent echo check。',
        echoCheck: 'skipped',
      }),
    );
    return;
  }

  const workspace = await resolveWorkingDirectory(requestedCwd);
  if (!workspace.ok) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: `${workspace.userVisible} 工作目录不可用时只执行 self-check，不启动 agent。`,
        echoCheck: 'skipped',
      }),
    );
    return;
  }

  if (!ctx.runExecutor) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: `ok (${workspace.cwdRealpath})`,
        echoCheck: 'run executor unavailable',
      }),
    );
    return;
  }

  const profileKey = ctx.controls.profile;
  if (doctorInFlightProfiles.has(profileKey)) {
    await reply(ctx, 'doctor in-flight: 当前 profile 已有诊断运行中。');
    return;
  }
  doctorLastByOperator.set(rateKey, now);

  const capability =
    ctx.controls.profileConfig.agentKind === 'codex'
      ? codexCapability(ctx.controls.profileConfig)
      : claudeCapability(ctx.controls.profileConfig);
  const policy = evaluateRunPolicy({
    scope: {
      source: 'im',
      chatId: ctx.msg.chatId,
      actorId: ctx.msg.senderId,
      ...(ctx.msg.threadId ? { threadId: ctx.msg.threadId } : {}),
    },
    attachments: [],
    prompt: DOCTOR_ECHO_PROMPT,
    requestedCwd,
    cwdRealpath: workspace.cwdRealpath,
    access: canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId),
    capability,
    profileConfig: ctx.controls.profileConfig,
    now,
    ttlMs: 60_000,
  });
  if (!policy.ok) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: `ok (${workspace.cwdRealpath})`,
        echoCheck: policy.rejectReason.userVisible,
      }),
    );
    return;
  }
  const runtimeAccess = runtimeAccessStatus(ctx.controls.profileConfig);
  const doctorReport = (echoCheck: string): string =>
    buildDoctorReport(ctx, {
      workspaceCheck: `ok (${workspace.cwdRealpath})`,
      policyCheck:
        runtimeAccess.label === 'sandbox'
          ? `ok sandbox=${policy.sandbox}`
          : `ok ${runtimeAccess.label}=${policy.permissionMode}`,
      echoCheck,
    });

  // In group / topic chats other members would see the result card. Ack
  // in-channel, deliver the actual analysis privately to the operator's
  // open_id (Lark auto-opens the p2p chat with the bot).
  const isP2p = ctx.chatMode === 'p2p';
  if (!isP2p) {
    await reply(ctx, '🔍 已收到诊断请求，分析结果将私信发给你。');
  }

  doctorInFlightProfiles.add(profileKey);
  let execution: Awaited<ReturnType<RunExecutor['submit']>>;
  try {
    execution = await ctx.runExecutor.submit({
      scopeId: `${ctx.scope}:doctor`,
      policy,
      nowait: true,
      stopGraceMs: getAgentStopGraceMs(ctx.controls.cfg),
      observability: {
        profile: ctx.controls.profile,
        agent: capability.agentId,
        source: 'doctor',
        stage: 'agent-probe',
      },
    });
  } catch (err) {
    doctorInFlightProfiles.delete(profileKey);
    if (err instanceof RunRejected && err.code === 'pool-full') {
      await reply(ctx, doctorReport('pool-full'));
      return;
    }
    log.fail('command', err, { step: 'doctor.submit' });
    reportMetric('command_fail', 1, { step: 'doctor.submit' });
    await reply(ctx, doctorReport('failed'));
    return;
  }

  try {
    if (isP2p) {
      // Streaming card path — operator is the only viewer in p2p.
      await ctx.channel.stream(
        ctx.msg.chatId,
        {
          card: {
            initial: renderCard(withDoctorReport(initialState, doctorReport('pending'))),
            producer: async (ctrl) => {
              let state: RunState = initialState;
              let echoText = '';
              const echoStatus = (): string => formatDoctorEchoStatus(echoText, state);
              const flush = (): Promise<void> =>
                ctrl.update(renderCard(withDoctorReport(state, doctorReport(echoStatus()))));
              for await (const evt of execution.subscribe()) {
                if (execution.handle.interrupted) break;
                // /doctor runs are session-less: skip 'system' so we don't
                // persist a doctor's sessionId over the user's real session.
                if (evt.type === 'system') continue;
                if (evt.type === 'usage') {
                  continue;
                }
                if (evt.type === 'text') echoText += evt.delta;
                if (evt.type === 'final_text') echoText = evt.content;
                state = reduce(state, evt);
                await flush();
                // Don't wait for stdout to close — some claude versions hang
                // briefly post-result, which would leave the for-await stuck.
                if (state.terminal !== 'running') break;
              }
              state = execution.handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
              await flush();
            },
          },
        },
        { replyTo: ctx.msg.messageId },
      );
    } else {
      // Group / topic: buffer to completion, then DM the final card to the
      // operator. No live streaming — the group should see nothing past the
      // ack reply above.
      let state: RunState = initialState;
      let echoText = '';
      for await (const evt of execution.subscribe()) {
        if (execution.handle.interrupted) break;
        if (evt.type === 'system') continue;
        if (evt.type === 'usage') {
          continue;
        }
        if (evt.type === 'text') echoText += evt.delta;
        if (evt.type === 'final_text') echoText = evt.content;
        state = reduce(state, evt);
        if (state.terminal !== 'running') break;
      }
      state = execution.handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
      // Send a one-shot interactive card by open_id. Lark routes it to the
      // user's p2p chat with the bot (auto-creates it if needed); other
      // group members never see this payload.
      await ctx.channel.send(ctx.msg.senderId, {
        card: renderCard(
          withDoctorReport(state, doctorReport(formatDoctorEchoStatus(echoText, state))),
        ),
      });
    }
  } catch (err) {
    log.fail('command', err, { step: 'doctor' });
    reportMetric('command_fail', 1, { step: 'doctor' });
  } finally {
    doctorInFlightProfiles.delete(profileKey);
  }
}

function buildDoctorReport(
  ctx: CommandContext,
  opts: {
    workspaceCheck?: string;
    policyCheck?: string;
    echoCheck?: string;
  } = {},
): string {
  const queue = ctx.processPool?.snapshot();
  const queueLine = queue
    ? `${queue.active}/${queue.cap} active, ${queue.waiting} waiting`
    : 'unknown';
  const cwd = effectiveWorkspaceCwd(ctx);
  const runtimeAccess = runtimeAccessStatus(ctx.controls.profileConfig);
  const access =
    ctx.msg.chatType === 'p2p'
      ? canUseDm(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId)
      : canUseGroup(
          ctx.controls.profileConfig,
          ctx.controls,
          ctx.msg.chatId,
          ctx.msg.senderId,
        );
  return [
    'self-check: ok',
    `profile: ${ctx.controls.profile}`,
    `agent: ${ctx.agent.displayName} (${ctx.controls.profileConfig.agentKind})`,
    `workspace: ${cwd ?? '(未设置)'}`,
    `workspace default: ${ctx.controls.profileConfig.workspaces.default ? 'set' : 'missing'}`,
    `${runtimeAccess.label}: ${runtimeAccess.value}`,
    `access: ${access.ok ? 'ok' : 'denied'} (${access.reason})`,
    `owner API: ${formatOwnerState(ctx)}`,
    `queue: ${queueLine}`,
    `run executor: ${ctx.runExecutor ? 'available' : 'unavailable'}`,
    ...(opts.workspaceCheck ? [`workspace check: ${opts.workspaceCheck}`] : []),
    ...(opts.policyCheck ? [`policy check: ${opts.policyCheck}`] : []),
    ...(opts.echoCheck ? [`agent echo check: ${opts.echoCheck}`] : []),
  ].join('\n');
}

function withDoctorReport(state: RunState, report: string): RunState {
  return {
    ...state,
    blocks: [{ kind: 'text', content: report, streaming: false }, ...state.blocks],
  };
}

function formatDoctorEchoStatus(echoText: string, state: RunState): string {
  const trimmed = echoText.trim();
  if (trimmed) return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
  if (state.terminal === 'running') return 'pending';
  if (state.terminal === 'done') return 'empty';
  return state.terminal;
}

async function handleHelp(_args: string, ctx: CommandContext): Promise<void> {
  const card = helpCard(ctx.agent.displayName, ctx.channel.botIdentity?.name);
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

// ─── /account ─────────────────────────────────────────────────────────────

async function handleAccount(args: string, ctx: CommandContext): Promise<void> {
  const sub = args.trim().split(/\s+/)[0] ?? '';
  switch (sub) {
    case '':
      return showCurrent(ctx);
    case 'change':
      return showForm(ctx);
    case 'submit':
      return submitAccount(ctx);
    case 'cancel':
      return cancelAccount(ctx);
    default:
      await reply(ctx, '用法：`/account` 或 `/account change`');
  }
}

async function showCurrent(ctx: CommandContext): Promise<void> {
  // Current-status card has only a [更换凭据] button — never updated in-place,
  // so an inline card is sufficient (and avoids creating a managed card we'd
  // never re-touch).
  const card = accountCurrentCard({
    appId: ctx.controls.cfg.accounts.app.id,
    botName: ctx.channel.botIdentity?.name,
    tenant: ctx.controls.cfg.accounts.app.tenant,
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

async function showForm(ctx: CommandContext): Promise<void> {
  const card = accountFormCard({ initialTenant: ctx.controls.cfg.accounts.app.tenant });
  if (ctx.fromCardAction) {
    await recallMessage(ctx, ctx.msg.messageId);
  }
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card, commandReplyOptions(ctx));
}

async function cancelAccount(ctx: CommandContext): Promise<void> {
  // Cancel = remove the form card. No follow-up message.
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
}

// Lark's client holds a local "form just submitted" state for a short
// window after the click that overrides any cardkit.card.update we issue.
// We always wait at least this long before flipping the form card to its
// terminal (success/failure) state. Empirically ~1s is enough; less than
// that and the update gets reverted to the form's pre-submit state.
const FORM_SETTLE_MS = 1000;

async function submitAccount(ctx: CommandContext): Promise<void> {
  const fv = ctx.formValue ?? {};
  const appId = String(fv.app_id ?? '').trim();
  const appSecret = String(fv.app_secret ?? '').trim();
  const tenant = (fv.tenant === 'lark' ? 'lark' : 'feishu') as TenantBrand;

  const formMsgId = ctx.msg.messageId;
  const channel = ctx.channel;
  const restart = ctx.controls.restart;
  const retryReplyOptions = commandReplyOptions(ctx);

  // CRITICAL: detach the work from the cardAction handler. Lark's client
  // keeps the form locked while the handler is pending — if we await the
  // 2s settle window inline, the lock holds, and the moment we return the
  // client snaps the card back to its cached form state (overwriting any
  // update we made). Returning immediately lets the lock release; the
  // delayed updateManagedCard then sticks.
  const chatId = ctx.msg.chatId;
  void (async () => {
    const submittedAt = Date.now();
    const waitForSettle = async (): Promise<void> => {
      const elapsed = Date.now() - submittedAt;
      if (elapsed < FORM_SETTLE_MS) {
        await new Promise<void>((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
      }
    };

    // Success path: in-place update. The card never accepts another submit
    // (success card has no form), so this is fine.
    const finishSuccess = async (card: object): Promise<void> => {
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, card).catch((err) =>
        console.warn('[account] form update failed:', err),
      );
      forgetManagedCard(formMsgId);
    };

    // Failure path: leave the old form card as a static "❌ 校验失败" record
    // (in-place update to a non-form card so it stops responding to clicks),
    // then post a fresh managed form card below for retry. We can't reuse
    // the original card_id for the retry form because Lark's client locks
    // form interactions on it once submitted — even a re-rendered form on
    // the same card_id no longer fires cardActions.
    const finishFailure = async (errorMessage: string): Promise<void> => {
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, accountFailureCard(errorMessage))
        .catch((err) => console.warn('[account] mark old form failed:', err));
      forgetManagedCard(formMsgId);
      // Don't prefill the secret on retry — pre-filled secrets can get
      // echoed back into the card payload and may persist in Lark's
      // server-side card cache. Keep appId prefilled (non-sensitive).
      const retry = accountFormCard({
        initialTenant: tenant,
        prefillAppId: appId,
      });
      await sendManagedCard(channel, chatId, retry, retryReplyOptions).catch((err) =>
        console.warn('[account] post retry form failed:', err),
      );
    };

    if (!appId || !appSecret) {
      await finishFailure('App ID 或 App Secret 为空');
      return;
    }

    const result = await validateAppCredentials(appId, appSecret, tenant);
    if (!result.ok) {
      await finishFailure(result.reason ?? 'unknown');
      return;
    }

    // Encrypted-at-rest path: store the plaintext secret in the AES keystore,
    // and write config.json with an exec-provider SecretRef instead of the
    // raw secret. lark-cli's `config bind --source lark-channel` reads the
    // same SecretRef and goes through the exec protocol to retrieve the
    // plaintext into its own OS keychain — no plaintext on disk.
    try {
      const appPaths = commandProfilePaths(ctx);
      const newCfg = await buildEncryptedAccountConfig(
        appId,
        tenant,
        ctx.controls.cfg.preferences,
        appPaths,
      );
      await saveAccountConfig(ctx, newCfg, appSecret);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await finishFailure(`保存凭据失败：${msg}`);
      return;
    }

    await finishSuccess(accountSuccessCard({ appId, botName: result.botName, tenant }));

    // Give the user 1.5s to read the success state before we tear down the
    // WS and reconnect with new credentials.
    setTimeout(() => {
      void restart().catch((err) => {
        console.error('[account] restart failed:', err);
        process.exit(1);
      });
    }, 1500);
  })();
}

async function recallMessage(ctx: CommandContext, messageId: string): Promise<void> {
  try {
    await ctx.channel.recallMessage(messageId);
  } catch (err) {
    console.warn('[recall failed]', err);
  }
}

// ────────────── /invite and /remove — access lists ──────────────

async function handleInvite(args: string, ctx: CommandContext): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean).map((token) => token.toLowerCase());

  if (tokens.includes('all') && tokens.includes('group')) {
    const list = new Set(ctx.controls.profileConfig.access.allowedChats);
    let knownChats = ctx.controls.knownChats ?? [];
    if (knownChats.length === 0) {
      knownChats = await fetchKnownChats(ctx.channel);
      ctx.controls.knownChats = knownChats;
    }
    let added = 0;
    let total = list.size;
    await saveAccessConfig(ctx, (current) => {
      list.clear();
      for (const chatId of current.allowedChats) list.add(chatId);
      added = 0;
      for (const chat of knownChats) {
        if (!list.has(chat.id)) {
          list.add(chat.id);
          added += 1;
        }
      }
      total = list.size;
      return {
        ...current,
        allowedChats: [...list],
      };
    });
    if (knownChats.length === 0) {
      await reply(ctx, '当前 bot 还不在任何群里，没有可加入的群。');
    } else {
      await reply(ctx, `✅ 已把 bot 所在的 ${added} 个群加入响应群名单（共 ${total} 个）。`);
    }
    return;
  }

  const kind = tokens.find((token) => /^(user|admin|group)$/.test(token)) as
    | 'user'
    | 'admin'
    | 'group'
    | undefined;
  if (!kind) {
    await reply(
      ctx,
      '用法：\n' +
        '• `/invite user @某人` — 加入允许私聊\n' +
        '• `/invite admin @某人` — 加入管理员\n' +
        '• `/invite group` — 把当前群加入响应群名单\n' +
        '• `/invite all group` — 把 bot 所在的所有群一键加入',
    );
    return;
  }

  if (kind === 'group') {
    if (ctx.chatMode === 'p2p') {
      await reply(ctx, '❌ `/invite group` 只能在群里发，在私聊里没有 chat_id 可以加。');
      return;
    }
    const chatId = ctx.msg.chatId;
    let already = false;
    await saveAccessConfig(ctx, (current) => {
      const list = new Set(current.allowedChats);
      already = list.has(chatId);
      if (!already) list.add(chatId);
      return {
        ...current,
        allowedChats: [...list],
      };
    });
    if (already) {
      await reply(ctx, '✅ 当前群已在白名单里，无需重复添加。');
      return;
    }
    await reply(ctx, `✅ 已把当前群（\`${chatId}\`）加入响应群名单。`);
    return;
  }

  const targets = mentionTargets(ctx);
  if (targets.length === 0) {
    await reply(
      ctx,
      `❌ 没检测到 @ 的用户。请像这样发：\`/invite ${kind} @某人\`（注意 @ 用户不是 @ bot）。`,
    );
    return;
  }

  const listKey = kind === 'user' ? 'allowedUsers' : 'admins';
  const added: string[] = [];
  const already: string[] = [];
  await saveAccessConfig(ctx, (current) => {
    const list = new Set(current[listKey]);
    added.length = 0;
    already.length = 0;
    for (const target of targets) {
      if (list.has(target.openId)) {
        already.push(target.name ?? target.openId);
      } else {
        list.add(target.openId);
        added.push(target.name ?? target.openId);
      }
    }
    return {
      ...current,
      [listKey]: [...list],
    };
  });
  const label = kind === 'user' ? '用户白名单' : '管理员';
  const parts: string[] = [];
  if (added.length > 0) parts.push(`✅ 已把 ${added.join('、')} 加入${label}。`);
  if (already.length > 0) parts.push(`_${already.join('、')} 已经在${label}里，跳过。_`);
  await reply(ctx, parts.join('\n'));
}

async function handleRemove(args: string, ctx: CommandContext): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean).map((token) => token.toLowerCase());
  const kind = tokens.find((token) => /^(user|admin|group)$/.test(token)) as
    | 'user'
    | 'admin'
    | 'group'
    | undefined;
  if (!kind) {
    await reply(
      ctx,
      '用法：\n' +
        '• `/remove user @某人` — 移出用户白名单\n' +
        '• `/remove admin @某人` — 移出管理员\n' +
        '• `/remove group` — 把当前群移出响应群名单',
    );
    return;
  }

  if (kind === 'group') {
    if (ctx.chatMode === 'p2p') {
      await reply(ctx, '`/remove group` 请在要移除的群里发，私聊里没有可移除的群。');
      return;
    }
    const chatId = ctx.msg.chatId;
    let missing = false;
    await saveAccessConfig(ctx, (current) => {
      const list = new Set(current.allowedChats);
      missing = !list.has(chatId);
      list.delete(chatId);
      return {
        ...current,
        allowedChats: [...list],
      };
    });
    if (missing) {
      await reply(ctx, '✅ 当前群本来就不在响应名单里，无需移除。');
      return;
    }
    await reply(ctx, '✅ 已把当前群移出响应群名单。');
    return;
  }

  const targets = mentionTargets(ctx);
  if (targets.length === 0) {
    await reply(ctx, `请 @ 上要移除的人，例如：\`/remove ${kind} @某人\`。`);
    return;
  }

  const listKey = kind === 'user' ? 'allowedUsers' : 'admins';
  const removed: string[] = [];
  const notThere: string[] = [];
  await saveAccessConfig(ctx, (current) => {
    const list = new Set(current[listKey]);
    removed.length = 0;
    notThere.length = 0;
    for (const target of targets) {
      if (list.has(target.openId)) {
        list.delete(target.openId);
        removed.push(target.name ?? target.openId);
      } else {
        notThere.push(target.name ?? target.openId);
      }
    }
    return {
      ...current,
      [listKey]: [...list],
    };
  });
  const label = kind === 'user' ? '用户白名单' : '管理员';
  const parts: string[] = [];
  if (removed.length > 0) parts.push(`✅ 已把 ${removed.join('、')} 移出${label}。`);
  if (notThere.length > 0) parts.push(`${notThere.join('、')} 本来就不在${label}里，无需移除。`);
  await reply(ctx, parts.join('\n'));
}

function mentionTargets(ctx: CommandContext): Array<{ openId: string; name?: string }> {
  return (ctx.msg.mentions ?? [])
    .filter((mention) => !mention.isBot && typeof mention.openId === 'string' && mention.openId)
    .map((mention) => ({
      openId: mention.openId as string,
      ...(mention.name ? { name: mention.name } : {}),
    }));
}

async function saveAccessConfig(
  ctx: CommandContext,
  mutate: (access: ProfileAccess) => ProfileAccess,
): Promise<ProfileAccess> {
  return configOps.saveAccessConfig(ctx.controls, mutate);
}

// ────────────── /config — preferences form ──────────────

async function handleConfig(args: string, ctx: CommandContext): Promise<void> {
  const sub = args.trim().split(/\s+/)[0] ?? '';
  switch (sub) {
    case '':
      return showConfigForm(ctx);
    case 'submit':
      return submitConfig(ctx);
    case 'cancel':
      return cancelConfig(ctx);
    default:
      await reply(ctx, '用法:`/config`');
  }
}

async function showConfigForm(ctx: CommandContext): Promise<void> {
  await Promise.all([
    ctx.controls.refreshOwner(ctx.channel).catch(() => {}),
    fetchKnownChats(ctx.channel)
      .then((chats) => {
        if (chats.length > 0) ctx.controls.knownChats = chats;
      })
      .catch(() => {}),
  ]);

  const ms = getRunIdleTimeoutMs(ctx.controls.cfg);
  const access = ctx.controls.profileConfig.access;
  // Surface the local web console URL when the supervisor (`--web-ui`) is
  // running — read from the host sidecar and confirm the owning process is
  // alive so we don't advertise a stale address.
  const sidecar = await readUiSidecar(commandProfilePaths(ctx).hostUiFile).catch(() => undefined);
  const consoleUrl = sidecar && isAlive(sidecar.pid) ? sidecar.url : undefined;
  const card = configFormCard({
    agentKind: ctx.controls.profileConfig.agentKind,
    mode: ctx.controls.profileConfig.mode,
    model: normalizeModelSelection(
      ctx.controls.profileConfig.agentKind,
      ctx.controls.cfg.preferences?.model,
    ),
    messageReply: getMessageReplyMode(ctx.controls.cfg),
    showToolCalls: getShowToolCalls(ctx.controls.cfg),
    cotMessages: getCotMessages(ctx.controls.cfg),
    maxConcurrentRuns: getMaxConcurrentRuns(ctx.controls.cfg),
    runIdleTimeoutMinutes: ms ? Math.round(ms / 60_000) : 0,
    requireMentionInGroup: getRequireMentionInGroup(ctx.controls.cfg),
    larkCliIdentity: ctx.controls.profileConfig.larkCli.identityPreset,
    allowedUsers: access.allowedUsers,
    allowedChats: access.allowedChats,
    admins: access.admins,
    knownChats: ctx.controls.knownChats ?? [],
    ...(consoleUrl ? { consoleUrl } : {}),
  });
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card, commandReplyOptions(ctx));
}

async function showResultCardInPlace(
  ctx: CommandContext,
  formMsgId: string,
  card: object,
): Promise<void> {
  try {
    await updateManagedCard(ctx.channel, formMsgId, card);
  } catch (err) {
    log.warn('command', 'config-card-update-fallback', { err: String(err) });
    await sendManagedCard(ctx.channel, ctx.msg.chatId, card, commandReplyOptions(ctx)).catch((fallbackErr) =>
      log.warn('command', 'config-card-fallback-send-failed', {
        err: String(fallbackErr),
      }),
    );
  }
  forgetManagedCard(formMsgId);
}

async function cancelConfig(ctx: CommandContext): Promise<void> {
  if (ctx.fromCardAction) {
    const formMsgId = ctx.msg.messageId;
    void (async () => {
      await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
      await showResultCardInPlace(ctx, formMsgId, configCancelledCard());
    })();
  }
}

async function submitConfig(ctx: CommandContext): Promise<void> {
  const fv = ctx.formValue ?? {};
  const rawReply = String(fv.message_reply ?? '').trim();
  const messageReply: MessageReplyMode =
    rawReply === 'markdown' || rawReply === 'text' || rawReply === 'card'
      ? (rawReply as MessageReplyMode)
      : getMessageReplyMode(ctx.controls.cfg);
  const rawTools = String(fv.show_tool_calls ?? '').trim();
  const showToolCalls = rawTools !== 'hide';
  // Parse the model picker. Unexpected / empty values keep the current
  // selection. Store `undefined` for the "default" sentinel to keep config
  // tidy (resolveModelArg treats both the same way).
  const agentKind = ctx.controls.profileConfig.agentKind;
  const rawModel = String(fv.model ?? '').trim();
  const modelValid = rawModel !== '' && supportedModels(agentKind).some((m) => m.value === rawModel);
  const modelSelection = modelValid
    ? rawModel
    : normalizeModelSelection(agentKind, ctx.controls.cfg.preferences?.model);
  const model = modelSelection === DEFAULT_MODEL ? undefined : modelSelection;
  const rawCotMessages = String(fv.cot_messages ?? '').trim();
  const cotMessages =
    rawCotMessages === 'brief'
      ? 'brief'
      : rawCotMessages === 'detailed' || rawCotMessages === 'on'
        ? 'detailed'
        : rawCotMessages === 'off'
          ? 'off'
          : getCotMessages(ctx.controls.cfg);
  // Parse max_concurrent_runs; invalid input falls back to current value.
  const rawMaxCC = String(fv.max_concurrent_runs ?? '').trim();
  const parsedMaxCC = Number(rawMaxCC);
  const maxConcurrentRuns =
    Number.isFinite(parsedMaxCC) && parsedMaxCC >= 1
      ? Math.min(50, Math.floor(parsedMaxCC))
      : getMaxConcurrentRuns(ctx.controls.cfg);
  // Parse run_idle_timeout_minutes. 0 disables; otherwise clamp 1-120.
  // Empty string keeps current value.
  const rawIdle = String(fv.run_idle_timeout_minutes ?? '').trim();
  const currentIdleMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const currentIdleMinutes = currentIdleMs ? Math.round(currentIdleMs / 60_000) : 0;
  let runIdleTimeoutMinutes: number;
  if (rawIdle === '') {
    runIdleTimeoutMinutes = currentIdleMinutes;
  } else {
    const parsedIdle = Number(rawIdle);
    if (!Number.isFinite(parsedIdle) || parsedIdle < 0) {
      runIdleTimeoutMinutes = currentIdleMinutes;
    } else if (parsedIdle === 0) {
      runIdleTimeoutMinutes = 0;
    } else {
      runIdleTimeoutMinutes = Math.min(120, Math.max(1, Math.floor(parsedIdle)));
    }
  }
  // Parse require_mention_in_group. Empty / unexpected keeps current.
  const rawRequireMention = String(fv.require_mention_in_group ?? '').trim();
  let requireMentionInGroup: boolean;
  if (rawRequireMention === 'yes') requireMentionInGroup = true;
  else if (rawRequireMention === 'no') requireMentionInGroup = false;
  else requireMentionInGroup = getRequireMentionInGroup(ctx.controls.cfg);
  // Parse deployment mode. Empty / unexpected keeps current.
  const rawMode = String(fv.deploy_mode ?? '').trim();
  const mode: ProfileMode =
    rawMode === 'team' || rawMode === 'personal'
      ? rawMode
      : ctx.controls.profileConfig.mode;
  const rawLarkCliIdentity = String(fv.lark_cli_identity ?? '').trim();
  const larkCliIdentity =
    rawLarkCliIdentity === 'user-default' || rawLarkCliIdentity === 'bot-only'
      ? rawLarkCliIdentity
      : ctx.controls.profileConfig.larkCli.identityPreset;
  // Effective preset = what actually gets applied to lark-cli. Team mode forces
  // bot-only regardless of the stored identity select; the select value is still
  // saved verbatim so it comes back when switching to personal mode. Re-apply
  // the lark-cli policy whenever the *effective* preset changes (covers both a
  // direct identity-select change and a personal↔team flip).
  const nextEffectiveIdentity: LarkCliIdentityPreset =
    mode === 'team' ? 'bot-only' : larkCliIdentity;
  const previousEffectiveIdentity = effectiveLarkCliIdentity(ctx.controls.profileConfig);
  const larkCliIdentityChanged = nextEffectiveIdentity !== previousEffectiveIdentity;

  const formMsgId = ctx.msg.messageId;
  const access = ctx.controls.profileConfig.access;

  // Detach: same reason as account submit — Lark's client locks the form
  // while the cardAction handler is running. Wait out FORM_SETTLE_MS *after*
  // returning so the in-place card update sticks.
  void (async () => {
    const submittedAt = Date.now();
    const waitForSettle = async (): Promise<void> => {
      const elapsed = Date.now() - submittedAt;
      if (elapsed < FORM_SETTLE_MS) {
        await new Promise<void>((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
      }
    };

    const nextPreferences: AppPreferences = {
      ...(ctx.controls.cfg.preferences ?? {}),
      model,
      messageReply,
      // Mark the messageReply value as living in the new (post-0.1.27)
      // semantic — `text` now means real plain text, not the lightweight
      // markdown card. Set unconditionally on every submit so a user who
      // explicitly picks any option gets out of the legacy-coerce path.
      messageReplyMigrated: true,
      showToolCalls,
      cotMessages,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      requireMentionInGroup,
    };

    let failureStep = 'config.save';
    let larkCliPolicyApplied = false;
    try {
      if (larkCliIdentityChanged) {
        failureStep = 'config.lark-cli-policy';
        const applied = await applyConfigLarkCliIdentityPolicy(ctx, nextEffectiveIdentity);
        if (!applied) {
          throw new Error('lark-cli identity policy apply failed');
        }
        larkCliPolicyApplied = true;
        failureStep = 'config.save';
      }
      await savePreferencesConfig(ctx, nextPreferences, requireMentionInGroup, larkCliIdentity, mode);
    } catch (err) {
      let rollbackFailed = false;
      if (larkCliIdentityChanged) {
        const rolledBack = await applyConfigLarkCliIdentityPolicy(ctx, previousEffectiveIdentity);
        if (!rolledBack) {
          rollbackFailed = true;
          log.warn('command', 'lark-cli-identity-policy-rollback-failed', {
            profile: ctx.controls.profile,
            identity: previousEffectiveIdentity,
          });
        }
      }
      log.fail('command', err, { step: failureStep });
      reportMetric('command_fail', 1, { step: failureStep });
      await waitForSettle();
      await showResultCardInPlace(
        ctx,
        formMsgId,
        configFailedCard(configFailureMessage(failureStep, rollbackFailed, larkCliPolicyApplied)),
      );
      return;
    }

    log.info('command', 'config-saved', {
      mode,
      messageReply,
      showToolCalls,
      cotMessages,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      requireMentionInGroup,
      larkCliIdentity,
      allowedUsersCount: access.allowedUsers.length,
      allowedChatsCount: access.allowedChats.length,
      adminsCount: access.admins.length,
    });
    await waitForSettle();
    await showResultCardInPlace(
      ctx,
      formMsgId,
      configSavedCard({
        agentKind,
        mode,
        model: modelSelection,
        messageReply,
        showToolCalls,
        cotMessages,
        maxConcurrentRuns,
        runIdleTimeoutMinutes,
        requireMentionInGroup,
        larkCliIdentity,
        allowedUsers: access.allowedUsers,
        allowedChats: access.allowedChats,
        admins: access.admins,
        knownChats: ctx.controls.knownChats ?? [],
      }),
    );

    // "群里不需要 @ bot" only works if the app can actually receive non-@
    // group messages (`im:message.group_msg`). When the user opts in, verify
    // the scope and, if missing, push a one-click re-authorization link.
    if (!requireMentionInGroup) {
      await promptGroupMsgScopeIfMissing(ctx);
    }
  })();
}

/**
 * When the user enables "群里不需要 @ bot", confirm the app holds the
 * `im:message.group_msg` scope. If it's missing, generate an incremental
 * authorization link and push a guidance card; once the user finishes
 * authorizing, swap the card to a success state in place. Best-effort — any
 * failure here is logged and swallowed (the saved-config card already showed).
 */
async function promptGroupMsgScopeIfMissing(ctx: CommandContext): Promise<void> {
  const appId = ctx.controls.cfg.accounts.app.id;
  // `false` = confirmed missing; `null` = lookup failed → don't nag.
  const has = await hasGroupMsgScope(ctx.channel, appId);
  if (has !== false) return;
  log.info('command', 'group-msg-scope-missing', { appId });

  let link;
  try {
    link = await requestScopeGrantLink({ appId, tenantScopes: [GROUP_MSG_SCOPE] });
  } catch (err) {
    log.warn('command', 'scope-grant-link-failed', { err: String(err) });
    return;
  }

  const expireMins = Math.max(1, Math.round(link.expireIn / 60));
  let sent;
  try {
    sent = await sendManagedCard(
      ctx.channel,
      ctx.msg.chatId,
      groupMsgScopeGrantCard(link.url, expireMins),
    );
  } catch (err) {
    log.warn('command', 'scope-grant-card-send-failed', { err: String(err) });
    return;
  }

  // Detached: flip the card to "授权成功" once the user authorizes (or just
  // clean up the managed-card mapping if the link expires / is aborted).
  void link.completion.then(
    async () => {
      log.info('command', 'group-msg-scope-granted', { appId });
      await updateManagedCard(ctx.channel, sent.messageId, groupMsgScopeGrantedCard()).catch(
        () => {},
      );
      forgetManagedCard(sent.messageId);
    },
    (err) => {
      log.info('command', 'scope-grant-not-completed', { err: String(err) });
      forgetManagedCard(sent.messageId);
    },
  );
}

function configFailureMessage(step: string, rollbackFailed: boolean, larkCliPolicyApplied: boolean): string {
  if (rollbackFailed) {
    return '保存失败，且 lark-cli 身份策略回滚失败。请执行 /status 检查当前状态。';
  }
  if (larkCliPolicyApplied && step === 'config.save') {
    return '保存失败，lark-cli 身份策略已回滚。请重新打开 /config 确认当前状态。';
  }
  if (step === 'config.lark-cli-policy') {
    return 'lark-cli 身份策略未生效，未做任何修改。';
  }
  return '配置未写入，未做任何修改。';
}

function commandProfilePaths(ctx: CommandContext) {
  return resolveAppPaths({
    rootDir: dirname(ctx.controls.configPath),
    profile: ctx.controls.profile,
  });
}

async function applyConfigLarkCliIdentityPolicy(
  ctx: CommandContext,
  larkCliIdentity: ProfileConfig['larkCli']['identityPreset'],
): Promise<boolean> {
  return configOps.applyProfileLarkCliIdentity(ctx.controls, larkCliIdentity);
}

async function saveAccountConfig(
  ctx: CommandContext,
  newCfg: AppConfig,
  plaintextSecret: string,
): Promise<void> {
  return configOps.saveAccountConfig(ctx.controls, newCfg, plaintextSecret);
}

async function savePreferencesConfig(
  ctx: CommandContext,
  preferences: AppPreferences,
  requireMentionInGroup: boolean,
  larkCliIdentity: ProfileConfig['larkCli']['identityPreset'],
  mode: ProfileMode,
): Promise<void> {
  return configOps.savePreferencesConfig(
    ctx.controls,
    preferences,
    requireMentionInGroup,
    larkCliIdentity,
    mode,
  );
}

// ────────────── /meeting — in-meeting agent (智能体入会) ──────────────

/**
 * `/meeting` drives the bot's presence in a Feishu video meeting: join by
 * 9-digit number, leave, inspect what the session has captured, and ask the
 * agent a question with the meeting transcript as context.
 */
async function handleMeeting(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? '';
  const rest = parts.slice(1).join(' ');
  const manager = ctx.controls.meeting;

  if (!ctx.controls.profileConfig.meeting.enabled) {
    await reply(
      ctx,
      '会议智能体未启用。在 `/config` 或 Web 控制台里开启「会议智能体」后重启 bot 即可。',
    );
    return;
  }
  if (!manager) {
    await reply(ctx, '会议能力未就绪（channel 未连接或启用后尚未重启）。');
    return;
  }

  switch (sub) {
    case '':
    case 'status':
      await replyMeetingStatus(ctx, manager);
      return;
    case 'join': {
      const meetingNo = rest.replace(/\s/g, '');
      if (!isMeetingNo(meetingNo)) {
        await reply(ctx, '用法：`/meeting join <9位会议号>`（只接受 9 位纯数字，不是会议链接）');
        return;
      }
      try {
        const session = await manager.join(meetingNo, { originChatId: ctx.msg.chatId });
        await reply(
          ctx,
          `✅ 已入会 **${session.topic ?? meetingNo}**\n` +
            `会议号 ${session.meetingNo} · 会中发 \`${ctx.controls.profileConfig.meeting.trigger} 你的问题\` 可以问我\n` +
            '`/meeting notes` 总结 · `/meeting leave` 离会',
        );
      } catch (err) {
        await reply(ctx, `入会失败：${describeMeetingError(err)}`);
      }
      return;
    }
    case 'leave': {
      const picked = pickMeetingSession(manager, ctx, rest);
      if (!picked.ok) {
        await reply(ctx, picked.message);
        return;
      }
      await manager.leave(picked.session.meetingId);
      await reply(ctx, `✅ 已离会（会议号 ${picked.session.meetingNo}）`);
      return;
    }
    case 'transcript': {
      // Shows exactly what the agent is given as context. Without this, "why
      // did it mention X?" is unanswerable — the buffer is invisible.
      const picked = pickMeetingSession(manager, ctx, rest);
      if (!picked.ok) {
        await reply(ctx, picked.message);
        return;
      }
      const lines = picked.session.recentTranscript();
      if (lines.length === 0) {
        await reply(
          ctx,
          '字幕缓冲为空 —— agent 这次拿到的会议上下文是「（暂无字幕）」。\n' +
            '注意：同一场会里 agent 复用一个会话，**早先轮次**的字幕仍留在它自己的对话历史里，' +
            '所以它可能引用缓冲里已经没有的内容。`/new` 可以清掉该会话记忆。',
        );
        return;
      }
      const tail = lines.slice(-30);
      await reply(
        ctx,
        [
          `字幕缓冲共 ${lines.length} 条${tail.length < lines.length ? `，以下是最近 ${tail.length} 条` : ''}：`,
          '```',
          ...tail,
          '```',
        ].join('\n'),
      );
      return;
    }
    case 'stop': {
      const picked = pickMeetingSession(manager, ctx, rest);
      if (!picked.ok) {
        await reply(ctx, picked.message);
        return;
      }
      const stopped = ctx.activeRuns.interrupt(meetingScopeId(picked.session.meetingId));
      await reply(ctx, stopped ? '✅ 已中断该会议的当前任务。' : '该会议当前没有正在执行的任务。');
      return;
    }
    case 'notes':
    case 'ask': {
      // `notes` takes an optional meeting number; `ask` takes the question, so
      // only `notes` can disambiguate positionally.
      const picked = pickMeetingSession(manager, ctx, sub === 'notes' ? rest : '');
      if (!picked.ok) {
        await reply(ctx, picked.message);
        return;
      }
      const session = picked.session;
      const question =
        sub === 'notes'
          ? '请基于以上会议字幕做一份简洁纪要：讨论了什么、结论、待办（如有）。'
          : rest;
      if (!question) {
        await reply(ctx, '用法：`/meeting ask <问题>`');
        return;
      }
      if (!ctx.runExecutor) {
        await reply(ctx, '当前上下文无法执行 agent（缺少 run executor）。');
        return;
      }
      await reply(ctx, sub === 'notes' ? '正在总结会议…' : '正在思考…');
      try {
        const answer = await answerInMeeting(
          {
            session,
            channel: ctx.channel,
            controls: ctx.controls,
            executor: ctx.runExecutor,
            activeRuns: ctx.activeRuns,
            sessions: ctx.sessions,
            ...(ctx.sessionCatalog ? { sessionCatalog: ctx.sessionCatalog } : {}),
            workspaces: ctx.workspaces,
          },
          question,
          // Typed privately -> answer only to the caller. Broadcasting a
          // summary somebody asked for in a DM would surprise the meeting.
          { deliver: 'caller' },
        );
        await reply(ctx, answer || '（没有产生回答）');
      } catch (err) {
        await reply(ctx, `执行失败：${describeMeetingError(err)}`);
      }
      return;
    }
    default:
      await reply(
        ctx,
        [
          '用法：',
          '`/meeting` — 状态',
          '`/meeting join <9位会议号>` — 让 bot 入会',
          '`/meeting leave [会议号]` — 离会',
          '`/meeting notes [会议号]` — 基于字幕做纪要（只发给你）',
          '`/meeting stop [会议号]` — 中断该会议卡住的任务',
          '`/meeting transcript [会议号]` — 看 agent 实际拿到的字幕上下文',
          '`/meeting ask <问题>` — 带会议上下文提问',
        ].join('\n'),
      );
  }
}

type PickedSession =
  | { ok: true; session: MeetingSession }
  | { ok: false; message: string };

/**
 * Resolve which meeting a command targets when the bot may be in several.
 *
 * Order: explicit 9-digit number → the only meeting → the only meeting joined
 * from *this* chat → otherwise ask, listing the candidates. Silently defaulting
 * to "the first one" would act on the wrong meeting.
 */
function pickMeetingSession(
  manager: MeetingManager,
  ctx: CommandContext,
  explicit: string,
): PickedSession {
  const wanted = explicit.replace(/\s/g, '');
  if (wanted) {
    const found = manager.byMeetingNo(wanted);
    return found
      ? { ok: true, session: found }
      : { ok: false, message: `没找到会议号 ${wanted} 对应的会议。用 \`/meeting\` 看当前在跟哪几场。` };
  }

  const all = manager.all();
  if (all.length === 0) {
    return { ok: false, message: '当前没有在跟的会议。先 `/meeting join <9位会议号>`。' };
  }
  if (all.length === 1) return { ok: true, session: all[0]! };

  // Multiple meetings: prefer the one started from this chat.
  const fromHere = all.filter((s) => s.originChatId === ctx.msg.chatId);
  if (fromHere.length === 1) return { ok: true, session: fromHere[0]! };

  const list = all.map((s) => `- ${s.meetingNo}${s.topic ? `（${s.topic}）` : ''}`).join('\n');
  return {
    ok: false,
    message: `当前在跟 ${all.length} 场会议，请指定会议号：\n${list}\n\n例如 \`/meeting notes ${all[0]!.meetingNo}\``,
  };
}

async function replyMeetingStatus(ctx: CommandContext, manager: MeetingManager): Promise<void> {
  const sessions = manager.list();
  const push = manager.pushHealth();
  const pushLine = push.hooked
    ? `推送：已挂载，累计收到 ${push.received} 条${push.received === 0 ? '（尚未收到，可能还没在后台订阅 vc.bot.* 事件）' : ''}`
    : `推送：未挂载（${push.reason ?? '未知原因'}），仅靠轮询`;

  if (sessions.length === 0) {
    await reply(ctx, [`当前没有在跟的会议。`, pushLine, '', '`/meeting join <9位会议号>` 开始。'].join('\n'));
    return;
  }
  const lines = sessions.map(
    (s) =>
      `- **${s.topic ?? s.meetingNo}**（${s.meetingNo}）· 来源 ${s.source === 'push' ? '推送' : '轮询'}` +
      ` · 字幕 ${s.transcriptLines} 条 · 参会 ${s.participants} 人`,
  );
  await reply(ctx, [`正在跟 ${sessions.length} 场会议：`, ...lines, '', pushLine].join('\n'));
}
