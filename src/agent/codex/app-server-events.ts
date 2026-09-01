import type { AgentEvent } from '../types';
import { extractBridgeUserInput } from '../prompt';
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
  private latestTurnDiff: string | undefined;
  private readonly patchSnapshots = new Map<string, string>();
  private terminal = false;
  private retrying = false;

  constructor(threadId: string) {
    this.threadId = threadId;
  }

  setTurnId(turnId: string): void {
    this.turnId = turnId;
  }

  translate(notification: RpcNotification): AgentEvent[] {
    if (this.terminal) return [];
    const params = recordValue(notification.params);
    if (!params) return [];
    const paramsThreadId = stringValue(params.threadId);
    if (paramsThreadId && paramsThreadId !== this.threadId) return [];
    const notificationTurnId = stringValue(params.turnId) ?? stringValue(recordValue(params.turn)?.id);
    if (this.turnId && notificationTurnId && notificationTurnId !== this.turnId) return [];

    switch (notification.method) {
      case 'turn/started':
        if (notificationTurnId) this.turnId = notificationTurnId;
        return [];
      case 'item/started':
        return this.withRecovery(this.itemStarted(recordValue(params.item)));
      case 'item/agentMessage/delta':
        return this.withRecovery(this.agentMessageDelta(params));
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        return this.withRecovery(this.thinkingDelta(params, 'reasoning'));
      case 'item/plan/delta':
        return this.withRecovery(this.thinkingDelta(params, 'plan'));
      case 'item/commandExecution/outputDelta': {
        const id = stringValue(params.itemId);
        const delta = stringValue(params.delta);
        return this.withRecovery(id && delta ? [{ type: 'tool_progress', id, delta }] : []);
      }
      case 'item/commandExecution/terminalInteraction': {
        const stdin = stringValue(params.stdin);
        return this.withRecovery(stdin ? [{ type: 'user_text', content: stdin }] : []);
      }
      case 'item/fileChange/outputDelta': {
        const id = stringValue(params.itemId);
        const delta = stringValue(params.delta);
        return this.withRecovery(id && delta ? [{ type: 'tool_progress', id, delta }] : []);
      }
      case 'item/fileChange/patchUpdated':
        return this.withRecovery(this.fileChangePatchUpdated(params));
      case 'item/mcpToolCall/progress': {
        const id = stringValue(params.itemId);
        const message = stringValue(params.message);
        return this.withRecovery(
          id && message ? [{ type: 'tool_progress', id, delta: `${message}\n` }] : [],
        );
      }
      case 'item/completed':
        return this.withRecovery(this.itemCompleted(recordValue(params.item)));
      case 'thread/tokenUsage/updated':
        this.captureUsage(params);
        return [];
      case 'turn/plan/updated':
        return this.withRecovery(turnPlanUpdate(params));
      case 'turn/diff/updated':
        return this.withRecovery(this.turnDiffUpdated(params));
      case 'item/autoApprovalReview/started':
        return this.withRecovery(this.autoApprovalStarted(params));
      case 'item/autoApprovalReview/completed':
        return this.withRecovery(this.autoApprovalCompleted(params));
      case 'warning':
        return [{
          type: 'notice',
          level: 'warning',
          message: stringValue(params.message) ?? 'Codex warning',
        }];
      case 'configWarning':
        return [{
          type: 'notice',
          level: 'warning',
          message: [stringValue(params.summary), stringValue(params.details)]
            .filter(Boolean)
            .join('\n') || 'Codex configuration warning',
        }];
      case 'model/rerouted':
        return [{
          type: 'notice',
          level: 'warning',
          message: `Codex model rerouted: ${stringValue(params.fromModel) ?? '?'} → ${stringValue(params.toModel) ?? '?'} (${stringValue(params.reason) ?? 'unspecified'})`,
        }];
      case 'model/safetyBuffering/updated':
        if (params.showBufferingUi !== true) return [];
        return [{
          type: 'notice',
          level: 'warning',
          message: [
            `Codex is buffering model ${stringValue(params.model) ?? '?'}.`,
            listText(params.reasons),
            stringValue(params.fasterModel)
              ? `Faster model available: ${stringValue(params.fasterModel)}`
              : '',
          ].filter(Boolean).join('\n'),
        }];
      case 'model/verification':
        return [{
          type: 'notice',
          level: 'warning',
          message: `Codex requires verification: ${listText(params.verifications) || 'unknown verification'}`,
        }];
      case 'error': {
        const message = errorMessage(params, 'Codex app-server error');
        const notice = codexErrorNotice(message, params.willRetry === true);
        if (notice.level === 'retry') this.retrying = true;
        return [notice];
      }
      case 'turn/completed':
        return this.withRecovery(this.turnCompleted(recordValue(params.turn)));
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

  private withRecovery(events: AgentEvent[]): AgentEvent[] {
    if (!this.retrying || events.length === 0 || events.some((event) => event.type === 'error')) {
      return events;
    }
    const progressed = events.some((event) =>
      event.type === 'thinking'
      || event.type === 'text'
      || event.type === 'final_text'
      || event.type === 'tool_use'
      || event.type === 'tool_progress'
      || event.type === 'tool_result'
      || (event.type === 'done' && event.terminationReason === 'normal'),
    );
    if (!progressed) return events;
    this.retrying = false;
    return [
      { type: 'notice', level: 'recovered', message: 'Codex 连接已恢复，正在继续运行。' },
      ...events,
    ];
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
    this.patchSnapshots.delete(id);
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
    if (this.latestTurnDiff !== undefined) {
      events.push({
        type: 'tool_result',
        id: 'codex-turn-diff',
        output: this.latestTurnDiff,
        isError: false,
      });
    }
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

  private fileChangePatchUpdated(params: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(params.itemId);
    if (!id || !Array.isArray(params.changes)) return [];
    const snapshot = stringify(params.changes);
    if (this.patchSnapshots.get(id) === snapshot) return [];
    this.patchSnapshots.set(id, snapshot);
    return [{ type: 'tool_progress', id, delta: `Patch updated:\n${snapshot}\n` }];
  }

  private turnDiffUpdated(params: Record<string, unknown>): AgentEvent[] {
    const diff = stringValue(params.diff);
    if (!diff || diff === this.latestTurnDiff) return [];
    const previous = this.latestTurnDiff ?? '';
    this.latestTurnDiff = diff;
    const delta = previous && diff.startsWith(previous)
      ? diff.slice(previous.length)
      : previous
        ? `\n\nUpdated diff snapshot:\n${diff}`
        : diff;
    return [
      ...(previous ? [] : [{
        type: 'tool_use' as const,
        id: 'codex-turn-diff',
        name: 'turn_diff',
        input: {},
      }]),
      ...(delta ? [{ type: 'tool_progress' as const, id: 'codex-turn-diff', delta }] : []),
    ];
  }

  private autoApprovalStarted(params: Record<string, unknown>): AgentEvent[] {
    const reviewId = stringValue(params.reviewId);
    if (!reviewId) return [];
    return [{
      type: 'tool_use',
      id: `auto-approval:${reviewId}`,
      name: 'approval.auto_review',
      input: {
        action: params.action ?? {},
        review: params.review ?? {},
      },
    }];
  }

  private autoApprovalCompleted(params: Record<string, unknown>): AgentEvent[] {
    const reviewId = stringValue(params.reviewId);
    if (!reviewId) return [];
    const review = recordValue(params.review);
    const status = stringValue(review?.status);
    return [{
      type: 'tool_result',
      id: `auto-approval:${reviewId}`,
      output: stringify({
        review: params.review ?? {},
        decisionSource: params.decisionSource ?? null,
      }),
      isError: status !== 'approved',
    }];
  }
}

function turnPlanUpdate(params: Record<string, unknown>): AgentEvent[] {
  const steps = Array.isArray(params.plan) ? params.plan : [];
  const rendered = steps
    .map(recordValue)
    .filter((step): step is Record<string, unknown> => Boolean(step))
    .map((step) => {
      const status = stringValue(step.status);
      const marker = status === 'completed' ? '✓' : status === 'inProgress' ? '→' : '·';
      return `${marker} ${stringValue(step.step) ?? ''}`.trimEnd();
    })
    .filter(Boolean);
  const explanation = stringValue(params.explanation);
  const content = [explanation, ...rendered].filter(Boolean).join('\n');
  return content ? [{ type: 'thinking', delta: `\n\nPlan update:\n${content}` }] : [];
}

function codexErrorNotice(
  message: string,
  willRetry: boolean,
): Extract<AgentEvent, { type: 'notice' }> {
  const retry = message.match(/(?:Reconnecting|Retrying)(?:\.\.\.|…)?\s*(\d+)\s*\/\s*(\d+)(?:\s*\(([^)]*)\))?/i);
  if (!retry) return { type: 'notice', level: willRetry ? 'retry' : 'error', message };
  const details = retry[3] ?? '';
  const delay = details.match(/(?:^|[\s•·])([0-9]+(?:\.[0-9]+)?)s(?:\s|$|[•·])/i);
  return {
    type: 'notice',
    level: 'retry',
    message,
    attempt: Number(retry[1]),
    maxAttempts: Number(retry[2]),
    ...(delay ? { delaySeconds: Number(delay[1]) } : {}),
  };
}

function userMessageText(item: Record<string, unknown>): string {
  const content = typeof item.text === 'string'
    ? item.text
    : !Array.isArray(item.content)
      ? ''
      : item.content
    .map((part) => recordValue(part))
    .map((part) => part && typeof part.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n');
  return extractBridgeUserInput(content) ?? content;
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
  const error = recordValue(input.error) ?? input;
  const message = stringValue(error.message) ?? fallback;
  const details = stringValue(error.additionalDetails);
  const info = codexErrorInfo(error.codexErrorInfo);
  return [message, details, info].filter((value, index, values) =>
    Boolean(value) && values.indexOf(value) === index
  ).join('\n');
}

function codexErrorInfo(value: unknown): string | undefined {
  if (typeof value === 'string') return `Codex error: ${value}`;
  const record = recordValue(value);
  if (!record) return undefined;
  const [kind, detail] = Object.entries(record)[0] ?? [];
  if (!kind) return undefined;
  const status = numberValue(recordValue(detail)?.httpStatusCode);
  return `Codex error: ${kind}${status === undefined ? '' : ` (HTTP ${status})`}`;
}

function listText(value: unknown): string {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').join(', ')
    : '';
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
