import { describe, expect, it } from 'vitest';
import { renderCodexHistoryCards, renderRunTraceCards } from '../../../src/card/codex-trace.js';
import { initialState, reduce, type RunState } from '../../../src/card/run-state.js';
import type { AgentEvent } from '../../../src/agent/types.js';

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
    expect(rendered).toContain('Terminal input');
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
  it('renders user, commentary, reasoning, command output, and final answer across readable pages', () => {
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
    expect(rendered).toContain('considering options');
    expect(rendered).toContain('working update');
    expect(rendered).toContain('/repo');
    expect(rendered).toContain('answer-');
    expect(rendered).toContain('-end');
    expect(rendered).toContain('thread-history');
  });
});

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce((state, event) => reduce(state, event), initialState);
}
