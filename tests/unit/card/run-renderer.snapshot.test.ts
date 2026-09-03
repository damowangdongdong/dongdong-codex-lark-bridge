import { describe, expect, it } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer.js';
import {
  initialState,
  markContinued,
  markIdleTimeout,
  markInterrupted,
  reduce,
  type RunState,
} from '../../../src/card/run-state.js';
import { renderText } from '../../../src/card/text-renderer.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import { normalizeCard } from '../../helpers/card-normalize.js';

describe('run card renderer snapshots', () => {
  it('renders initial running state', () => {
    expectCard(initialState).toMatchSnapshot();
  });

  it('renders active and completed thinking', () => {
    expectCard(stateFrom([{ type: 'thinking', delta: 'checking options' }])).toMatchSnapshot();
    expectCard(stateFrom([
      { type: 'thinking', delta: 'checking options' },
      { type: 'text', delta: 'final answer' },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();
  });

  it('renders tool running, done, and error states', () => {
    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
    ])).toMatchSnapshot();

    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();

    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/missing.ts' } },
      { type: 'tool_result', id: 'tool-2', output: 'ENOENT', isError: true },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();
  });

  it('keeps user input collapsed in the live card', () => {
    const rendered = JSON.stringify(renderCard(stateFrom([
      { type: 'user_text', content: '用户指令' },
    ])));

    expect(rendered).toContain('输入，点击查看');
    expect(rendered).toContain('"expanded":false');
  });

  it('keeps a single running tool collapsed by default', () => {
    const rendered = renderCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
    ])) as { body: { elements: Array<Record<string, unknown>> } };
    const toolPanel = rendered.body.elements.find((element) =>
      element.tag === 'collapsible_panel'
      && JSON.stringify(element).includes('Bash'),
    );

    expect(toolPanel).toMatchObject({ expanded: false });
  });

  it('collapses every contiguous tool group, including the latest running tool', () => {
    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-2', output: 'a', isError: false },
      { type: 'tool_use', id: 'tool-3', name: 'Edit', input: { file_path: '/repo/a.ts' } },
    ])).toMatchSnapshot();

    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-2', output: 'a', isError: false },
      { type: 'tool_use', id: 'tool-3', name: 'Edit', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-3', output: 'ok', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();
  });

  it('groups all retry updates into one collapsed panel', () => {
    const card = renderCard(stateFrom([
      {
        type: 'notice', level: 'retry', message: 'Retrying 1/5', attempt: 1, maxAttempts: 5,
        delaySeconds: 1,
      },
      { type: 'text', delta: 'brief progress' },
      {
        type: 'notice', level: 'retry', message: 'Retrying 2/5', attempt: 2, maxAttempts: 5,
        delaySeconds: 3,
      },
    ])) as { body: { elements: Array<Record<string, unknown>> } };
    const retryPanels = card.body.elements.filter((element) =>
      element.tag === 'collapsible_panel'
      && JSON.stringify(element).includes('Codex 正在重试'),
    );

    expect(retryPanels).toHaveLength(1);
    expect(retryPanels[0]).toMatchObject({ expanded: false });
    const rendered = JSON.stringify(retryPanels[0]);
    expect(rendered).toContain('Codex 正在重试 2/5 · 3 秒后继续 · 本 turn 已记录 2 次');
    expect(rendered).toContain('Retrying 1/5');
    expect(rendered).toContain('Retrying 2/5');
  });

  it('shows the retry count after the current turn recovers', () => {
    const card = JSON.stringify(renderCard(stateFrom([
      { type: 'notice', level: 'retry', message: 'Retrying 1/5', attempt: 1, maxAttempts: 5 },
      { type: 'notice', level: 'retry', message: 'Retrying 2/5', attempt: 2, maxAttempts: 5 },
      { type: 'notice', level: 'recovered', message: 'Codex recovered' },
    ])));

    expect(card).toContain('Codex 已恢复 · 本 turn 重试 2 次');
    expect(card).toContain('"expanded":false');
  });

  it('keeps retry aggregation scoped to one turn state', () => {
    const firstTurn = JSON.stringify(renderCard(stateFrom([
      { type: 'notice', level: 'retry', message: 'FIRST_TURN_RETRY', attempt: 1, maxAttempts: 5 },
      { type: 'notice', level: 'recovered', message: 'FIRST_TURN_RECOVERED' },
    ])));
    const secondTurn = JSON.stringify(renderCard(stateFrom([
      { type: 'notice', level: 'retry', message: 'SECOND_TURN_RETRY', attempt: 1, maxAttempts: 5 },
    ])));

    expect(firstTurn).toContain('本 turn 重试 1 次');
    expect(firstTurn).not.toContain('SECOND_TURN_RETRY');
    expect(secondTurn).toContain('本 turn 已记录 1 次');
    expect(secondTurn).not.toContain('FIRST_TURN_RETRY');
  });

  it('renders done, error, interrupted, and idle-timeout terminal states', () => {
    expectCard(stateFrom([{ type: 'done', terminationReason: 'normal' }])).toMatchSnapshot();
    expectCard(stateFrom([{ type: 'error', message: 'process failed', terminationReason: 'failed' }])).toMatchSnapshot();
    expectCard(markInterrupted(stateFrom([{ type: 'text', delta: 'partial' }]))).toMatchSnapshot();
    expectCard(markIdleTimeout(stateFrom([{ type: 'text', delta: 'partial' }]), 15)).toMatchSnapshot();
  });

  it('marks a frozen progress segment as continued below', () => {
    const continued = markContinued(stateFrom([{ type: 'text', delta: 'earlier progress' }]));
    const card = JSON.stringify(renderCard(continued));

    expect(card).toContain('earlier progress');
    expect(card).toContain('已在下方接续');
    expect(card).toContain('"streaming_mode":false');
  });

  it('renders markdown text mode without card-only controls', () => {
    const state = stateFrom([
      { type: 'thinking', delta: 'hidden reasoning' },
      { type: 'text', delta: 'Answer' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'text', delta: 'Done' },
    ]);

    expect(renderText(state)).toMatchSnapshot();
    expect(renderText(markInterrupted(state))).toMatchSnapshot();
    expect(renderText(markIdleTimeout(state, 10))).toMatchSnapshot();
    expect(renderText(stateFrom([{ type: 'error', message: 'process failed', terminationReason: 'failed' }]))).toMatchSnapshot();
  });

  it('does not render live action buttons', () => {
    const card = renderCard(initialState) as {
      body?: { elements?: Array<Record<string, unknown>> };
    };
    const rendered = JSON.stringify(card);
    expect(card.body?.elements?.some((element) => element.tag === 'button')).toBe(false);
    expect(rendered).not.toContain('立即插入');
    expect(rendered).not.toContain('排队');
    expect(rendered).not.toContain('终止');
  });

  it('keeps local paths in user-visible cards and text fallbacks', () => {
    const sensitivePath = '/Users/example/private/customer/repo/secret.txt';
    const state = stateFrom([
      { type: 'text', delta: `I read ${sensitivePath}` },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: sensitivePath } },
      { type: 'tool_result', id: 'tool-1', output: `content from ${sensitivePath}`, isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]);

    const card = JSON.stringify(renderCard(state));
    const text = renderText(state);
    expect(card).toContain(sensitivePath);
    expect(text).toContain(sensitivePath);
  });
});

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce((state, event) => reduce(state, event), initialState);
}

function expectCard(state: RunState) {
  return expect(normalizeCard(renderCard(state)));
}
