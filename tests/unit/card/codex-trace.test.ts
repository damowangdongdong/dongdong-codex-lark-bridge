import { describe, expect, it } from 'vitest';
import { renderCodexHistoryCards, renderRunTraceCards } from '../../../src/card/codex-trace.js';
import { initialState, reduce, type RunState } from '../../../src/card/run-state.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import { buildAgentPrompt } from '../../../src/agent/prompt.js';
import { prefixBridgeSystemPrompt } from '../../../src/agent/bridge-system-prompt.js';

describe('Codex trace cards', () => {
  it('keeps distinct reasoning, terminal input, commentary, tool input, and tool output sections', () => {
    const state = stateFrom([
      { type: 'system', threadId: 'thread-1' },
      { type: 'thinking', delta: 'reasoning detail' },
      { type: 'user_text', content: 'typed in terminal' },
      { type: 'text', delta: 'commentary detail' },
      { type: 'tool_use', id: 'tool-1', name: 'shell', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'usage', inputTokens: 10, outputTokens: 4, cachedInputTokens: 2, reasoningOutputTokens: 1 },
      { type: 'done', threadId: 'thread-1', terminationReason: 'normal' },
    ]);

    const rendered = JSON.stringify(renderRunTraceCards(state, {
      profile: 'freerouter',
      sandbox: 'danger-full-access',
    }));

    expect(rendered).toContain('Reasoning');
    expect(rendered).toContain('User input');
    expect(rendered).toContain('Commentary');
    expect(rendered).toContain('shell · input');
    expect(rendered).toContain('shell · output');
    expect(rendered).toContain('reasoning detail');
    expect(rendered).toContain('typed in terminal');
    expect(rendered).toContain('commentary detail');
    expect(rendered).toContain('/repo');
    expect(rendered).toContain('Token usage');
    expect(rendered).toContain('--profile freerouter');
    expect(rendered).toContain('thread-1');
    expect(rendered).toContain('"expanded":false');
  });

  it('hides bridge metadata from live and resumed user-input sections', () => {
    const wrapped = prefixBridgeSystemPrompt(buildAgentPrompt({
      context: {
        chatId: 'oc_internal',
        chatType: 'group',
        senderId: 'ou_internal',
        source: 'im',
      },
      instructions: ['内部指令'],
      userInput: '只展示这句',
    }), { openId: 'ou_bot_internal', name: 'Bridge' });
    const live = JSON.stringify(renderRunTraceCards(stateFrom([
      { type: 'user_text', content: wrapped },
      { type: 'done', terminationReason: 'normal' },
    ]), { sandbox: 'danger-full-access' }));
    const history = JSON.stringify(renderCodexHistoryCards({
      thread: {
        id: 'thread-wrapped',
        turns: [{
          status: 'completed',
          items: [{ type: 'userMessage', content: [{ type: 'input_text', text: wrapped }] }],
        }],
      },
    }, '/repo'));

    expect(live).toContain('只展示这句');
    expect(history).toContain('只展示这句');
    expect(live).not.toContain('bridge_instructions');
    expect(history).not.toContain('bridge_instructions');
    expect(live).not.toContain('bridge_context');
    expect(history).not.toContain('bridge_context');
    expect(live).not.toContain('lark-channel-bridge 运行约定');
    expect(history).not.toContain('lark-channel-bridge 运行约定');
    expect(live).not.toContain('LARK_CHANNEL');
    expect(history).not.toContain('LARK_CHANNEL');
    expect(live).not.toContain('user_input');
    expect(history).not.toContain('user_input');
  });

  it('omits internal-only context messages from resumed history', () => {
    const history = JSON.stringify(renderCodexHistoryCards({
      thread: {
        id: 'thread-internal-context',
        turns: [{
          status: 'completed',
          items: [
            {
              type: 'userMessage',
              content: [{ type: 'input_text', text: '<environment_context>\nsecret cwd\n</environment_context>' }],
            },
            {
              type: 'userMessage',
              content: [{ type: 'input_text', text: '<codex_internal_context>\nsecret objective\n</codex_internal_context>' }],
            },
            { type: 'agentMessage', phase: 'final_answer', text: 'visible answer' },
          ],
        }],
      },
    }, '/repo'));

    expect(history).toContain('visible answer');
    expect(history).not.toContain('secret cwd');
    expect(history).not.toContain('secret objective');
    expect(history).not.toContain('environment_context');
    expect(history).not.toContain('codex_internal_context');
  });

  it('redacts embedded bridge prompts without treating quoted input as the current user message', () => {
    const wrapped = prefixBridgeSystemPrompt(buildAgentPrompt({
      context: {
        chatId: 'oc_quoted',
        chatType: 'group',
        senderId: 'ou_quoted',
        source: 'im',
      },
      instructions: ['内部指令'],
      userInput: '旧卡片中的问题',
    }), { openId: 'ou_bot_quoted', name: 'Bridge' });
    const quoted = `引用卡片开始\n${wrapped}\n旧卡片回答\n现在仍然出现运行约定`;
    const history = JSON.stringify(renderCodexHistoryCards({
      thread: {
        id: 'thread-quoted',
        turns: [{
          status: 'completed',
          items: [
            { type: 'userMessage', content: [{ type: 'input_text', text: quoted }] },
            { type: 'commandExecution', command: 'show-card', aggregatedOutput: `before\n${wrapped}\nafter` },
            { type: 'agentMessage', phase: 'final_answer', text: `before\n${wrapped}\nafter` },
          ],
        }],
      },
    }, '/repo'));

    expect(history).toContain('引用卡片开始');
    expect(history).toContain('旧卡片回答');
    expect(history).toContain('现在仍然出现运行约定');
    expect(history).toContain('旧卡片中的问题');
    expect(history).toContain('before');
    expect(history).toContain('after');
    expect(history).not.toContain('show-card');
    expect(history).not.toContain('lark-channel-bridge 运行约定');
    expect(history).not.toContain('bridge_context');
    expect(history).not.toContain('bridge_instructions');
  });

  it('paginates long tool output without dropping its beginning or end', () => {
    const early = `EARLY-${'a'.repeat(15_000)}`;
    const late = `${'z'.repeat(15_000)}-LATE`;
    const state = stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'long-command', input: { command: 'run' } },
      { type: 'tool_result', id: 'tool-1', output: `${early}${late}`, isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]);

    const cards = renderRunTraceCards(state, { sandbox: 'workspace-write' });
    const rendered = JSON.stringify(cards);

    expect(cards.length).toBeGreaterThan(1);
    expect(rendered).toContain('EARLY-');
    expect(rendered).toContain('-LATE');
    expect(rendered).toContain('a'.repeat(2_000));
    expect(rendered).toContain('z'.repeat(2_000));
  });

  it('uses the existing Feishu-safe email rendering for trace content', () => {
    const state = stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'git', input: { command: 'show' } },
      { type: 'tool_result', id: 'tool-1', output: 'Author <person@example.com>', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]);

    const rendered = JSON.stringify(renderRunTraceCards(state, { sandbox: 'read-only' }));
    expect(rendered).toContain('person[at]example.com');
    expect(rendered).not.toContain('person@example.com');
  });
});

describe('Codex resumed-history cards', () => {
  it('uses cleaned user input for wrapped thread names and previews', () => {
    const wrappedName = prefixBridgeSystemPrompt(buildAgentPrompt({
      context: {
        chatId: 'oc_internal',
        chatType: 'group',
        senderId: 'ou_internal',
        source: 'im',
      },
      instructions: ['internal bridge instruction'],
      userInput: '真实历史标题',
    }), { openId: 'ou_bot_internal', name: 'Bridge' });
    const wrappedPreview = prefixBridgeSystemPrompt(buildAgentPrompt({
      context: {
        chatId: 'oc_preview',
        chatType: 'p2p',
        senderId: 'ou_preview',
        source: 'im',
      },
      instructions: ['preview bridge instruction'],
      userInput: '真实历史预览',
    }), { openId: 'ou_bot_preview', name: 'Bridge' });

    const named = JSON.stringify(renderCodexHistoryCards({
      thread: { id: 'thread-named', name: wrappedName, preview: wrappedPreview, turns: [] },
    }, '/repo'));
    const previewOnly = JSON.stringify(renderCodexHistoryCards({
      thread: { id: 'thread-preview', name: '   ', preview: wrappedPreview, turns: [] },
    }, '/repo'));

    expect(named).toContain('真实历史标题');
    expect(named).not.toContain('真实历史预览');
    expect(previewOnly).toContain('真实历史预览');
    for (const rendered of [named, previewOnly]) {
      expect(rendered).not.toContain('# lark-channel-bridge 运行约定');
      expect(rendered).not.toContain('你正在 lark-channel-bridge 里跑');
      expect(rendered).not.toContain('bridge_context');
      expect(rendered).not.toContain('bridge_instructions');
    }
  });

  it('renders the conversation without duplicating internal execution trace items', () => {
    const result = {
      thread: {
        id: 'thread-history',
        name: 'History example',
        turns: [
          {
            status: 'completed',
            items: [
              { type: 'userMessage', content: [{ type: 'input_text', text: 'original question' }] },
              { type: 'reasoning', summary: ['considering options'] },
              { type: 'agentMessage', phase: 'commentary', text: 'working update' },
              { type: 'commandExecution', command: 'pwd', aggregatedOutput: '/repo' },
              { type: 'agentMessage', phase: 'final_answer', text: `answer-${'x'.repeat(14_000)}-end` },
            ],
          },
        ],
      },
    };

    const cards = renderCodexHistoryCards(result, '/repo');
    const rendered = JSON.stringify(cards);

    expect(cards.length).toBeGreaterThan(1);
    expect(rendered).toContain('original question');
    expect(rendered).toContain('answer-');
    expect(rendered).toContain('-end');
    expect(rendered).not.toContain('considering options');
    expect(rendered).not.toContain('working update');
    expect(rendered).not.toContain('🛠 Command');
    expect(rendered).toContain('thread-history');
    expect(rendered).toContain('"expanded":false');
    for (const card of cards) {
      const body = (card as { body: { elements: Array<Record<string, unknown>> } }).body;
      const outer = body.elements[2] as {
        tag?: string;
        expanded?: boolean;
        header?: unknown;
        elements?: unknown[];
      };
      expect(outer.tag).toBe('collapsible_panel');
      expect(outer.expanded).toBe(false);
      expect(JSON.stringify(outer.header)).toContain('完整历史对话');
      expect(JSON.stringify(outer.elements)).toContain('collapsible_panel');
    }
  });

  it('keeps the last assistant update when an interrupted turn has no final answer', () => {
    const rendered = JSON.stringify(renderCodexHistoryCards({
      thread: {
        id: 'thread-interrupted',
        turns: [{
          status: 'interrupted',
          items: [
            { type: 'userMessage', content: [{ type: 'input_text', text: '开始任务' }] },
            { type: 'agentMessage', phase: 'commentary', text: '较早进度' },
            { type: 'commandExecution', command: 'work', aggregatedOutput: 'internal output' },
            { type: 'agentMessage', phase: 'commentary', text: '中断前最后进度' },
          ],
        }],
      },
    }, '/repo'));

    expect(rendered).toContain('开始任务');
    expect(rendered).toContain('中断前最后进度');
    expect(rendered).not.toContain('较早进度');
    expect(rendered).not.toContain('internal output');
  });

  it('keeps retry and capacity errors visible in the full trace', () => {
    const state = stateFrom([
      {
        type: 'notice',
        level: 'retry',
        message: 'selected model is at capacity. Retrying 2/5 (3s)',
        attempt: 2,
        maxAttempts: 5,
        delaySeconds: 3,
      },
      { type: 'notice', level: 'recovered', message: 'Codex connection recovered.' },
      { type: 'done', terminationReason: 'normal' },
    ]);

    const rendered = JSON.stringify(renderRunTraceCards(state, { sandbox: 'workspace-write' }));
    expect(rendered).toContain('selected model is at capacity');
    expect(rendered).toContain('Codex retry 2/5');
    expect(rendered).toContain('等待 3 秒后重试');
    expect(rendered).toContain('Codex recovered');
  });
});

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce((state, event) => reduce(state, event), initialState);
}
