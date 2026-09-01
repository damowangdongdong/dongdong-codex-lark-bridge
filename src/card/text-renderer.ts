import { maskEmails } from './mask-email';
import type { Block, NoticeEntry, RunState, ToolEntry } from './run-state';
import { toolHeaderText } from './tool-render';

/**
 * Render `RunState` as plain markdown text — used in `messageReply: 'text'`
 * mode where we stream a markdown message instead of a card.
 *
 * Differences vs `renderCard`:
 *   - No collapsible panels, no buttons (markdown messages have neither)
 *   - Tool calls collapse to a single short line each (no body)
 *   - No reasoning / thinking output (no place to fold it; would be noise)
 *   - Footer is appended inline at the bottom while running
 */
export function renderText(state: RunState): string {
  const parts: string[] = [];

  for (const block of state.blocks) {
    const piece = renderBlock(block);
    if (piece) parts.push(piece);
  }

  if (state.terminal === 'interrupted') {
    parts.push('_⏹ 已被中断_');
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    parts.push(`_⏱ ${mins} 分钟无响应,已自动终止_`);
  } else if (state.terminal === 'error' && state.errorMsg) {
    parts.push(`⚠️ agent 失败:${state.errorMsg}`);
  } else if (state.terminal === 'running' && state.footer) {
    parts.push(footerLine(state.footer));
  }

  // Strip raw emails so the Feishu tenant audit doesn't reject the message
  // (see mask-email.ts). Never removes content, so emptiness checks upstream
  // still behave.
  return maskEmails(parts.join('\n\n'));
}

function renderBlock(block: Block): string {
  if (block.kind === 'text') {
    return block.content.trim();
  }
  if (block.kind === 'user') return `> 👤 **终端输入**\n> ${block.content.trim()}`;
  if (block.kind === 'notice') return renderNoticeText(block.notice);
  return toolLine(block.tool);
}

export function renderNoticeText(notice: NoticeEntry): string {
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
  const lines = notice.message.trim().split('\n').map((line) => `> ${line}`);
  if (notice.delaySeconds !== undefined) {
    lines.push(`> _等待 ${notice.delaySeconds} 秒后重试_`);
  }
  return `> ${title}\n${lines.join('\n')}`;
}

/**
 * One-line summary for a tool call:
 *   `> ⏳ **Bash** — git status`
 *   `> ✅ **Read** — ~/code/foo.ts`
 * Reuses `toolHeaderText` so the format matches the card mode header.
 */
function toolLine(tool: ToolEntry): string {
  return `> ${toolHeaderText(tool)}`;
}

function footerLine(status: 'thinking' | 'tool_running' | 'streaming'): string {
  if (status === 'thinking') return '_🧠 正在思考…_';
  if (status === 'tool_running') return '_🧰 正在调用工具…_';
  return '_✍️ 正在输出…_';
}
