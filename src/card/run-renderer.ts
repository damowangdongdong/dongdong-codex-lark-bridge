import { deepMaskEmails } from './mask-email';
import type { Block, FooterStatus, NoticeEntry, RunState, ToolEntry } from './run-state';
import { toolBodyMd, toolHeaderText } from './tool-render';

const REASONING_MAX = 1500;
const COLLAPSE_TOOL_THRESHOLD = 3;

interface ToolGroup {
  kind: 'tools';
  tools: ToolEntry[];
}
interface TextGroup {
  kind: 'text';
  content: string;
}
interface UserGroup {
  kind: 'user';
  content: string;
}
interface NoticeGroup {
  kind: 'notice';
  notice: NoticeEntry;
}
type Group = ToolGroup | TextGroup | UserGroup | NoticeGroup;

export interface RunCardRenderOptions {
  signCallback?: (action: string) => string;
  interactiveInput?: boolean;
  codexContext?: { profile?: string; sandbox: string };
}

export function renderCard(state: RunState, options: RunCardRenderOptions = {}): object {
  const elements: object[] = [];

  if (options.codexContext) {
    elements.push(codexContextLine(state, options.codexContext));
  }

  if (state.reasoning.content) {
    elements.push(reasoningPanel(state.reasoning.content, state.reasoning.active));
  }

  for (const group of groupBlocks(state.blocks)) {
    if (group.kind === 'text') {
      if (group.content.trim()) {
        elements.push(markdown(group.content));
      }
    } else if (group.kind === 'user') {
      elements.push(collapsiblePanel({
        title: '👤 **输入，点击查看**',
        expanded: false,
        border: 'blue',
        body: group.content,
      }));
    } else if (group.kind === 'notice') {
      elements.push(noticePanel(group.notice));
    } else {
      elements.push(...renderToolGroup(group.tools, state.terminal !== 'running'));
    }
  }

  if (state.terminal === 'interrupted') {
    elements.push(noteMd('_⏹ 已被中断_'));
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    elements.push(noteMd(`_⏱ ${mins} 分钟无响应,已自动终止_`));
  } else if (state.terminal === 'error' && state.errorMsg) {
    elements.push(noteMd(`⚠️ agent 失败：${state.errorMsg}`));
  } else if (state.terminal === 'done' && elements.length === 0) {
    elements.push(noteMd('_（未返回内容）_'));
  }

  if (state.terminal === 'running') {
    if (state.footer) elements.push(footerStatus(state.footer));
    if (options.interactiveInput) elements.push(codexInput(options));
    elements.push(stopButton(options));
  }

  // Mask raw emails across every text field so the Feishu tenant audit doesn't
  // reject the (streamed) card with a 400 EMAIL_ADDRESS — see mask-email.ts.
  return deepMaskEmails({
    schema: '2.0',
    config: {
      streaming_mode: state.terminal === 'running',
      summary: { content: summaryText(state) },
    },
    body: { elements },
  });
}

function codexContextLine(
  state: RunState,
  context: NonNullable<RunCardRenderOptions['codexContext']>,
): object {
  const profile = context.profile ? `--profile ${context.profile}` : '默认 profile';
  const thread = state.session?.threadId ? ` · thread ${state.session.threadId.slice(0, 8)}…` : '';
  return noteMd(`🧭 **Codex** · ${profile} · 🛡 ${context.sandbox}${thread}`);
}

function codexInput(options: RunCardRenderOptions): object {
  const actionValue = (cmd: string): Record<string, unknown> => {
    const value: Record<string, unknown> = { cmd, __bridge_cb: true };
    if (options.signCallback) value.bridge_token = options.signCallback(cmd);
    return value;
  };
  return {
    tag: 'form',
    name: 'codex_turn_input',
    elements: [
      {
        tag: 'input',
        name: 'codex_input',
        placeholder: { tag: 'plain_text', content: '输入补充指令…' },
        input_type: 'multiline_text',
      },
      {
        tag: 'column_set',
        flex_mode: 'flow',
        horizontal_spacing: 'small',
        columns: [
          {
            tag: 'column',
            width: 'auto',
            elements: [
              {
                tag: 'button',
                name: 'codex_inject',
                text: { tag: 'plain_text', content: '↵ 立即插入' },
                type: 'primary',
                form_action_type: 'submit',
                behaviors: [{ type: 'callback', value: actionValue('codex.inject') }],
              },
            ],
          },
          {
            tag: 'column',
            width: 'auto',
            elements: [
              {
                tag: 'button',
                name: 'codex_queue',
                text: { tag: 'plain_text', content: '⇥ 排队' },
                form_action_type: 'submit',
                behaviors: [{ type: 'callback', value: actionValue('codex.queue') }],
              },
            ],
          },
        ],
      },
    ],
  };
}

function* groupBlocks(blocks: Block[]): Generator<Group> {
  let toolBuf: ToolEntry[] = [];
  for (const b of blocks) {
    if (b.kind === 'tool') {
      toolBuf.push(b.tool);
    } else {
      if (toolBuf.length > 0) {
        yield { kind: 'tools', tools: toolBuf };
        toolBuf = [];
      }
      if (b.kind === 'user') {
        yield { kind: 'user', content: b.content };
      } else if (b.kind === 'notice') {
        yield { kind: 'notice', notice: b.notice };
      } else {
        yield { kind: 'text', content: b.content };
      }
    }
  }
  if (toolBuf.length > 0) yield { kind: 'tools', tools: toolBuf };
}

function renderToolGroup(tools: ToolEntry[], finalized: boolean): object[] {
  if (tools.length === 0) return [];
  if (tools.length < COLLAPSE_TOOL_THRESHOLD) {
    return tools.map((t) => toolPanel(t, false));
  }
  if (finalized) {
    return [collapsedToolSummary(tools, true)];
  }
  // Running: collapse prior tools, keep latest visible.
  const prior = tools.slice(0, -1);
  const latest = tools[tools.length - 1];
  const out: object[] = [];
  if (prior.length > 0) out.push(collapsedToolSummary(prior, false));
  if (latest) out.push(toolPanel(latest, true));
  return out;
}

function reasoningPanel(content: string, active: boolean): object {
  const title = active ? '🧠 **思考中**' : '🧠 **思考完成，点击查看**';
  return collapsiblePanel({
    title,
    expanded: active,
    border: 'grey',
    body: truncate(content, REASONING_MAX),
  });
}

function noticePanel(notice: NoticeEntry): object {
  const retryCount = notice.attempt !== undefined && notice.maxAttempts !== undefined
    ? ` ${notice.attempt}/${notice.maxAttempts}`
    : '';
  const title = notice.level === 'retry'
    ? `🔄 **Codex 正在重试${retryCount}**`
    : notice.level === 'recovered'
      ? '✅ **Codex 已恢复**'
      : notice.level === 'warning'
        ? '⚠️ **Codex 提示**'
        : '🚨 **Codex 错误**';
  const delay = notice.delaySeconds !== undefined
    ? `\n\n_等待 ${notice.delaySeconds} 秒后重试_`
    : '';
  return collapsiblePanel({
    title,
    expanded: notice.level !== 'recovered',
    border: notice.level === 'error' ? 'red' : notice.level === 'recovered' ? 'grey' : 'blue',
    body: `${notice.message}${delay}`,
  });
}

function toolPanel(tool: ToolEntry, expanded: boolean): object {
  return collapsiblePanel({
    title: toolHeaderText(tool),
    expanded,
    border: tool.status === 'error' ? 'red' : 'grey',
    body: toolBodyMd(tool) || '_无输出_',
  });
}

/**
 * Render N completed tool calls as a compact live summary. The finalized card
 * expands them back into individual panels, and the post-run trace cards carry
 * every untruncated input/output chunk.
 *
 * Why no bodies: with full input/output panels nested, the serialized JSON
 * can easily exceed Feishu's per-element size limit (~30KB), causing 400
 * errors that abort the entire card stream. Tool details are still in the
 * file log; users who really need them can `/doctor` to inspect.
 *
 * The latest-running tool, when applicable, is rendered separately via
 * `toolPanel(latest, true)` so live observation isn't sacrificed.
 */
function collapsedToolSummary(tools: ToolEntry[], finalized: boolean): object {
  const suffix = finalized ? '（已结束）' : '';
  const title = `☕ **${tools.length} 个工具调用${suffix}**`;
  const headerList = tools.map((t) => `- ${toolHeaderText(t)}`).join('\n');
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: panelHeader(title),
    border: { color: 'blue', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: headerList, text_size: 'notation' }],
  };
}

interface PanelOpts {
  title: string;
  expanded: boolean;
  border: 'grey' | 'red' | 'blue';
  body: string;
}

function collapsiblePanel(opts: PanelOpts): object {
  return {
    tag: 'collapsible_panel',
    expanded: opts.expanded,
    header: panelHeader(opts.title),
    border: { color: opts.border, corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: opts.body, text_size: 'notation' }],
  };
}

function panelHeader(titleMd: string): object {
  return {
    title: { tag: 'markdown', content: titleMd },
    vertical_align: 'center',
    icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
    icon_position: 'follow_text',
    icon_expanded_angle: -180,
  };
}

function markdown(content: string): object {
  return { tag: 'markdown', content };
}

function noteMd(content: string): object {
  return { tag: 'markdown', content, text_size: 'notation' };
}

function stopButton(options: RunCardRenderOptions): object {
  const value: Record<string, unknown> = { cmd: 'stop' };
  if (options.signCallback) {
    value.__bridge_cb = true;
    value.bridge_token = options.signCallback('stop');
  }
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: '⏹ 终止' },
    type: 'danger',
    behaviors: [{ type: 'callback', value }],
  };
}

function footerStatus(status: Exclude<FooterStatus, null>): object {
  const text =
    status === 'thinking'
      ? '🧠 正在思考'
      : status === 'tool_running'
        ? '🧰 正在调用工具'
        : '✍️ 正在输出';
  return noteMd(text);
}

function summaryText(state: RunState): string {
  if (state.terminal === 'interrupted') return '已中断';
  if (state.terminal === 'idle_timeout') return '已超时';
  if (state.terminal === 'error') return '出错';
  if (state.terminal === 'done') return '已完成';
  const latestNotice = [...state.blocks].reverse().find((block) => block.kind === 'notice');
  if (latestNotice?.kind === 'notice' && latestNotice.notice.level === 'retry') {
    const { attempt, maxAttempts } = latestNotice.notice;
    return attempt !== undefined && maxAttempts !== undefined
      ? `正在重试 ${attempt}/${maxAttempts}`
      : '正在重试';
  }
  if (latestNotice?.kind === 'notice' && latestNotice.notice.level === 'error') {
    return 'Codex 报错';
  }
  if (state.footer === 'tool_running') return '正在调用工具';
  if (state.footer === 'streaming') return '正在输出';
  return '思考中';
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
