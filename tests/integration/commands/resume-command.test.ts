import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
import { claudeCapability, codexCapability } from '../../../src/agent/capability.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import type { ChatModeCache } from '../../../src/bot/chat-mode-cache.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import { handleCardAction } from '../../../src/card/dispatcher.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type AgentKind, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { canUseDm } from '../../../src/policy/access.js';
import { evaluateRunPolicy } from '../../../src/policy/run-policy.js';
import { resolveWorkingDirectory } from '../../../src/policy/workspace.js';
import { SessionCatalog, type SessionCatalogIdentity } from '../../../src/session/catalog.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import type {
  CodexThreadHistoryEntry,
  ListCodexThreadHistoryOptions,
} from '../../../src/session/codex-history.js';
import type { SessionSummary } from '../../../src/session/history.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  catalog: SessionCatalog;
  controls: Controls;
  agent: FakeAgentAdapter;
  identity: SessionCatalogIdentity;
  claudeHistory: SessionSummary[];
  codexHistory: CodexThreadHistoryEntry[];
  codexHistoryRequests: ListCodexThreadHistoryOptions[];
  activeRuns: ActiveRuns;
  pending: PendingQueue;
  projectChats: {
    chats: Array<{ id: string; name: string; members: string[] }>;
    createCalls: number;
    createAttempts: number;
    createGate?: Promise<void>;
    onCreate?: () => void;
    getError?: Error;
    getNeverResolves?: boolean;
    onGet?: () => void;
    getMembersCalls: Array<{ chatId: string; force?: boolean; idType?: string }>;
    getMembersError?: Error;
    getMembersNeverResolves?: boolean;
    onGetMembers?: () => void;
  };
  run(content: string, options?: { withCatalogIdentity?: boolean; chatMode?: 'p2p' | 'group' | 'topic' }): Promise<boolean>;
  dispatchResumeArg(
    arg: string,
    options?: { chatId?: string; chatMode?: 'p2p' | 'group' | 'topic' },
  ): Promise<void>;
  dispatchTakeoverArg(
    arg: string,
    options?: { chatId?: string; chatMode?: 'p2p' | 'group' | 'topic' },
  ): Promise<void>;
  dispatchLaunch(
    profile: string,
    mode: 'new' | 'resume',
    options?: {
      chatId?: string;
      chatMode?: 'p2p' | 'group' | 'topic';
      projectChatName?: string;
    },
  ): Promise<void>;
  dispatchProfile(profile: string): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

describe('agent-aware resume commands', () => {
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('archives only the current catalog entry when starting a new conversation', async () => {
    const h = await createHarness('claude');
    h.catalog.upsertActive({ ...h.identity, sessionId: 'sess-current', now: 1000 });
    h.catalog.upsertActive({
      ...h.identity,
      agentId: 'codex',
      threadId: 'thread-other-agent',
      now: 1000,
    });

    await expect(h.run('/new')).resolves.toBe(true);

    expect(h.catalog.activeFor(h.identity)).toBeUndefined();
    expect(h.catalog.activeFor({ ...h.identity, agentId: 'codex' })).toMatchObject({
      threadId: 'thread-other-agent',
    });
  });

  it('allows resume use only for the current agent/cwd/policy catalog entry', async () => {
    const h = await createHarness('claude');
    h.catalog.upsertActive({ ...h.identity, sessionId: 'sess-current', now: 1000 });
    h.catalog.upsertActive({
      ...h.identity,
      policyFingerprint: 'stale-fp',
      sessionId: 'sess-stale',
      now: 1000,
    });

    await expect(h.run('/resume use sess-stale')).resolves.toBe(true);
    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('不可恢复');

    await expect(h.run('/resume use sess-current')).resolves.toBe(true);
    expect(h.sessions.resumeFor('chat-1', h.identity.cwdRealpath)).toBe('sess-current');
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('resumes the selected Claude history entry from the card button callback', async () => {
    const h = await createHarness('claude');
    h.sessions.set('chat-1', 'sess-current', h.identity.cwdRealpath);
    h.catalog.upsertActive({ ...h.identity, sessionId: 'sess-current', now: 1000 });
    h.claudeHistory.push(
      claudeSession('sess-current', 'current prompt', 1_700_000_100_000),
      claudeSession('sess-target', 'target prompt', 1_700_000_000_000),
    );

    await expect(h.run('/resume')).resolves.toBe(true);

    const card = lastContent(h.channel);
    const rendered = JSON.stringify(card);
    expect(rendered).toContain('current prompt');
    expect(rendered).toContain('target prompt');
    expect(rendered).toContain('sess-tar');

    const nonces = resumeArgsFromCard(card);
    expect(nonces).toHaveLength(2);
    expect(nonces[1]).not.toBe('sess-target');
    await h.dispatchResumeArg(nonces[1]!);

    expect(h.sessions.resumeFor('chat-1', h.identity.cwdRealpath)).toBe('sess-target');
    expect(h.catalog.activeFor(h.identity)).toMatchObject({
      sessionId: 'sess-target',
    });
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('accepts the current Codex thread without writing it into legacy SessionStore', async () => {
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });

    await expect(h.run('/resume')).resolves.toBe(true);
    const nonce = resumeNonce(lastMarkdown(h.channel));

    await expect(h.run(`/resume use ${nonce}`)).resolves.toBe(true);

    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('falls back to an audit-safe reply when resume confirmation is rejected', async () => {
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });
    await expect(h.run('/resume')).resolves.toBe(true);
    const nonce = resumeNonce(lastMarkdown(h.channel));
    const originalSend = h.channel.send.bind(h.channel);
    let attempts = 0;
    h.channel.send = async (...args) => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error('The messages do NOT pass the audit.') as Error & { code: number };
        err.code = 230028;
        throw err;
      }
      return originalSend(...args);
    };

    await expect(h.run(`/resume use ${nonce}`)).resolves.toBe(true);

    expect(attempts).toBe(2);
    expect(lastMarkdown(h.channel)).toBe('命令已处理。');
  });

  it('shows only the current catalog-backed Codex thread in /resume', async () => {
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });

    await expect(h.run('/resume')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('当前 Codex thread 可恢复');
    expect(lastMarkdown(h.channel)).toMatch(/\/resume use [a-f0-9-]+/);
    expect(lastMarkdown(h.channel)).not.toContain('thread-current');
  });

  it('does not accept raw Codex thread ids as resume candidates', async () => {
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });

    await expect(h.run('/resume use thread-current')).resolves.toBe(true);

    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('请先用 `/resume`');
  });

  it('does not fall back to legacy SessionStore when Codex catalog identity is missing', async () => {
    const h = await createHarness('codex');

    await expect(h.run('/resume use thread-current', { withCatalogIdentity: false })).resolves.toBe(true);

    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('当前上下文没有可恢复的 Codex thread');
  });

  it('does not list Claude local history for Codex when no current thread is recorded', async () => {
    const h = await createHarness('codex');

    await expect(h.run('/resume')).resolves.toBe(true);

    expect(lastContentString(h.channel)).toContain('此 cwd 下没有历史会话');
  });

  it('lists Codex history for the current cwd and resumes the selected thread through a nonce', async () => {
    const h = await createHarness('codex');
    h.agent.setAppServerResponse('thread/read', {
      thread: {
        id: 'thread-beta-secret',
        name: 'beta session',
        turns: [{
          status: 'completed',
          items: [
            { type: 'userMessage', content: [{ type: 'input_text', text: 'historic question' }] },
            { type: 'agentMessage', phase: 'final_answer', text: 'historic answer' },
          ],
        }],
      },
    });
    h.codexHistory.push(
      codexThread('thread-alpha-secret', 'alpha prompt', 1_700_000_100_000),
      codexThread('thread-beta-secret', 'beta prompt', 1_700_000_000_000),
    );

    await expect(h.run('/resume')).resolves.toBe(true);

    const card = lastContent(h.channel);
    const rendered = JSON.stringify(card);
    expect(rendered).toContain('alpha prompt');
    expect(rendered).toContain('beta prompt');
    expect(rendered).toContain('thread-alpha-secret');
    expect(rendered).toContain('thread-beta-secret');

    const nonces = resumeArgsFromCard(card);
    expect(nonces).toHaveLength(2);
    await expect(h.run(`/resume use ${nonces[1]}`)).resolves.toBe(true);

    expect(h.catalog.activeFor(h.identity)).toMatchObject({
      threadId: 'thread-beta-secret',
    });
    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(h.agent.appServerRequests.at(-2)).toMatchObject({
      method: 'thread/resume',
      params: {
        threadId: 'thread-beta-secret',
        cwd: h.identity.cwdRealpath,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      },
    });
    expect(h.agent.appServerRequests.at(-1)).toMatchObject({
      method: 'thread/read',
      params: { threadId: 'thread-beta-secret', includeTurns: true },
    });
    const historyCard = lastContentString(h.channel);
    expect(historyCard).toContain('Codex 历史');
    expect(historyCard).toContain('historic question');
    expect(historyCard).toContain('historic answer');
  });

  it('filters Codex history by the selected profile model provider', async () => {
    const h = await createHarness('codex');
    const codexHome = join(h.tmp.root, 'codex-home');
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, 'freerouter.config.toml'), 'model_provider = "freerouter"\n');
    h.controls.profileConfig.codex!.codexHome = codexHome;
    h.workspaces.setCodexLaunch('chat-1', 'freerouter', 'resume');

    await expect(h.run('/resume')).resolves.toBe(true);

    expect(h.codexHistoryRequests.at(-1)).toMatchObject({
      profile: 'freerouter',
      modelProviders: ['freerouter'],
    });
  });

  it('does not hide Codex history based on stale catalog active entries', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(
      codexThread('thread-busy', 'busy prompt', 1_700_000_100_000),
      codexThread('thread-free', 'free prompt', 1_700_000_000_000),
    );
    h.catalog.upsertActive({
      ...h.identity,
      scopeId: 'chat-2',
      policyFingerprint: 'other-profile-fingerprint',
      threadId: 'thread-busy',
      now: 1000,
    });

    await expect(h.run('/resume')).resolves.toBe(true);

    const rendered = lastContentString(h.channel);
    expect(rendered).toContain('busy prompt');
    expect(rendered).toContain('free prompt');
    expect(resumeArgsFromCard(lastContent(h.channel))).toHaveLength(2);
  });

  it('keeps the current identity own Codex thread available for resume', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(codexThread('thread-current', 'current prompt', 1_700_000_100_000));
    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });

    await expect(h.run('/resume')).resolves.toBe(true);

    expect(lastContentString(h.channel)).toContain('current prompt');
    expect(resumeArgsFromCard(lastContent(h.channel))).toHaveLength(1);
  });

  it('uses thread/resume instead of a catalog entry to decide whether a Codex thread is available', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(codexThread('thread-raced', 'race prompt', 1_700_000_100_000));
    await expect(h.run('/resume')).resolves.toBe(true);
    const [nonce] = resumeArgsFromCard(lastContent(h.channel));
    h.catalog.upsertActive({
      ...h.identity,
      scopeId: 'chat-2',
      policyFingerprint: 'other-profile-fingerprint',
      threadId: 'thread-raced',
      now: 1000,
    });

    await expect(h.run(`/resume use ${nonce}`)).resolves.toBe(true);

    expect(h.agent.appServerRequests[0]).toMatchObject({
      method: 'thread/resume',
      params: { threadId: 'thread-raced' },
    });
    expect(h.catalog.activeFor(h.identity)).toMatchObject({ threadId: 'thread-raced' });
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('offers the current catalog fallback even when another identity has a stale active entry', async () => {
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-shared', now: 1000 });
    h.catalog.upsertActive({
      ...h.identity,
      scopeId: 'chat-2',
      policyFingerprint: 'other-profile-fingerprint',
      threadId: 'thread-shared',
      now: 1000,
    });

    await expect(h.run('/resume')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('当前 Codex thread 可恢复');
    expect(lastMarkdown(h.channel)).toMatch(/\/resume use [a-f0-9-]+/);
  });

  it('does not change the catalog when thread/resume fails', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(codexThread('thread-broken', 'broken prompt', 1_700_000_100_000));
    h.agent.setAppServerError('thread/resume', new Error('resume failed'));
    await expect(h.run('/resume')).resolves.toBe(true);
    const [nonce] = resumeArgsFromCard(lastContent(h.channel));

    await expect(h.run(`/resume use ${nonce}`)).resolves.toBe(true);

    expect(h.catalog.activeFor(h.identity)).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('恢复 Codex thread 失败：resume failed');
  });

  it('offers a confirmed takeover when Codex reports an active writer', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(codexThread('thread-busy', 'busy prompt', 1_700_000_100_000));
    h.agent.setAppServerError('thread/resume', new Error('thread already has an active writer'));
    await expect(h.run('/resume')).resolves.toBe(true);
    const [nonce] = resumeArgsFromCard(lastContent(h.channel));

    await expect(h.run(`/resume use ${nonce}`)).resolves.toBe(true);

    const card = lastContent(h.channel);
    expect(JSON.stringify(card)).toContain('终止占用并接管');
    expect(JSON.stringify(card)).toContain('confirm');
    expect(takeoverArgsFromCard(card)).toHaveLength(1);
    expect(h.catalog.activeFor(h.identity)).toBeUndefined();
  });

  it('takes over the writer, retries thread/resume, and only then updates the catalog', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(codexThread('thread-busy', 'busy prompt', 1_700_000_100_000));
    h.agent.setAppServerError('thread/resume', new Error('thread already has an active writer'));
    await expect(h.run('/resume')).resolves.toBe(true);
    const [resumeNonce] = resumeArgsFromCard(lastContent(h.channel));
    await expect(h.run(`/resume use ${resumeNonce}`)).resolves.toBe(true);
    const [takeoverNonce] = takeoverArgsFromCard(lastContent(h.channel));

    await h.dispatchTakeoverArg(takeoverNonce!);

    expect(h.agent.takeoverThreadWriterCalls).toEqual(['thread-busy']);
    expect(h.agent.appServerRequests.filter((request) => request.method === 'thread/resume')).toHaveLength(2);
    expect(h.catalog.activeFor(h.identity)).toMatchObject({ threadId: 'thread-busy' });
    expect(lastMarkdown(h.channel)).toContain('已终止占用进程并完成接管');
  });

  it('keeps the catalog unchanged when the writer is still active after takeover', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(codexThread('thread-busy', 'busy prompt', 1_700_000_100_000));
    h.agent.setAppServerError('thread/resume', new Error('thread already has an active writer'));
    h.agent.setAppServerError('thread/resume', new Error('thread already has an active writer'));
    await expect(h.run('/resume')).resolves.toBe(true);
    const [resumeNonce] = resumeArgsFromCard(lastContent(h.channel));
    await expect(h.run(`/resume use ${resumeNonce}`)).resolves.toBe(true);
    const [takeoverNonce] = takeoverArgsFromCard(lastContent(h.channel));

    await h.dispatchTakeoverArg(takeoverNonce!);

    expect(h.catalog.activeFor(h.identity)).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('接管后该 Codex thread 仍被占用');
  });

  it('allows only admins to take over a Codex writer', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(codexThread('thread-busy', 'busy prompt', 1_700_000_100_000));
    h.agent.setAppServerError('thread/resume', new Error('thread already has an active writer'));
    await expect(h.run('/resume')).resolves.toBe(true);
    const [resumeNonce] = resumeArgsFromCard(lastContent(h.channel));
    await expect(h.run(`/resume use ${resumeNonce}`)).resolves.toBe(true);
    const [takeoverNonce] = takeoverArgsFromCard(lastContent(h.channel));
    h.controls.botOwnerId = 'ou-owner';
    h.controls.profileConfig.access.admins = [];
    h.controls.profileConfig.access.allowedUsers = ['ou-user'];

    await h.dispatchTakeoverArg(takeoverNonce!);

    expect(h.agent.takeoverThreadWriterCalls).toHaveLength(0);
    expect(h.catalog.activeFor(h.identity)).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
  });

  it('resumes a Codex history selection from the card button callback', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(codexThread('thread-alpha-secret', 'alpha prompt', 1_700_000_100_000));

    await expect(h.run('/resume')).resolves.toBe(true);

    const [nonce] = resumeArgsFromCard(lastContent(h.channel));
    expect(nonce).toBeTypeOf('string');
    await h.dispatchResumeArg(nonce!);

    expect(h.catalog.activeFor(h.identity)).toMatchObject({
      threadId: 'thread-alpha-secret',
    });
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('keeps a Codex resume selected when reading its display history fails', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(codexThread('thread-offline', 'offline history', 1_700_000_100_000));
    await expect(h.run('/resume')).resolves.toBe(true);
    const [nonce] = resumeArgsFromCard(lastContent(h.channel));
    h.agent.setAppServerError('thread/read', new Error('app-server offline'));

    await expect(h.run(`/resume use ${nonce}`)).resolves.toBe(true);

    expect(h.catalog.activeFor(h.identity)).toMatchObject({ threadId: 'thread-offline' });
    expect(lastMarkdown(h.channel)).toContain('会话已恢复');
    expect(lastMarkdown(h.channel)).toContain('读取历史记录失败');
  });

  it('keeps Codex resume history details out of group chats like Claude', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(codexThread('thread-alpha-secret', 'alpha prompt', 1_700_000_100_000));

    await expect(h.run('/resume', { chatMode: 'group' })).resolves.toBe(true);

    const rendered = lastContentString(h.channel);
    expect(rendered).toContain('私聊');
    expect(rendered).not.toContain('alpha prompt');
    expect(rendered).not.toContain('thread-alpha-secret');
  });

  it('用中文状态标签展示 Codex 会话和已记录的 thread id', async () => {
    const h = await createHarness('codex');

    await expect(h.run('/status')).resolves.toBe(true);
    let status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('**Codex 会话**');
    expect(status).toContain('未建立');
    expect(status).not.toContain('**session**');
    expect(status).not.toContain('**thread**');

    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });
    await expect(h.run('/status')).resolves.toBe(true);

    status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('**Codex 会话**');
    expect(status).toContain('thread-c');
    expect(status).not.toContain('未建立');
  });

  it('does not list local history from home when no workspace is bound', async () => {
    const h = await createHarness('claude', { bindWorkspace: false, defaultWorkspace: false });

    await expect(h.run('/resume')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('请先使用 /cd');
  });

  it('asks for a Codex profile and launch mode after /cd without starting a run', async () => {
    const h = await createHarness('codex');
    const codexHome = join(h.tmp.root, 'codex-home');
    const target = join(h.tmp.root, 'next-workspace');
    await Promise.all([mkdir(codexHome), mkdir(target)]);
    await writeFile(join(codexHome, 'config.toml'), '[profiles.freerouter]\nmodel = "free"\n');
    h.controls.profileConfig.codex!.codexHome = codexHome;
    h.controls.profileConfig.codex!.profile = 'freerouter';

    await expect(h.run(`/cd ${target}`)).resolves.toBe(true);

    const card = lastContentString(h.channel);
    expect(card).toContain('选择 Codex 启动方式');
    expect(card).toContain('freerouter');
    expect(card).toContain('默认配置（不传 --profile）');
    expect(card).toContain('项目群名称（仅首次创建时生效）');
    expect(card).toContain('Codex 项目群｜next-workspace');
    expect(h.workspaces.codexLaunchPendingFor('chat-1')).toBe(true);
    expect(h.workspaces.selectionFor('chat-1')?.launchMode).toBeUndefined();
    expect(h.controls.profileConfig.codex?.profile).toBe('freerouter');
    expect(h.workspaces.codexProfileFor('chat-1', 'freerouter')).toBe('freerouter');

    await h.dispatchLaunch('__default__', 'new');

    expect(h.projectChats.createCalls).toBe(1);
    expect(h.workspaces.codexLaunchPendingFor('chat-1')).toBe(false);
    expect(h.workspaces.selectionFor('chat-1')).toBeUndefined();
    expect(h.workspaces.projectChatFor(await realpath(target))).toEqual({
      chatId: 'oc_project_1',
      name: 'Codex 项目群｜next-workspace',
    });
    expect(h.workspaces.selectionFor('oc_project_1')).toMatchObject({
      cwd: await realpath(target),
      codexProfile: null,
      launchMode: 'new',
    });
    expect(h.workspaces.codexProfileFor('oc_project_1', 'freerouter')).toBeUndefined();
    expect(h.channel.sent.some((entry) =>
      entry.chatId === 'oc_project_1'
      && JSON.stringify(entry.content).includes('无 `--profile`'),
    )).toBe(true);

    await h.run('/status', { chatMode: 'group' });
    const status = lastContentString(h.channel);
    expect(status).toContain('**对话范围**');
    expect(status).toContain('**Bridge 配置**');
    expect(status).toContain('**工作目录**');
    expect(status).toContain('**Codex 会话**');
    expect(status).toContain('**Codex 配置**');
    expect(status).toContain('**权限**');
    expect(status).toContain('**会话方式**');
    expect(status).not.toContain('**scope**');
    expect(status).not.toContain('**sandbox**');
    expect(status).not.toContain('**launch**');
  });

  it('uses an edited project-group name when creating the group', async () => {
    const h = await createHarness('codex');

    await expect(h.run(`/cd ${h.tmp.workspace}`)).resolves.toBe(true);
    await h.dispatchLaunch('freerouter', 'new', { projectChatName: '桥接器研发项目群' });

    expect(h.projectChats.createCalls).toBe(1);
    expect(h.workspaces.projectChatFor(await realpath(h.tmp.workspace))).toEqual({
      chatId: 'oc_project_1',
      name: '桥接器研发项目群',
    });
  });

  it('deduplicates concurrent project-group launch callbacks and announces reuse in the group', async () => {
    const h = await createHarness('codex');

    await expect(h.run(`/cd ${h.tmp.workspace}`)).resolves.toBe(true);
    let releaseCreate!: () => void;
    h.projectChats.createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let markCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    h.projectChats.onCreate = () => markCreateStarted();

    const first = h.dispatchLaunch('freerouter', 'new');
    await createStarted;
    const second = h.dispatchLaunch('freerouter', 'new');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.projectChats.createAttempts).toBe(1);
    releaseCreate();

    await Promise.all([first, second]);

    expect(h.projectChats.createCalls).toBe(1);
    expect(h.projectChats.chats).toHaveLength(1);

    await expect(h.run(`/cd ${h.tmp.workspace}`)).resolves.toBe(true);
    await h.dispatchLaunch('freerouter', 'new');

    expect(h.projectChats.createCalls).toBe(1);
    expect(h.channel.sent.some((entry) =>
      entry.chatId === 'oc_project_1'
      && JSON.stringify(entry.content).includes('🔁 已复用项目群'),
    )).toBe(true);
  });

  it('对同一路径复用请求者仍在其中的项目群，群已删除时才重建', async () => {
    const h = await createHarness('codex');

    await expect(h.run(`/cd ${h.tmp.workspace}`)).resolves.toBe(true);
    await h.dispatchLaunch('freerouter', 'new');
    expect(h.projectChats.createCalls).toBe(1);
    expect(h.workspaces.projectChatFor(await realpath(h.tmp.workspace))?.name)
      .toBe('Codex 项目群｜workspace');
    expect(h.workspaces.projectChatFor(await realpath(h.tmp.workspace))?.chatId)
      .toBe('oc_project_1');

    await expect(h.run(`/cd ${h.tmp.workspace}`)).resolves.toBe(true);
    await h.dispatchLaunch('freerouter', 'new', { projectChatName: '不应覆盖已有群名' });
    expect(h.projectChats.createCalls).toBe(1);
    expect(h.workspaces.projectChatFor(await realpath(h.tmp.workspace))?.name)
      .toBe('Codex 项目群｜workspace');
    expect(h.projectChats.getMembersCalls.at(-1)).toEqual({
      chatId: 'oc_project_1',
      force: true,
      idType: 'open_id',
    });
    expect(h.channel.sent.some((entry) =>
      entry.chatId === 'chat-1'
      && JSON.stringify(entry.content).includes('已复用'),
    )).toBe(true);

    h.projectChats.chats.length = 0;
    await expect(h.run(`/cd ${h.tmp.workspace}`)).resolves.toBe(true);
    await h.dispatchLaunch('freerouter', 'new');
    expect(h.projectChats.createCalls).toBe(2);
    expect(h.workspaces.projectChatFor(await realpath(h.tmp.workspace))?.chatId)
      .toBe('oc_project_2');
  });

  it('请求者已退出映射的项目群时新建群并更新映射', async () => {
    const h = await createHarness('codex');

    await expect(h.run(`/cd ${h.tmp.workspace}`)).resolves.toBe(true);
    await h.dispatchLaunch('freerouter', 'new');
    h.projectChats.chats[0]!.members = [];

    await expect(h.run(`/cd ${h.tmp.workspace}`)).resolves.toBe(true);
    await h.dispatchLaunch('freerouter', 'new');

    expect(h.projectChats.createCalls).toBe(2);
    expect(h.workspaces.projectChatFor(await realpath(h.tmp.workspace))).toEqual({
      chatId: 'oc_project_2',
      name: 'Codex 项目群｜workspace',
    });
    expect(h.projectChats.chats[1]?.members).toEqual(['ou-user']);
    expect(lastMarkdown(h.channel)).toContain('已创建');
    expect(lastMarkdown(h.channel)).not.toContain('已复用');
  });

  it('/new chat 复用同一路径项目群并归档该群的当前 Codex thread', async () => {
    const h = await createHarness('codex');

    await expect(h.run(`/cd ${h.tmp.workspace}`)).resolves.toBe(true);
    await h.dispatchLaunch('freerouter', 'new');
    const projectIdentity = await commandIdentity(
      'codex',
      h.controls.profileConfig,
      h.controls,
      h.tmp.workspace,
      'freerouter',
      'oc_project_1',
    );
    h.catalog.upsertActive({ ...projectIdentity, threadId: 'thread-current', now: 1000 });

    await expect(h.run('/new chat')).resolves.toBe(true);

    expect(h.projectChats.createCalls).toBe(1);
    expect(h.catalog.activeFor(projectIdentity)).toBeUndefined();
    expect(h.workspaces.selectionFor('oc_project_1')).toMatchObject({
      codexProfile: 'freerouter',
      launchMode: 'new',
    });
    expect(lastMarkdown(h.channel)).toContain('已复用');
  });

  it('无法确认已有项目群状态时不重复建群', async () => {
    const h = await createHarness('codex');

    await expect(h.run(`/cd ${h.tmp.workspace}`)).resolves.toBe(true);
    await h.dispatchLaunch('freerouter', 'new');
    h.projectChats.getError = new Error('network unavailable');

    await expect(h.run(`/cd ${h.tmp.workspace}`)).resolves.toBe(true);
    await h.dispatchLaunch('freerouter', 'new');

    expect(h.projectChats.createCalls).toBe(1);
    expect(h.workspaces.codexLaunchPendingFor('chat-1')).toBe(true);
    expect(lastMarkdown(h.channel)).toContain('避免重复建群');
  });

  it('无法确认请求者是否仍在项目群时不重复建群', async () => {
    const h = await createHarness('codex');

    await expect(h.run(`/cd ${h.tmp.workspace}`)).resolves.toBe(true);
    await h.dispatchLaunch('freerouter', 'new');
    h.projectChats.getMembersError = new Error('member lookup unavailable');

    await expect(h.run(`/cd ${h.tmp.workspace}`)).resolves.toBe(true);
    await h.dispatchLaunch('freerouter', 'new');

    expect(h.projectChats.createCalls).toBe(1);
    expect(h.workspaces.codexLaunchPendingFor('chat-1')).toBe(true);
    expect(lastMarkdown(h.channel)).toContain('避免重复建群');
  });

  it('项目群成员查询不返回时结束回调且不重复建群', async () => {
    const h = await createHarness('codex');

    await expect(h.run(`/cd ${h.tmp.workspace}`)).resolves.toBe(true);
    await h.dispatchLaunch('freerouter', 'new');
    await expect(h.run(`/cd ${h.tmp.workspace}`)).resolves.toBe(true);
    h.projectChats.getMembersNeverResolves = true;
    let markLookupStarted: (() => void) | undefined;
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    h.projectChats.onGetMembers = () => markLookupStarted?.();
    vi.useFakeTimers();

    const launch = h.dispatchLaunch('freerouter', 'new');
    await lookupStarted;
    await vi.advanceTimersByTimeAsync(10_000);
    await launch;

    expect(h.projectChats.createCalls).toBe(1);
    expect(h.workspaces.codexLaunchPendingFor('chat-1')).toBe(true);
    expect(lastMarkdown(h.channel)).toContain('避免重复建群');
  });

  it('已有项目群查询不返回时结束回调且不重复建群', async () => {
    const h = await createHarness('codex');

    await expect(h.run(`/cd ${h.tmp.workspace}`)).resolves.toBe(true);
    await h.dispatchLaunch('freerouter', 'new');
    await expect(h.run(`/cd ${h.tmp.workspace}`)).resolves.toBe(true);
    h.projectChats.getNeverResolves = true;
    let markLookupStarted: (() => void) | undefined;
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    h.projectChats.onGet = () => markLookupStarted?.();
    vi.useFakeTimers();

    const launch = h.dispatchLaunch('freerouter', 'new');
    await lookupStarted;
    await vi.advanceTimersByTimeAsync(10_000);
    await launch;

    expect(h.projectChats.createCalls).toBe(1);
    expect(h.workspaces.codexLaunchPendingFor('chat-1')).toBe(true);
    expect(lastMarkdown(h.channel)).toContain('避免重复建群');
  });

  it('在同一项目群内用 /profile 重新选择 Codex profile', async () => {
    const h = await createHarness('codex');
    h.workspaces.setProjectChat(h.tmp.workspace, { chatId: 'chat-1', name: 'Project' });
    h.workspaces.setCodexLaunch('chat-1', 'freerouter', 'new');

    await expect(h.run('/profile', { chatMode: 'group' })).resolves.toBe(true);

    const card = lastContentString(h.channel);
    expect(card).toContain('选择 Codex 启动方式');
    expect(card).toContain('freerouter');
    expect(h.workspaces.codexLaunchPendingFor('chat-1')).toBe(true);
    expect(h.projectChats.createCalls).toBe(0);
  });

  it('在 Bot 私聊切换默认 Codex profile，并用于后续项目选择', async () => {
    const h = await createHarness('codex');
    Object.assign(h.channel, { botIdentity: { openId: 'ou-bot', name: '洞洞的codex' } });
    const codexHome = join(h.tmp.root, 'codex-home');
    const target = join(h.tmp.root, 'next-workspace');
    await Promise.all([mkdir(codexHome), mkdir(target)]);
    await writeFile(
      join(codexHome, 'config.toml'),
      '[profiles.freerouter]\nmodel = "free"\n[profiles.direct]\nmodel = "direct"\n',
    );
    h.controls.profileConfig.codex!.codexHome = codexHome;
    h.controls.profileConfig.codex!.profile = 'freerouter';

    await expect(h.run('/profile')).resolves.toBe(true);
    const picker = lastContentString(h.channel);
    expect(picker).toContain('切换 Codex profile');
    expect(picker).toContain('洞洞的codex');
    expect(picker).toContain('direct');
    expect(picker).not.toContain('会话方式');
    expect(h.projectChats.createCalls).toBe(0);

    await h.dispatchProfile('direct');
    expect(h.workspaces.defaultCodexProfile()).toBe('direct');
    expect(lastMarkdown(h.channel)).toContain('默认 Codex profile 已切换为 `direct`');

    await expect(h.run(`/cd ${target}`)).resolves.toBe(true);
    expect(lastContentString(h.channel)).toContain('"initial_option":"direct"');
    expect(h.projectChats.createCalls).toBe(0);
  });

  it('keeps a requested Codex resume pending until a concrete history thread is selected', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(codexThread('thread-resume', 'resume me', 1_700_000_100_000));

    await expect(h.run(`/cd ${h.tmp.workspace}`)).resolves.toBe(true);
    await h.dispatchLaunch('freerouter', 'resume');

    expect(h.workspaces.codexLaunchPendingFor('oc_project_1')).toBe(true);
    expect(lastContentString(h.channel)).toContain('resume me');
    const [nonce] = resumeArgsFromCard(lastContent(h.channel));
    await h.dispatchResumeArg(nonce!, { chatId: 'oc_project_1', chatMode: 'group' });

    expect(h.workspaces.codexLaunchPendingFor('oc_project_1')).toBe(false);
    expect(h.workspaces.selectionFor('oc_project_1')).toMatchObject({
      codexProfile: 'freerouter',
      launchMode: 'resume',
    });
    const selectedIdentity = await commandIdentity(
      'codex',
      h.controls.profileConfig,
      h.controls,
      h.tmp.workspace,
      'freerouter',
      'oc_project_1',
    );
    expect(h.catalog.activeFor(selectedIdentity)).toMatchObject({ threadId: 'thread-resume' });
  });

  it('persists Codex permissions per scope, clamps full access, and displays the effective value', async () => {
    const h = await createHarness('codex');
    h.controls.profileConfig.permissions.maxAccess = 'workspace';

    await expect(h.run('/permission full')).resolves.toBe(true);

    expect(h.workspaces.codexSandboxFor('chat-1')).toBe('workspace-write');
    expect(lastMarkdown(h.channel)).toContain('超过配置上限');
    expect(lastMarkdown(h.channel)).toContain('workspace-write');

    await expect(h.run('/status')).resolves.toBe(true);
    const status = lastContentString(h.channel);
    expect(status).toContain('workspace-write（上限 workspace-write）');
    expect(status).toContain('默认（无 --profile）');

    await expect(h.run('/permissions')).resolves.toBe(true);
    const picker = lastContentString(h.channel);
    expect(picker).toContain('Full access');
    expect(picker).toContain('workspace-write');
  });

  it('updates an active Codex thread for subsequent turns and migrates its catalog identity', async () => {
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });
    const activeRun = Object.assign(
      h.agent.run({ runId: 'run-active', prompt: 'running' }),
      {
        remoteSession: () => ({
          endpoint: h.agent.appServerEndpointValue,
          threadId: 'thread-current',
        }),
      },
    );
    h.activeRuns.register('chat-1', activeRun);

    await expect(h.run('/permissions read-only')).resolves.toBe(true);

    expect(h.agent.appServerRequests).toEqual([{
      method: 'thread/settings/update',
      params: {
        threadId: 'thread-current',
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      },
    }]);
    expect(h.catalog.activeFor(h.identity)).toBeUndefined();
    expect(h.catalog.entries()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        threadId: 'thread-current',
        status: 'active',
        policyFingerprint: expect.not.stringMatching(h.identity.policyFingerprint),
      }),
    ]));
  });

  it('prints an exact remote attach command for the current Codex thread', async () => {
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });

    await expect(h.run('/attach')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain(
      'codex --remote unix:///tmp/fake-codex.sock resume thread-current',
    );
  });

  it('includes the selected profile in attach and attached-TUI commands', async () => {
    const h = await createHarness('codex');
    h.workspaces.setCodexLaunch('chat-1', 'freerouter', 'resume');
    const activeRun = Object.assign(
      h.agent.run({ runId: 'run-active', prompt: 'running' }),
      {
        remoteSession: () => ({
          endpoint: h.agent.appServerEndpointValue,
          threadId: 'thread-current',
          profile: 'freerouter',
        }),
      },
    );
    h.activeRuns.register('chat-1', activeRun);

    await expect(h.run('/attach')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain(
      'codex --profile freerouter --remote unix:///tmp/fake-codex.sock resume thread-current',
    );

    await expect(h.run('/theme')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain(
      'codex --profile freerouter --remote unix:///tmp/fake-codex.sock resume thread-current',
    );
  });

  it('maps remote-semantic Codex slash commands to app-server and persists local turn settings', async () => {
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });

    await expect(h.run('/rename release prep')).resolves.toBe(true);
    expect(h.agent.appServerRequests.at(-1)).toMatchObject({
      method: 'thread/name/set',
      params: { threadId: 'thread-current', name: 'release prep' },
    });

    await expect(h.run('/goal finish tests')).resolves.toBe(true);
    expect(h.agent.appServerRequests.at(-1)).toMatchObject({
      method: 'thread/goal/set',
      params: { threadId: 'thread-current', objective: 'finish tests', status: 'active' },
    });

    await expect(h.run('/model gpt-test')).resolves.toBe(true);
    await expect(h.run('/personality pragmatic')).resolves.toBe(true);
    expect(h.workspaces.codexModelFor('chat-1')).toBe('gpt-test');
    expect(h.workspaces.codexPersonalityFor('chat-1')).toBe('pragmatic');
  });

  it('maps the remaining app-server-backed Codex commands and aliases', async () => {
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });
    h.agent.setAppServerResponse('thread/resume', {
      thread: { id: 'thread-current' },
      model: 'gpt-test',
      serviceTier: null,
    });
    h.agent.setAppServerResponse('collaborationMode/list', {
      data: [
        { name: 'Plan', mode: 'plan', model: null, reasoning_effort: 'medium' },
        { name: 'Default', mode: 'default', model: null, reasoning_effort: null },
      ],
    });
    h.agent.setAppServerResponse('experimentalFeature/list', {
      data: [{
        name: 'network_proxy',
        displayName: 'Network proxy',
        description: 'Proxy sandbox traffic',
        stage: 'beta',
        enabled: false,
      }],
    });
    h.agent.setAppServerResponse('thread/backgroundTerminals/list', {
      data: [{ processId: '42', command: 'pnpm test', cwd: h.tmp.workspace }],
    });

    await expect(h.run('/fast on')).resolves.toBe(true);
    expect(h.agent.appServerRequests.at(-1)).toMatchObject({
      method: 'thread/settings/update',
      params: { threadId: 'thread-current', serviceTier: 'fast' },
    });

    await expect(h.run('/plan')).resolves.toBe(true);
    expect(h.agent.appServerRequests.at(-1)).toMatchObject({
      method: 'thread/settings/update',
      params: {
        threadId: 'thread-current',
        collaborationMode: {
          mode: 'plan',
          settings: { model: 'gpt-test', reasoning_effort: 'medium' },
        },
      },
    });

    await expect(h.run('/memories enabled')).resolves.toBe(true);
    expect(h.agent.appServerRequests.at(-1)).toMatchObject({
      method: 'thread/memoryMode/set',
      params: { threadId: 'thread-current', mode: 'enabled' },
    });

    await expect(h.run('/debug-config')).resolves.toBe(true);
    expect(h.agent.appServerRequests.slice(-2).map((request) => request.method)).toEqual([
      'config/read',
      'configRequirements/read',
    ]);

    await expect(h.run('/experimental network_proxy on')).resolves.toBe(true);
    expect(h.agent.appServerRequests.slice(-2)).toMatchObject([
      {
        method: 'config/value/write',
        params: {
          keyPath: 'features.network_proxy',
          value: true,
          mergeStrategy: 'upsert',
        },
      },
      {
        method: 'experimentalFeature/enablement/set',
        params: { enablement: { network_proxy: true } },
      },
    ]);

    await expect(h.run('/ps')).resolves.toBe(true);
    expect(h.agent.appServerRequests.at(-1)).toMatchObject({
      method: 'thread/backgroundTerminals/list',
      params: { threadId: 'thread-current', limit: 100 },
    });
    expect(lastMarkdown(h.channel)).toContain('pnpm test');

    await expect(h.run('/clean')).resolves.toBe(true);
    expect(h.agent.appServerRequests.at(-1)).toMatchObject({
      method: 'thread/backgroundTerminals/clean',
      params: { threadId: 'thread-current' },
    });

    await expect(h.run('/delete')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('/delete confirm');
    expect(h.agent.appServerRequests.some((request) => request.method === 'thread/delete')).toBe(false);

    await expect(h.run('/delete confirm')).resolves.toBe(true);
    expect(h.agent.appServerRequests.at(-1)).toMatchObject({
      method: 'thread/delete',
      params: { threadId: 'thread-current' },
    });
  });

  it('applies the admin gate before dispatching Codex app-server commands', async () => {
    const h = await createHarness('codex');
    h.controls.botOwnerId = 'ou-owner';
    h.controls.profileConfig.access.admins = [];
    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });

    await expect(h.run('/delete confirm')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
    expect(h.agent.appServerRequests).toHaveLength(0);
  });

  it('consumes TUI-only and unknown Codex slash commands instead of sending them to the model', async () => {
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });

    await expect(h.run('/theme')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('codex --remote');
    await expect(h.run('/btw')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('codex --remote');
    await expect(h.run('/does-not-exist')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('未识别 Codex 命令');
    expect(h.agent.runOptions).toHaveLength(0);
  });
});

async function createHarness(
  agentKind: AgentKind,
  options: { bindWorkspace?: boolean; defaultWorkspace?: boolean } = {},
): Promise<Harness> {
  const tmp = await createTmpProfile(`resume-command-${agentKind}-`);
  const channel = createFakeChannel();
  const projectChats: Harness['projectChats'] = {
    chats: [],
    createCalls: 0,
    createAttempts: 0,
    getMembersCalls: [],
  };
  Object.assign(channel, {
    getChatInfo: async (chatId: string) => {
      projectChats.onGet?.();
      if (projectChats.getError) throw projectChats.getError;
      if (projectChats.getNeverResolves) await new Promise<never>(() => {});
      const chat = projectChats.chats.find((candidate) => candidate.id === chatId);
      if (!chat) throw Object.assign(new Error('chat not found'), { code: 'target_revoked' });
      return { chatId: chat.id, name: chat.name, chatType: 'group' };
    },
    getChatMembers: async (
      chatId: string,
      options: { force?: boolean; idType?: string } = {},
    ) => {
      projectChats.getMembersCalls.push({ chatId, ...options });
      projectChats.onGetMembers?.();
      if (projectChats.getMembersError) throw projectChats.getMembersError;
      if (projectChats.getMembersNeverResolves) await new Promise<never>(() => {});
      const chat = projectChats.chats.find((candidate) => candidate.id === chatId);
      if (!chat) throw Object.assign(new Error('chat not found'), { code: 'target_revoked' });
      return chat.members.map((id) => ({ id, idType: 'open_id' }));
    },
    createChat: async (input: { name: string; inviteUserIds?: string[] }) => {
      projectChats.createAttempts += 1;
      projectChats.onCreate?.();
      if (projectChats.createGate) await projectChats.createGate;
      projectChats.createCalls += 1;
      const chat = {
        id: `oc_project_${projectChats.createCalls}`,
        name: input.name,
        members: [...(input.inviteUserIds ?? [])],
      };
      projectChats.chats.push(chat);
      return { chatId: chat.id };
    },
  });
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const catalog = new SessionCatalog(join(tmp.profile, 'session-catalog.json'));
  const claudeHistory: SessionSummary[] = [];
  const codexHistory: CodexThreadHistoryEntry[] = [];
  const codexHistoryRequests: ListCodexThreadHistoryOptions[] = [];
  const activeRuns = new ActiveRuns();
  const pending = new PendingQueue(60_000, () => {});
  const agent = new FakeAgentAdapter({ id: agentKind, displayName: agentKind === 'codex' ? 'Codex CLI' : 'Claude Code' });
  const profileConfig = appConfig(agentKind);
  if (options.defaultWorkspace !== false) {
    profileConfig.workspaces.default = tmp.workspace;
  }
  const controls = {
    profile: agentKind,
    profileConfig,
    botOwnerId: 'ou-user',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(tmp.profile, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;
  if (options.bindWorkspace !== false) {
    workspaces.setCwd('chat-1', tmp.workspace);
  }
  const identity = await commandIdentity(agentKind, profileConfig, controls, tmp.workspace);
  const cardModes = new Map<string, 'p2p' | 'group' | 'topic'>();
  const chatModeCache = {
    resolve: async (_channel: unknown, chatId: string) => cardModes.get(chatId) ?? 'p2p',
  } as unknown as ChatModeCache;

  const run = (
    content: string,
    runOptions: { withCatalogIdentity?: boolean; chatMode?: 'p2p' | 'group' | 'topic' } = {},
  ): Promise<boolean> =>
    tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content),
      scope: 'chat-1',
      chatMode: runOptions.chatMode ?? 'p2p',
      sessions,
      sessionCatalog: catalog,
      sessionCatalogIdentity: runOptions.withCatalogIdentity === false ? undefined : identity,
      workspaces,
      agent,
      activeRuns,
      controls,
      claudeHistoryProvider: async () => claudeHistory,
      codexHistoryProvider: async (options) => {
        codexHistoryRequests.push(options);
        return codexHistory;
      },
    });

  const dispatchResumeArg = (
    arg: string,
    dispatchOptions: { chatId?: string; chatMode?: 'p2p' | 'group' | 'topic' } = {},
  ): Promise<void> => {
    const chatId = dispatchOptions.chatId ?? 'chat-1';
    cardModes.set(chatId, dispatchOptions.chatMode ?? 'p2p');
    return handleCardAction({
      channel: channel as unknown as Parameters<typeof handleCardAction>[0]['channel'],
      evt: cardEvent({ cmd: 'resume.use', arg }, undefined, chatId),
      sessions,
      sessionCatalog: catalog,
      workspaces,
      activeRuns,
      agent,
      controls,
      pending,
      chatModeCache,
      codexHistoryProvider: async () => codexHistory,
      claudeHistoryProvider: async () => claudeHistory,
    });
  };

  const dispatchTakeoverArg = (
    arg: string,
    dispatchOptions: { chatId?: string; chatMode?: 'p2p' | 'group' | 'topic' } = {},
  ): Promise<void> => {
    const chatId = dispatchOptions.chatId ?? 'chat-1';
    cardModes.set(chatId, dispatchOptions.chatMode ?? 'p2p');
    return handleCardAction({
      channel: channel as unknown as Parameters<typeof handleCardAction>[0]['channel'],
      evt: cardEvent({ cmd: 'resume.takeover', arg }, undefined, chatId),
      sessions,
      sessionCatalog: catalog,
      workspaces,
      activeRuns,
      agent,
      controls,
      pending,
      chatModeCache,
      codexHistoryProvider: async (options) => {
        codexHistoryRequests.push(options);
        return codexHistory;
      },
      claudeHistoryProvider: async () => claudeHistory,
    });
  };

  const dispatchLaunch = (
    profile: string,
    mode: 'new' | 'resume',
    dispatchOptions: {
      chatId?: string;
      chatMode?: 'p2p' | 'group' | 'topic';
      projectChatName?: string;
    } = {},
  ): Promise<void> => {
    const chatId = dispatchOptions.chatId ?? 'chat-1';
    cardModes.set(chatId, dispatchOptions.chatMode ?? 'p2p');
    return handleCardAction({
      channel: channel as unknown as Parameters<typeof handleCardAction>[0]['channel'],
      evt: cardEvent(
        { cmd: 'ws.launch' },
        {
          codex_profile: profile,
          launch_mode: mode,
          ...(dispatchOptions.projectChatName
            ? { project_chat_name: dispatchOptions.projectChatName }
            : {}),
        },
        chatId,
      ),
      sessions,
      sessionCatalog: catalog,
      workspaces,
      activeRuns,
      agent,
      controls,
      pending,
      chatModeCache,
      codexHistoryProvider: async (options) => {
        codexHistoryRequests.push(options);
        return codexHistory;
      },
      claudeHistoryProvider: async () => claudeHistory,
    });
  };

  const dispatchProfile = (profile: string): Promise<void> => {
    cardModes.set('chat-1', 'p2p');
    return handleCardAction({
      channel: channel as unknown as Parameters<typeof handleCardAction>[0]['channel'],
      evt: cardEvent(
        { cmd: 'profile.set' },
        { codex_profile: profile },
        'chat-1',
      ),
      sessions,
      sessionCatalog: catalog,
      workspaces,
      activeRuns,
      agent,
      controls,
      pending,
      chatModeCache,
      codexHistoryProvider: async (options) => {
        codexHistoryRequests.push(options);
        return codexHistory;
      },
      claudeHistoryProvider: async () => claudeHistory,
    });
  };

  cleanups.push(async () => {
    pending.cancelAll();
    await Promise.all([sessions.flush(), workspaces.flush(), catalog.flush()]);
    await tmp.cleanup();
  });

  return {
    tmp,
    channel,
    sessions,
    workspaces,
    catalog,
    controls,
    agent,
    identity,
    claudeHistory,
    codexHistory,
    codexHistoryRequests,
    activeRuns,
    pending,
    projectChats,
    run,
    dispatchResumeArg,
    dispatchTakeoverArg,
    dispatchLaunch,
    dispatchProfile,
  };
}

function claudeSession(
  sessionId: string,
  preview: string,
  mtime: number,
): SessionSummary {
  return {
    sessionId,
    preview,
    mtime,
    lineCount: 1,
  };
}

async function commandIdentity(
  agentKind: AgentKind,
  profileConfig: ProfileConfig,
  controls: Controls,
  cwd: string,
  codexProfile?: string,
  scopeId = 'chat-1',
): Promise<SessionCatalogIdentity> {
  const workspace = await resolveWorkingDirectory(cwd);
  if (!workspace.ok) throw new Error(workspace.userVisible);
  const capability = agentKind === 'codex' ? codexCapability(profileConfig) : claudeCapability(profileConfig);
  const access = canUseDm(profileConfig, controls, 'ou-user');
  const policy = evaluateRunPolicy({
    scope: {
      source: 'im',
      chatId: scopeId,
      actorId: 'ou-user',
    },
    attachments: [],
    prompt: '',
    requestedCwd: cwd,
    cwdRealpath: workspace.cwdRealpath,
    access,
    capability,
    profileConfig,
    now: Date.now(),
    codexHome: profileConfig.codex?.codexHome,
    inheritCodexHome: profileConfig.codex?.inheritCodexHome,
    codexProfile,
  });
  if (!policy.ok) throw new Error(policy.rejectReason.userVisible);
  return {
    scopeId,
    agentId: capability.agentId,
    cwdRealpath: workspace.cwdRealpath,
    policyFingerprint: policy.policyFingerprint,
  };
}

function appConfig(agentKind: AgentKind): ProfileConfig {
  return createDefaultProfileConfig({
    agentKind,
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-user'] },
    ...(agentKind === 'codex' ? { codex: { binaryPath: '/usr/local/bin/codex' } } : {}),
  });
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-user',
    senderName: 'User',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

function cardEvent(
  value: Record<string, unknown>,
  formValue?: Record<string, unknown>,
  chatId = 'chat-1',
): CardActionEvent {
  return {
    action: { value },
    chatId,
    messageId: 'om-card',
    operator: {
      openId: 'ou-user',
      name: 'User',
    },
    ...(formValue ? { raw: { action: { form_value: formValue } } } : {}),
  } as unknown as CardActionEvent;
}

function lastMarkdown(channel: FakeChannel): string {
  const content = channel.sent.at(-1)?.content as { markdown?: unknown } | undefined;
  expect(content?.markdown).toBeTypeOf('string');
  return content?.markdown as string;
}

function lastContent(channel: FakeChannel): Record<string, unknown> {
  const content = channel.sent.at(-1)?.content;
  expect(content).toBeTypeOf('object');
  return content as Record<string, unknown>;
}

function lastContentString(channel: FakeChannel): string {
  return JSON.stringify(lastContent(channel));
}

function resumeNonce(markdown: string): string {
  const match = markdown.match(/\/resume use ([a-f0-9-]+)/);
  const nonce = match?.[1];
  expect(nonce).toBeTypeOf('string');
  if (!nonce) throw new Error('missing resume nonce');
  return nonce;
}

function resumeArgsFromCard(card: unknown): string[] {
  const out: string[] = [];
  walkCard(card, (action) => {
    if (action?.cmd === 'resume.use' && typeof action.arg === 'string') out.push(action.arg);
  });
  return out;
}

function takeoverArgsFromCard(card: unknown): string[] {
  const out: string[] = [];
  walkCard(card, (action) => {
    if (action?.cmd === 'resume.takeover' && typeof action.arg === 'string') out.push(action.arg);
  });
  return out;
}

function walkCard(
  value: unknown,
  visitAction: (action: Record<string, unknown> | undefined) => void,
): void {
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  visitAction(record.value as Record<string, unknown> | undefined);
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) child.forEach((entry) => walkCard(entry, visitAction));
    else walkCard(child, visitAction);
  }
}

function codexThread(
  threadId: string,
  preview: string,
  updatedAtMs: number,
): CodexThreadHistoryEntry {
  return {
    threadId,
    sessionId: threadId,
    preview,
    cwd: '/tmp/workspace',
    createdAtMs: updatedAtMs - 1000,
    updatedAtMs,
    source: 'exec',
  };
}
