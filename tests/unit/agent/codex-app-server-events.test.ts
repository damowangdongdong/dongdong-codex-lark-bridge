import { describe, expect, it } from 'vitest';
import { CodexAppServerEventTranslator } from '../../../src/agent/codex/app-server-events.js';

describe('Codex app-server event translator', () => {
  it('keeps commentary, reasoning, commands, output, final text, usage, and completion distinct', () => {
    const translator = new CodexAppServerEventTranslator('thread-1');
    translator.setTurnId('turn-1');

    expect(
      translateAll(translator, [
        notification('item/started', {
          item: { id: 'commentary', type: 'agentMessage', phase: 'commentary' },
        }),
        notification('item/agentMessage/delta', { itemId: 'commentary', delta: 'Checking. ' }),
        notification('item/completed', {
          item: {
            id: 'commentary',
            type: 'agentMessage',
            phase: 'commentary',
            text: 'Checking. Done.',
          },
        }),
        notification('item/reasoning/summaryTextDelta', { itemId: 'reasoning', delta: 'Reason' }),
        notification('item/started', {
          item: { id: 'command', type: 'commandExecution', command: 'pnpm test', cwd: '/repo' },
        }),
        notification('item/commandExecution/outputDelta', { itemId: 'command', delta: 'PASS\n' }),
        notification('item/completed', {
          item: {
            id: 'command',
            type: 'commandExecution',
            command: 'pnpm test',
            cwd: '/repo',
            aggregatedOutput: 'PASS\n',
            exitCode: 0,
          },
        }),
        notification('item/completed', {
          item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Finished.' },
        }),
        notification('thread/tokenUsage/updated', {
          tokenUsage: {
            last: {
              inputTokens: 12,
              outputTokens: 7,
              cachedInputTokens: 3,
              reasoningOutputTokens: 2,
            },
          },
        }),
        notification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } }),
      ]),
    ).toEqual([
      { type: 'text', delta: 'Checking. ' },
      { type: 'text', delta: 'Done.' },
      { type: 'thinking', delta: 'Reason' },
      {
        type: 'tool_use',
        id: 'command',
        name: 'command_execution',
        input: { command: 'pnpm test', cwd: '/repo' },
      },
      { type: 'tool_progress', id: 'command', delta: 'PASS\n' },
      { type: 'tool_result', id: 'command', output: 'PASS\n', isError: false },
      { type: 'final_text', content: 'Finished.' },
      {
        type: 'usage',
        inputTokens: 12,
        outputTokens: 7,
        cachedInputTokens: 3,
        reasoningOutputTokens: 2,
      },
      { type: 'done', threadId: 'thread-1', terminationReason: 'normal' },
    ]);
  });

  it('surfaces a failed turn once and ignores other threads', () => {
    const translator = new CodexAppServerEventTranslator('thread-1');
    translator.setTurnId('turn-1');

    expect(
      translateAll(translator, [
        notification('item/agentMessage/delta', { threadId: 'thread-2', itemId: 'x', delta: 'wrong' }),
        notification('turn/completed', {
          turn: { id: 'turn-1', status: 'failed', error: { message: 'provider unavailable' } },
        }),
        notification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } }),
      ]),
    ).toEqual([
      { type: 'error', message: 'provider unavailable', terminationReason: 'failed' },
    ]);
  });

  it('keeps every Codex 0.151 display item and MCP progress in the trace', () => {
    const translator = new CodexAppServerEventTranslator('thread-1');
    translator.setTurnId('turn-1');

    expect(
      translateAll(translator, [
        notification('item/started', {
          item: {
            id: 'hook',
            type: 'hookPrompt',
            fragments: [{ text: 'Run the formatter', hookRunId: 'hook-run-1' }],
          },
        }),
        notification('item/completed', {
          item: {
            id: 'hook',
            type: 'hookPrompt',
            fragments: [{ text: 'Run the formatter', hookRunId: 'hook-run-1' }],
          },
        }),
        notification('item/started', {
          item: {
            id: 'function-output',
            type: 'functionCallOutput',
            namespace: 'tools',
            name: 'lookup',
            output: [{ type: 'input_text', text: 'found it' }],
          },
        }),
        notification('item/completed', {
          item: {
            id: 'function-output',
            type: 'functionCallOutput',
            namespace: 'tools',
            name: 'lookup',
            output: [{ type: 'input_text', text: 'found it' }],
          },
        }),
        notification('item/started', {
          item: {
            id: 'mcp',
            type: 'mcpToolCall',
            server: 'docs',
            tool: 'search',
            arguments: { query: 'Codex' },
          },
        }),
        notification('item/mcpToolCall/progress', { itemId: 'mcp', message: 'Searching' }),
        notification('item/completed', {
          item: {
            id: 'mcp',
            type: 'mcpToolCall',
            server: 'docs',
            tool: 'search',
            status: 'completed',
            result: { content: [{ type: 'text', text: 'result' }] },
          },
        }),
        notification('item/started', {
          item: {
            id: 'subagent',
            type: 'subAgentActivity',
            kind: 'started',
            agentThreadId: 'agent-thread',
            agentPath: '/root/reviewer',
          },
        }),
        notification('item/completed', {
          item: {
            id: 'subagent',
            type: 'subAgentActivity',
            kind: 'completed',
            agentThreadId: 'agent-thread',
            agentPath: '/root/reviewer',
          },
        }),
        notification('item/started', {
          item: { id: 'sleep', type: 'sleep', durationMs: 250 },
        }),
        notification('item/completed', {
          item: { id: 'sleep', type: 'sleep', durationMs: 250 },
        }),
        notification('item/started', {
          item: { id: 'review-in', type: 'enteredReviewMode', review: 'Review this patch' },
        }),
        notification('item/completed', {
          item: { id: 'review-in', type: 'enteredReviewMode', review: 'Review this patch' },
        }),
        notification('item/started', {
          item: { id: 'review-out', type: 'exitedReviewMode', review: '' },
        }),
        notification('item/completed', {
          item: { id: 'review-out', type: 'exitedReviewMode', review: 'No findings.' },
        }),
      ]),
    ).toEqual([
      {
        type: 'tool_use',
        id: 'hook',
        name: 'hook_prompt',
        input: [{ text: 'Run the formatter', hookRunId: 'hook-run-1' }],
      },
      { type: 'tool_result', id: 'hook', output: 'Run the formatter', isError: false },
      { type: 'tool_use', id: 'function-output', name: 'function.tools.lookup', input: {} },
      { type: 'tool_result', id: 'function-output', output: 'found it', isError: false },
      {
        type: 'tool_use',
        id: 'mcp',
        name: 'docs.search',
        input: { query: 'Codex' },
      },
      { type: 'tool_progress', id: 'mcp', delta: 'Searching\n' },
      {
        type: 'tool_result',
        id: 'mcp',
        output: JSON.stringify({ content: [{ type: 'text', text: 'result' }] }, null, 2),
        isError: false,
      },
      {
        type: 'tool_use',
        id: 'subagent',
        name: 'agent.started',
        input: { threadId: 'agent-thread', path: '/root/reviewer' },
      },
      {
        type: 'tool_result',
        id: 'subagent',
        output: JSON.stringify({
          id: 'subagent',
          type: 'subAgentActivity',
          kind: 'completed',
          agentThreadId: 'agent-thread',
          agentPath: '/root/reviewer',
        }, null, 2),
        isError: false,
      },
      { type: 'tool_use', id: 'sleep', name: 'clock.sleep', input: { durationMs: 250 } },
      {
        type: 'tool_result',
        id: 'sleep',
        output: JSON.stringify({ id: 'sleep', type: 'sleep', durationMs: 250 }, null, 2),
        isError: false,
      },
      {
        type: 'tool_use',
        id: 'review-in',
        name: 'review.entered',
        input: { review: 'Review this patch' },
      },
      { type: 'tool_result', id: 'review-in', output: 'Review this patch', isError: false },
      { type: 'tool_use', id: 'review-out', name: 'review.exited', input: {} },
      { type: 'tool_result', id: 'review-out', output: 'No findings.', isError: false },
    ]);
  });

  it('uses completed plan and reasoning items when deltas are absent or differ', () => {
    const translator = new CodexAppServerEventTranslator('thread-1');
    translator.setTurnId('turn-1');

    expect(
      translateAll(translator, [
        notification('item/started', { item: { id: 'reason', type: 'reasoning', summary: [], content: [] } }),
        notification('item/completed', {
          item: { id: 'reason', type: 'reasoning', summary: ['Inspect tests'], content: ['Then patch'] },
        }),
        notification('item/started', { item: { id: 'plan', type: 'plan', text: '' } }),
        notification('item/plan/delta', { itemId: 'plan', delta: 'Old plan' }),
        notification('item/completed', {
          item: { id: 'plan', type: 'plan', text: 'Revised plan' },
        }),
      ]),
    ).toEqual([
      { type: 'thinking', delta: 'Inspect tests\nThen patch' },
      { type: 'thinking', delta: 'Old plan' },
      { type: 'thinking', delta: '\n\nFinal plan:\nRevised plan' },
    ]);
  });
});

function notification(method: string, params: Record<string, unknown>) {
  return {
    method,
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      ...params,
    },
  };
}

function translateAll(
  translator: CodexAppServerEventTranslator,
  notifications: Array<{ method: string; params: Record<string, unknown> }>,
) {
  return notifications.flatMap((entry) => translator.translate(entry));
}
