import type { AgentEvent } from '../types';
import type { RpcNotification } from './app-server-client';

interface ItemState {
  type: string;
  phase?: string;
  emittedText: string;
}

/** Translate one app-server thread/turn into the bridge's complete step stream. */
export class CodexAppServerEventTranslator {
  private readonly threadId: string;
  private turnId: string | undefined;
  private readonly items = new Map<string, ItemState>();
  private latestUsage: AgentEvent | undefined;
  private terminal = false;

  constructor(threadId: string) {
    this.threadId = threadId;
  }

  setTurnId(turnId: string): void {
    this.turnId = turnId;
  }

  translate(notification: RpcNotification): AgentEvent[] {
    if (this.terminal) return [];
    const params = recordValue(notification.params);
    if (!params || stringValue(params.threadId) !== this.threadId) return [];
    const notificationTurnId = stringValue(params.turnId) ?? stringValue(recordValue(params.turn)?.id);
    if (this.turnId && notificationTurnId && notificationTurnId !== this.turnId) return [];

    switch (notification.method) {
      case 'turn/started':
        if (notificationTurnId) this.turnId = notificationTurnId;
        return [];
      case 'item/started':
        return this.itemStarted(recordValue(params.item));
      case 'item/agentMessage/delta':
        return this.agentMessageDelta(params);
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        return this.thinkingDelta(params, 'reasoning');
      case 'item/plan/delta':
        return this.thinkingDelta(params, 'plan');
      case 'item/commandExecution/outputDelta': {
        const id = stringValue(params.itemId);
        const delta = stringValue(params.delta);
        return id && delta ? [{ type: 'tool_progress', id, delta }] : [];
      }
      case 'item/mcpToolCall/progress': {
        const id = stringValue(params.itemId);
        const message = stringValue(params.message);
        return id && message ? [{ type: 'tool_progress', id, delta: `${message}\n` }] : [];
      }
      case 'item/completed':
        return this.itemCompleted(recordValue(params.item));
      case 'thread/tokenUsage/updated':
        this.captureUsage(params);
        return [];
      case 'error': {
        const message = errorMessage(params, 'Codex app-server error');
        return [{ type: 'text', delta: `\n⚠️ ${message}\n` }];
      }
      case 'turn/completed':
        return this.turnCompleted(recordValue(params.turn));
      default:
        return [];
    }
  }

  fail(message: string): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    return [{ type: 'error', message, terminationReason: 'failed' }];
  }

  interrupt(): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    return [{ type: 'done', threadId: this.threadId, terminationReason: 'interrupted' }];
  }

  private itemStarted(item: Record<string, unknown> | undefined): AgentEvent[] {
    if (!item) return [];
    const id = stringValue(item.id);
    const type = stringValue(item.type);
    if (!id || !type) return [];
    const initialText = itemThinkingText(item);
    this.items.set(id, {
      type,
      phase: stringValue(item.phase),
      emittedText: type === 'userMessage' ? userMessageText(item) : initialText,
    });
    if (type === 'userMessage') {
      const content = userMessageText(item);
      return content ? [{ type: 'user_text', content }] : [];
    }
    if (initialText) return [{ type: 'thinking', delta: initialText }];
    const tool = toolStart(item);
    return tool ? [{ type: 'tool_use', id, name: tool.name, input: tool.input }] : [];
  }

  private thinkingDelta(
    params: Record<string, unknown>,
    type: 'reasoning' | 'plan',
  ): AgentEvent[] {
    const id = stringValue(params.itemId);
    const delta = stringValue(params.delta);
    if (!id || !delta) return [];
    const state = this.items.get(id) ?? { type, emittedText: '' };
    state.emittedText += delta;
    this.items.set(id, state);
    return [{ type: 'thinking', delta }];
  }

  private agentMessageDelta(params: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(params.itemId);
    const delta = stringValue(params.delta);
    if (!id || !delta) return [];
    const state = this.items.get(id) ?? {
      type: 'agentMessage',
      emittedText: '',
    };
    state.emittedText += delta;
    this.items.set(id, state);
    return state.phase === 'commentary' ? [{ type: 'text', delta }] : [];
  }

  private itemCompleted(item: Record<string, unknown> | undefined): AgentEvent[] {
    if (!item) return [];
    const id = stringValue(item.id);
    const type = stringValue(item.type);
    if (!id || !type) return [];
    const previous = this.items.get(id);
    this.items.delete(id);
    if (type === 'agentMessage') {
      const text = stringValue(item.text) ?? previous?.emittedText ?? '';
      const phase = stringValue(item.phase) ?? previous?.phase;
      if (!text) return [];
      if (phase === 'commentary') {
        const emitted = previous?.emittedText ?? '';
        const tail = text.startsWith(emitted) ? text.slice(emitted.length) : text;
        return tail ? [{ type: 'text', delta: tail }] : [];
      }
      return [{ type: 'final_text', content: text }];
    }
    if (type === 'userMessage') {
      const content = userMessageText(item);
      return content && content !== previous?.emittedText
        ? [{ type: 'user_text', content }]
        : [];
    }
    if (type === 'plan' || type === 'reasoning') {
      return completedThinkingEvents(
        itemThinkingText(item),
        previous?.emittedText ?? '',
        type === 'plan' ? 'Final plan' : 'Final reasoning',
      );
    }
    const result = toolResult(item);
    return result
      ? [{ type: 'tool_result', id, output: result.output, isError: result.isError }]
      : [];
  }

  private captureUsage(params: Record<string, unknown>): void {
    const usage = recordValue(recordValue(params.tokenUsage)?.last);
    if (!usage) return;
    this.latestUsage = {
      type: 'usage',
      inputTokens: numberValue(usage.inputTokens),
      outputTokens: numberValue(usage.outputTokens),
      cachedInputTokens: numberValue(usage.cachedInputTokens),
      reasoningOutputTokens: numberValue(usage.reasoningOutputTokens),
    };
  }

  private turnCompleted(turn: Record<string, unknown> | undefined): AgentEvent[] {
    if (!turn) return [];
    this.terminal = true;
    const status = stringValue(turn.status);
    const events: AgentEvent[] = [];
    if (this.latestUsage) events.push(this.latestUsage);
    if (status === 'failed') {
      const error = recordValue(turn.error);
      events.push({
        type: 'error',
        message: errorMessage(error, 'Codex turn failed'),
        terminationReason: 'failed',
      });
      return events;
    }
    events.push({
      type: 'done',
      threadId: this.threadId,
      terminationReason: status === 'interrupted' ? 'interrupted' : 'normal',
    });
    return events;
  }
}

function userMessageText(item: Record<string, unknown>): string {
  if (typeof item.text === 'string') return item.text;
  if (!Array.isArray(item.content)) return '';
  return item.content
    .map((part) => recordValue(part))
    .map((part) => part && typeof part.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n');
}

function itemThinkingText(item: Record<string, unknown>): string {
  const type = stringValue(item.type);
  if (type === 'plan') return stringValue(item.text) ?? '';
  if (type !== 'reasoning') return '';
  return [item.summary, item.content]
    .flatMap((value) => Array.isArray(value) ? value : [])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n');
}

function completedThinkingEvents(
  completed: string,
  emitted: string,
  label: string,
): AgentEvent[] {
  if (!completed || completed === emitted) return [];
  if (!emitted) return [{ type: 'thinking', delta: completed }];
  if (completed.startsWith(emitted)) {
    const tail = completed.slice(emitted.length);
    return tail ? [{ type: 'thinking', delta: tail }] : [];
  }
  return [{ type: 'thinking', delta: `\n\n${label}:\n${completed}` }];
}

function toolStart(item: Record<string, unknown>): { name: string; input: unknown } | undefined {
  const type = stringValue(item.type);
  switch (type) {
    case 'hookPrompt':
      return { name: 'hook_prompt', input: item.fragments ?? [] };
    case 'functionCallOutput':
      return {
        name: ['function', stringValue(item.namespace), stringValue(item.name)]
          .filter(Boolean)
          .join('.'),
        input: {},
      };
    case 'commandExecution':
      return {
        name: 'command_execution',
        input: { command: stringValue(item.command) ?? '', cwd: stringValue(item.cwd) ?? '' },
      };
    case 'fileChange':
      return { name: 'file_change', input: item.changes ?? [] };
    case 'mcpToolCall':
      return {
        name: `${stringValue(item.server) ?? 'mcp'}.${stringValue(item.tool) ?? 'tool'}`,
        input: item.arguments ?? {},
      };
    case 'dynamicToolCall':
      return {
        name: [stringValue(item.namespace), stringValue(item.tool)].filter(Boolean).join('.') || 'tool',
        input: item.arguments ?? {},
      };
    case 'collabAgentToolCall':
      return { name: `agent.${stringValue(item.tool) ?? 'activity'}`, input: item };
    case 'subAgentActivity':
      return {
        name: `agent.${stringValue(item.kind) ?? 'activity'}`,
        input: {
          threadId: stringValue(item.agentThreadId) ?? '',
          path: stringValue(item.agentPath) ?? '',
        },
      };
    case 'webSearch':
      return { name: 'web_search', input: item };
    case 'imageView':
      return { name: 'view_image', input: { path: item.path } };
    case 'sleep':
      return { name: 'clock.sleep', input: { durationMs: item.durationMs } };
    case 'imageGeneration':
      return { name: 'image_generation', input: item };
    case 'enteredReviewMode':
      return { name: 'review.entered', input: { review: stringValue(item.review) ?? '' } };
    case 'exitedReviewMode':
      return { name: 'review.exited', input: {} };
    case 'contextCompaction':
      return { name: 'context_compaction', input: {} };
    default:
      return undefined;
  }
}

function toolResult(item: Record<string, unknown>): { output: string; isError: boolean } | undefined {
  const type = stringValue(item.type);
  switch (type) {
    case 'hookPrompt':
      return { output: hookPromptText(item), isError: false };
    case 'functionCallOutput':
      return { output: functionOutputText(item.output), isError: false };
    case 'commandExecution':
      return {
        output: stringValue(item.aggregatedOutput) ?? '',
        isError: typeof item.exitCode === 'number' && item.exitCode !== 0,
      };
    case 'fileChange':
      return {
        output: stringify(item.changes ?? []),
        isError: stringValue(item.status) === 'failed',
      };
    case 'mcpToolCall':
      return {
        output: stringify(item.result ?? item.error ?? ''),
        isError: Boolean(item.error) || stringValue(item.status) === 'failed',
      };
    case 'dynamicToolCall':
      return {
        output: stringify(item.contentItems ?? ''),
        isError: item.success === false || stringValue(item.status) === 'failed',
      };
    case 'collabAgentToolCall':
    case 'subAgentActivity':
    case 'webSearch':
    case 'imageView':
    case 'sleep':
    case 'imageGeneration':
    case 'enteredReviewMode':
    case 'exitedReviewMode':
    case 'contextCompaction':
      return {
        output: type === 'enteredReviewMode' || type === 'exitedReviewMode'
          ? stringValue(item.review) ?? ''
          : stringify(item),
        isError: false,
      };
    default:
      return undefined;
  }
}

function hookPromptText(item: Record<string, unknown>): string {
  if (!Array.isArray(item.fragments)) return '';
  return item.fragments
    .map((fragment) => recordValue(fragment))
    .map((fragment) => stringValue(fragment?.text) ?? '')
    .filter(Boolean)
    .join('\n');
}

function functionOutputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (!Array.isArray(output)) return stringify(output ?? '');
  return output
    .map((entry) => recordValue(entry))
    .map((entry) => entry?.type === 'input_text' ? stringValue(entry.text) ?? '' : stringify(entry))
    .filter(Boolean)
    .join('\n');
}

function errorMessage(input: Record<string, unknown> | undefined, fallback: string): string {
  if (!input) return fallback;
  return stringValue(input.message) ?? stringValue(recordValue(input.error)?.message) ?? fallback;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
