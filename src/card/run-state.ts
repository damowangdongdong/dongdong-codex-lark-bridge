import type { AgentEvent, AgentNoticeLevel } from '../agent/types';

export type ToolStatus = 'running' | 'done' | 'error';

export interface ToolEntry {
  id: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  output?: string;
}

export interface NoticeEntry {
  level: AgentNoticeLevel;
  message: string;
  attempt?: number;
  maxAttempts?: number;
  delaySeconds?: number;
}

export type Block =
  | { kind: 'text'; content: string; streaming: boolean }
  | { kind: 'user'; content: string }
  | { kind: 'notice'; notice: NoticeEntry }
  | { kind: 'tool'; tool: ToolEntry };

export type FooterStatus = 'thinking' | 'tool_running' | 'streaming' | null;
export type Terminal = 'running' | 'done' | 'interrupted' | 'error' | 'idle_timeout';

export interface RunState {
  blocks: Block[];
  finalText?: string;
  reasoning: { content: string; active: boolean };
  footer: FooterStatus;
  terminal: Terminal;
  errorMsg?: string;
  /** Set when terminal === 'idle_timeout' — how long claude was idle before
   * the watchdog gave up (so the message can say "N 分钟无响应"). */
  idleTimeoutMinutes?: number;
  session?: { sessionId?: string; threadId?: string; cwd?: string; model?: string };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    reasoningOutputTokens?: number;
  };
}

export const initialState: RunState = {
  blocks: [],
  reasoning: { content: '', active: false },
  footer: 'thinking',
  terminal: 'running',
};

function closeStreamingText(blocks: Block[]): Block[] {
  return blocks.map((b) =>
    b.kind === 'text' && b.streaming ? { ...b, streaming: false } : b,
  );
}

export function reduce(state: RunState, evt: AgentEvent): RunState {
  switch (evt.type) {
    case 'system':
      return {
        ...state,
        session: {
          ...(evt.sessionId ? { sessionId: evt.sessionId } : {}),
          ...(evt.threadId ? { threadId: evt.threadId } : {}),
          ...(evt.cwd ? { cwd: evt.cwd } : {}),
          ...(evt.model ? { model: evt.model } : {}),
        },
      };
    case 'user_text':
      return {
        ...state,
        blocks: [...closeStreamingText(state.blocks), { kind: 'user', content: evt.content }],
      };
    case 'usage':
      return {
        ...state,
        usage: {
          inputTokens: evt.inputTokens,
          outputTokens: evt.outputTokens,
          cachedInputTokens: evt.cachedInputTokens,
          reasoningOutputTokens: evt.reasoningOutputTokens,
        },
      };
    case 'text': {
      const last = state.blocks[state.blocks.length - 1];
      if (last && last.kind === 'text' && last.streaming) {
        const next: Block = { ...last, content: last.content + evt.delta };
        return {
          ...state,
          blocks: [...state.blocks.slice(0, -1), next],
          reasoning: { ...state.reasoning, active: false },
          footer: 'streaming',
        };
      }
      return {
        ...state,
        blocks: [...state.blocks, { kind: 'text', content: evt.delta, streaming: true }],
        reasoning: { ...state.reasoning, active: false },
        footer: 'streaming',
      };
    }

    case 'final_text':
      return { ...state, finalText: evt.content };

    case 'thinking': {
      return {
        ...state,
        reasoning: { content: state.reasoning.content + evt.delta, active: true },
        footer: 'thinking',
      };
    }

    case 'tool_use': {
      const tool: ToolEntry = {
        id: evt.id,
        name: evt.name,
        input: evt.input,
        status: 'running',
      };
      return {
        ...state,
        blocks: [...closeStreamingText(state.blocks), { kind: 'tool', tool }],
        reasoning: { ...state.reasoning, active: false },
        footer: 'tool_running',
      };
    }

    case 'tool_result': {
      const blocks = state.blocks.map((b) => {
        if (b.kind !== 'tool' || b.tool.id !== evt.id) return b;
        return {
          ...b,
          tool: {
            ...b.tool,
            status: evt.isError ? ('error' as const) : ('done' as const),
            output: evt.output,
          },
        };
      });
      return { ...state, blocks };
    }

    case 'tool_progress': {
      const blocks = state.blocks.map((b) => {
        if (b.kind !== 'tool' || b.tool.id !== evt.id) return b;
        return {
          ...b,
          tool: {
            ...b.tool,
            output: `${b.tool.output ?? ''}${evt.delta}`,
          },
        };
      });
      return { ...state, blocks, footer: 'tool_running' };
    }

    case 'notice':
      return {
        ...state,
        blocks: [
          ...closeStreamingText(state.blocks),
          {
            kind: 'notice',
            notice: {
              level: evt.level,
              message: evt.message,
              ...(evt.attempt !== undefined ? { attempt: evt.attempt } : {}),
              ...(evt.maxAttempts !== undefined ? { maxAttempts: evt.maxAttempts } : {}),
              ...(evt.delaySeconds !== undefined ? { delaySeconds: evt.delaySeconds } : {}),
            },
          },
        ],
        reasoning: { ...state.reasoning, active: false },
      };

    case 'error': {
      const terminal =
        evt.terminationReason === 'interrupted'
          ? 'interrupted'
          : evt.terminationReason === 'timeout'
            ? 'idle_timeout'
            : 'error';
      return {
        ...state,
        terminal,
        errorMsg: terminal === 'error' ? evt.message : state.errorMsg,
        footer: null,
      };
    }

    case 'done': {
      const terminal =
        evt.terminationReason === 'interrupted'
          ? 'interrupted'
          : evt.terminationReason === 'timeout'
            ? 'idle_timeout'
            : 'done';
      return {
        ...state,
        blocks: closeStreamingText(state.blocks),
        reasoning: { ...state.reasoning, active: false },
        terminal,
        footer: null,
      };
    }

    default:
      return state;
  }
}

export function markInterrupted(state: RunState): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'interrupted',
    footer: null,
  };
}

export function markIdleTimeout(state: RunState, minutes: number): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'idle_timeout',
    footer: null,
    idleTimeoutMinutes: minutes,
  };
}

export function finalizeIfRunning(state: RunState): RunState {
  if (state.terminal !== 'running') return state;
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'done',
    footer: null,
  };
}
