import { deepMaskEmails } from './mask-email';
import type { Block, FooterStatus, NoticeEntry, RunState, ToolEntry } from './run-state';
import { toolHeaderText } from './tool-render';

const REASONING_MAX = 1500;
const RETRY_DETAILS_MAX = 4000;
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
interface RetryGroup {
  kind: 'retries';
  notices: NoticeEntry[];
}
type Group = ToolGroup | TextGroup | UserGroup | NoticeGroup | RetryGroup;

export interface RunCardRenderOptions {
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
    } else if (group.kind === 'retries') {
      elements.push(retryPanel(group.notices));
    } else {
      elements.push(...renderToolGroup(group.tools, state.terminal !== 'running'));
    }
  }

  if (state.terminal === 'continued') {
    elements.push(noteMd('_↘ 已在下方接续_'));
  } else if (state.terminal === 'interrupted') {
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

function* groupBlocks(blocks: Block[]): Generator<Group> {
  const retryNotices = blocks
    .filter((block): block is Extract<Block, { kind: 'notice' }> =>
      block.kind === 'notice'
      && (block.notice.level === 'retry' || block.notice.level === 'recovered')
    )
    .map((block) => block.notice);
  let retriesEmitted = false;
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
        if (b.notice.level === 'retry' || b.notice.level === 'recovered') {
          if (!retriesEmitted) {
            retriesEmitted = true;
            yield { kind: 'retries', notices: retryNotices };
          }
          continue;
        }
        yield { kind: 'notice', notice: b.notice };
      } else {
        yield { kind: 'text', content: b.content };
      }
    }
  }
  if (toolBuf.length > 0) yield { kind: 'tools', tools: toolBuf };
}

function retryPanel(notices: NoticeEntry[]): object {
  const retries = notices.filter((notice) => notice.level === 'retry');
  const latest = notices.at(-1);
  const recovered = latest?.level === 'recovered';
  const latestRetry = [...notices].reverse().find((notice) => notice.level === 'retry');
  const count = retries.length;
  const title = recovered
    ? `✅ **Codex 已恢复 · 本 turn 重试 ${count} 次**`
    : `🔄 **Codex 正在重试${
      latestRetry?.attempt !== undefined && latestRetry.maxAttempts !== undefined
        ? ` ${latestRetry.attempt}/${latestRetry.maxAttempts}`
        : ''
    }${latestRetry?.delaySeconds !== undefined
      ? ` · ${latestRetry.delaySeconds} 秒后继续`
      : ''} · 本 turn 已记录 ${count} 次**`;
  const body = notices.map((notice) => {
    if (notice.level === 'recovered') return `✅ ${notice.message}`;
    const attempt = notice.attempt !== undefined && notice.maxAttempts !== undefined
      ? `${notice.attempt}/${notice.maxAttempts}`
      : `第 ${retries.indexOf(notice) + 1} 次`;
    const delay = notice.delaySeconds !== undefined ? ` · ${notice.delaySeconds} 秒后重试` : '';
    return `🔄 **${attempt}**${delay}\n${notice.message}`;
  }).join('\n\n');
  return collapsiblePanel({
    title,
    expanded: false,
    border: recovered ? 'grey' : 'blue',
    body: truncate(body, RETRY_DETAILS_MAX),
  });
}

function renderToolGroup(tools: ToolEntry[], finalized: boolean): object[] {
  if (tools.length === 0) return [];
  // Keep every contiguous tool run in one collapsed panel, including a
  // single call. The summary still exposes each tool's name, status and
  // short input while keeping command output out of the live card by default.
  return [collapsedToolSummary(tools, finalized)];
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
    expanded: notice.level !== 'retry' && notice.level !== 'recovered',
    border: notice.level === 'error' ? 'red' : notice.level === 'recovered' ? 'grey' : 'blue',
    body: `${notice.message}${delay}`,
  });
}

/**
 * Render a contiguous tool run as a compact summary. The post-run trace cards
 * carry every untruncated input/output chunk when detailed inspection is
 * needed.
 *
 * Why no bodies: with full input/output panels nested, the serialized JSON
 * can easily exceed Feishu's per-element size limit (~30KB), causing 400
 * errors that abort the entire card stream. Tool details are still in the
 * file log; users who really need them can `/doctor` to inspect.
 *
 * Running tools stay in the same summary panel as completed tools; their
 * status icon changes to ⏳ so the active call remains visible without
 * expanding its potentially large body.
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
  if (state.terminal === 'continued') return '已在下方接续';
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
