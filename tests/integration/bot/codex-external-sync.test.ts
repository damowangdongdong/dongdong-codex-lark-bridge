import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentExternalRun, AgentRun } from '../../../src/agent/types.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { renderExternalCodexRun } from '../../../src/bot/channel.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import { createFakeChannel } from '../../helpers/fake-channel.js';

describe('attached Codex terminal synchronization', () => {
  it('renders terminal input and output, sends full trace pages, and releases the scope', async () => {
    const channel = createFakeChannel();
    const activeRuns = new ActiveRuns();
    const flushed = vi.fn();
    const pending = new PendingQueue(1, flushed);
    const external: AgentExternalRun = {
      binding: {
        scopeId: 'chat-1',
        chatId: 'chat-1',
        threadId: 'thread-1',
        operatorOpenId: 'ou-user',
        profile: 'freerouter',
        cwd: '/repo',
        sandbox: 'workspace-write',
      },
      run: runFrom([
        { type: 'system', threadId: 'thread-1', cwd: '/repo' },
        { type: 'user_text', content: 'typed in attached terminal' },
        { type: 'thinking', delta: 'terminal reasoning' },
        { type: 'text', delta: 'terminal commentary' },
        { type: 'tool_use', id: 'tool-1', name: 'shell', input: { command: 'pwd' } },
        { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
        { type: 'final_text', content: 'terminal final answer' },
        { type: 'done', threadId: 'thread-1', terminationReason: 'normal' },
      ]),
    };

    await renderExternalCodexRun({
      channel: channel as never,
      external,
      activeRuns,
      pending,
      activePolicyFingerprints: new Map(),
    });

    expect(activeRuns.get('chat-1')).toBeUndefined();
    const liveCards = JSON.stringify(channel.streams[0]?.cardUpdates);
    expect(liveCards).toContain('typed in attached terminal');
    const traceCards = JSON.stringify(channel.sent.map((entry) => entry.content));
    expect(traceCards).toContain('Codex 完整轨迹');
    expect(traceCards).toContain('terminal final answer');
    expect(traceCards).toContain('Terminal input');
    expect(traceCards).toContain('typed in attached terminal');
    expect(traceCards).toContain('terminal reasoning');
    expect(traceCards).toContain('terminal commentary');
    expect(traceCards).toContain('shell · output');

    pending.push('chat-1', message());
    await vi.waitFor(() => expect(flushed).toHaveBeenCalledOnce());
    pending.cancelAll();
  });
});

function runFrom(events: AgentEvent[]): AgentRun {
  return {
    runId: 'codex-remote:turn-1',
    events: (async function* () {
      yield* events;
    })(),
    async stop() {},
    async waitForExit() {
      return true;
    },
  };
}

function message() {
  return {
    messageId: 'om-queued',
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-user',
    senderName: 'User',
    content: 'queued',
    resources: [],
    mentionedBot: false,
  } as never;
}
