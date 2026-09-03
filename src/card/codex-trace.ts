import type { NoticeEntry, RunState, ToolEntry } from './run-state';
import { extractBridgeUserInput, redactEmbeddedBridgePrompts } from '../agent/prompt';
import { normalizeSessionPreview } from '../session/preview';
import { deepMaskEmails } from './mask-email';

const SECTION_CHARS = 7_000;
const PAGE_CHARS = 12_000;
const HISTORY_PAGE_CHARS = 26_000;

interface TraceSection {
  title: string;
  body: string;
  language?: string;
  expanded?: boolean;
}

/** Render the lossless post-run trace. Detail panels are folded by default. */
export function renderRunTraceCards(
  state: RunState,
  context: { profile?: string; sandbox: string },
): object[] {
  const sections: TraceSection[] = [];
  if (state.reasoning.content) {
    sections.push(...sectionChunks('🧠 Reasoning', state.reasoning.content));
  }
  for (const block of state.blocks) {
    if (block.kind === 'user') {
      const input = sanitizeUserInput(block.content);
      if (input) sections.push(...sectionChunks('👤 User input', input));
    } else if (block.kind === 'text') {
      sections.push(...sectionChunks('💬 Commentary', block.content));
    } else if (block.kind === 'notice') {
      sections.push(...noticeSections(block.notice));
    } else {
      sections.push(...toolSections(block.tool));
    }
  }
  if (state.usage) {
    sections.push({
      title: '📊 Token usage',
      body: [
        `input ${state.usage.inputTokens ?? 0} · output ${state.usage.outputTokens ?? 0}`,
        `cached ${state.usage.cachedInputTokens ?? 0} · reasoning ${state.usage.reasoningOutputTokens ?? 0}`,
      ].join('\n'),
    });
  }
  if (!sections.length) return [];
  const pages = paginate(sections);
  return pages.map((page, index) => traceCard(
    `🧾 Codex 完整轨迹 ${index + 1}/${pages.length}`,
    contextLine(context, state.session?.threadId),
    page,
    `🧾 完整执行轨迹${pages.length > 1 ? ` · ${index + 1}/${pages.length}` : ''}`,
  ));
}

/** Render the transcript returned by thread/read after a resume. */
export function renderCodexHistoryCards(result: unknown, cwd: string): object[] {
  const response = recordValue(result);
  const thread = recordValue(response?.thread);
  if (!thread) return [];
  const threadId = stringValue(thread.id) ?? '';
  const name = [stringValue(thread.name), stringValue(thread.preview)]
    .map((value) => normalizeSessionPreview(value ?? ''))
    .find(Boolean) ?? threadId;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const sections: TraceSection[] = [];
  turns.forEach((rawTurn, turnIndex) => {
    const turn = recordValue(rawTurn);
    if (!turn) return;
    const status = stringValue(turn.status) ?? 'unknown';
    sections.push({
      title: `第 ${turnIndex + 1} 轮 · ${status}`,
      body: `_以下对话默认折叠，点击各项标题查看。_`,
    });
    const items = Array.isArray(turn.items) ? turn.items : [];
    const fallbackAgentMessage = items.some(isFinalAgentMessage)
      ? undefined
      : [...items].reverse().find(isAgentMessage);
    for (const rawItem of items) {
      const item = recordValue(rawItem);
      if (!item) continue;
      const type = stringValue(item.type);
      if (type !== 'userMessage'
        && !isFinalAgentMessage(item)
        && rawItem !== fallbackAgentMessage
        && !isHistoryToolType(type)) continue;
      sections.push(...historyItemSections(item));
    }
  });
  if (!sections.length) sections.push({ title: '历史', body: '_此会话没有可显示的历史内容。_' });
  // History is already opt-in, so pack it into as few messages as the card
  // size allows. Each page gets one collapsed inner panel; individual turns
  // are represented as headings inside that panel instead of hundreds of
  // sibling collapsible elements.
  const pages = paginate(sections, HISTORY_PAGE_CHARS).map(historyPageSection);
  return pages.map((page, index) => traceCard(
    `🔁 Codex 历史 ${index + 1}/${pages.length}`,
    `**${escapeMd(name || '(未命名)')}** · \`${escapeCode(threadId)}\`\n📁 \`${escapeCode(cwd)}\``,
    [page],
    `📚 完整历史对话${pages.length > 1 ? ` · ${index + 1}/${pages.length}` : ''}`,
    page.body,
  ));
}

function isAgentMessage(value: unknown): boolean {
  return stringValue(recordValue(value)?.type) === 'agentMessage';
}

function isFinalAgentMessage(value: unknown): boolean {
  const item = recordValue(value);
  return stringValue(item?.type) === 'agentMessage' && stringValue(item?.phase) === 'final_answer';
}

function toolSections(tool: ToolEntry): TraceSection[] {
  const status = tool.status === 'done' ? '✅' : tool.status === 'error' ? '❌' : '⏳';
  const input = stringify(tool.input);
  const output = tool.output ?? (tool.status === 'running' ? '运行中…' : '无输出');
  return [
    ...sectionChunks(`${status} ${tool.name} · input`, input, 'json'),
    ...sectionChunks(`${status} ${tool.name} · output`, output, '', tool.status === 'error'),
  ];
}

function noticeSections(notice: NoticeEntry): TraceSection[] {
  const count = notice.attempt !== undefined && notice.maxAttempts !== undefined
    ? ` ${notice.attempt}/${notice.maxAttempts}`
    : '';
  const title = notice.level === 'retry'
    ? `🔄 Codex retry${count}`
    : notice.level === 'recovered'
      ? '✅ Codex recovered'
      : notice.level === 'warning'
        ? '⚠️ Codex warning'
        : '🚨 Codex error';
  const delay = notice.delaySeconds === undefined ? '' : `\n\n等待 ${notice.delaySeconds} 秒后重试`;
  return sectionChunks(
    title,
    `${notice.message}${delay}`,
    '',
    notice.level === 'error' || notice.level === 'retry',
  );
}

function historyItemSections(item: Record<string, unknown>): TraceSection[] {
  const type = stringValue(item.type) ?? 'item';
  switch (type) {
    case 'userMessage': {
      const input = sanitizeUserInput(contentText(item));
      return input ? sectionChunks('👤 User', input) : [];
    }
    case 'agentMessage':
      return historySectionChunks(
        stringValue(item.phase) === 'commentary' ? '💬 Commentary' : '✅ Codex',
        stringValue(item.text) ?? contentText(item),
      );
    default:
      return historyToolSections(item);
  }
}

const HISTORY_TOOL_TYPES = new Set([
  'hookPrompt',
  'functionCallOutput',
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'subAgentActivity',
  'webSearch',
  'imageView',
  'sleep',
  'imageGeneration',
  'enteredReviewMode',
  'exitedReviewMode',
  'contextCompaction',
]);

function isHistoryToolType(type: string | undefined): boolean {
  return type !== undefined && HISTORY_TOOL_TYPES.has(type);
}

interface HistoryTool {
  name: string;
  input: unknown;
  output: string;
  isError: boolean;
}

/** Convert the persisted Codex display items into the same tool trace shape
 * used by live runs. A thread/read item contains both sides of the call, so
 * history can show the command/input and its final output together. */
function historyToolSections(item: Record<string, unknown>): TraceSection[] {
  const tool = historyTool(item);
  if (!tool) return [];
  const status = tool.isError ? '❌' : '✅';
  return [
    ...historySectionChunks(`${status} ${tool.name} · input`, stringify(tool.input), 'json'),
    ...historySectionChunks(`${status} ${tool.name} · output`, tool.output || '无输出'),
  ];
}

function historyTool(item: Record<string, unknown>): HistoryTool | undefined {
  const type = stringValue(item.type);
  switch (type) {
    case 'hookPrompt':
      return {
        name: 'hook_prompt',
        input: item.fragments ?? [],
        output: fragmentsText(item.fragments),
        isError: false,
      };
    case 'functionCallOutput':
      return {
        name: ['function', stringValue(item.namespace), stringValue(item.name)]
          .filter(Boolean)
          .join('.') || 'function',
        input: item.arguments ?? {},
        output: outputText(item.output),
        isError: false,
      };
    case 'commandExecution': {
      const exitCode = numberValue(item.exitCode ?? item.exit_code);
      return {
        name: 'command_execution',
        input: {
          command: stringValue(item.command) ?? '',
          ...(stringValue(item.cwd) ? { cwd: item.cwd } : {}),
        },
        output: firstString(item.aggregatedOutput, item.aggregated_output, item.output, item.stdout)
          ?? '',
        isError: (exitCode !== undefined && exitCode !== 0)
          || stringValue(item.status) === 'failed'
          || stringValue(item.status) === 'error',
      };
    }
    case 'fileChange':
      return {
        name: 'file_change',
        input: item.changes ?? [],
        output: stringify(item.changes ?? []),
        isError: stringValue(item.status) === 'failed',
      };
    case 'mcpToolCall':
      return {
        name: `${stringValue(item.server) ?? 'mcp'}.${stringValue(item.tool) ?? 'tool'}`,
        input: item.arguments ?? {},
        output: stringify(item.result ?? item.error ?? ''),
        isError: Boolean(item.error) || stringValue(item.status) === 'failed',
      };
    case 'dynamicToolCall':
      return {
        name: [stringValue(item.namespace), stringValue(item.tool)].filter(Boolean).join('.') || 'tool',
        input: item.arguments ?? {},
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
        name: historyToolName(type, item),
        input: item,
        output: type === 'enteredReviewMode' || type === 'exitedReviewMode'
          ? stringValue(item.review) ?? ''
          : stringify(item),
        isError: false,
      };
    default:
      return undefined;
  }
}

function historyToolName(type: string, item: Record<string, unknown>): string {
  switch (type) {
    case 'collabAgentToolCall':
      return `agent.${stringValue(item.tool) ?? 'activity'}`;
    case 'subAgentActivity':
      return `agent.${stringValue(item.kind) ?? 'activity'}`;
    case 'webSearch':
      return 'web_search';
    case 'imageView':
      return 'view_image';
    case 'sleep':
      return 'clock.sleep';
    case 'imageGeneration':
      return 'image_generation';
    case 'enteredReviewMode':
      return 'review.entered';
    case 'exitedReviewMode':
      return 'review.exited';
    default:
      return type.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  }
}

function fragmentsText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((fragment) => recordValue(fragment))
    .map((fragment) => stringValue(fragment?.text) ?? '')
    .filter(Boolean)
    .join('\n');
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return stringify(value ?? '');
  return value
    .map((entry) => recordValue(entry))
    .map((entry) => entry?.type === 'input_text' ? stringValue(entry.text) ?? '' : stringify(entry))
    .filter(Boolean)
    .join('\n');
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string');
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function historySectionChunks(title: string, body: string, language = ''): TraceSection[] {
  return sectionChunks(title, redactEmbeddedBridgePrompts(body), language);
}

function sectionChunks(
  title: string,
  body: string,
  language = '',
  expanded = false,
): TraceSection[] {
  const content = body || '_无内容_';
  const chunks: TraceSection[] = [];
  for (let offset = 0; offset < content.length; offset += SECTION_CHARS) {
    const suffix = content.length > SECTION_CHARS
      ? ` (${Math.floor(offset / SECTION_CHARS) + 1}/${Math.ceil(content.length / SECTION_CHARS)})`
      : '';
    chunks.push({
      title: `${title}${suffix}`,
      body: content.slice(offset, offset + SECTION_CHARS),
      ...(language ? { language } : {}),
      ...(expanded ? { expanded: true } : {}),
    });
  }
  return chunks;
}

function historyPageSection(sections: TraceSection[]): TraceSection {
  return {
    title: '📚 历史消息（点击查看）',
    body: sections
      .map((section) => `**${escapeMd(section.title)}**\n${section.body}`)
      .join('\n\n---\n\n'),
  };
}

function paginate(sections: TraceSection[], pageChars = PAGE_CHARS): TraceSection[][] {
  const pages: TraceSection[][] = [];
  let page: TraceSection[] = [];
  let chars = 0;
  for (const section of sections) {
    const size = section.title.length + section.body.length;
    if (page.length && chars + size > pageChars) {
      pages.push(page);
      page = [];
      chars = 0;
    }
    page.push(section);
    chars += size;
  }
  if (page.length) pages.push(page);
  return pages;
}

function traceCard(
  title: string,
  context: string,
  sections: TraceSection[],
  outerPanelTitle?: string,
  outerPanelBody?: string,
): object {
  const panels = sections.map(tracePanel);
  return deepMaskEmails({
    schema: '2.0',
    config: { summary: { content: title } },
    header: { title: { tag: 'plain_text', content: title } },
    body: {
      elements: [
        { tag: 'markdown', content: context, text_size: 'notation' },
        { tag: 'hr' },
        ...(outerPanelTitle
          ? [outerPanelBody === undefined
            ? tracePanelGroup(outerPanelTitle, panels)
            : tracePanelGroupContent(outerPanelTitle, outerPanelBody)]
          : panels),
      ],
    },
  });
}

/**
 * CardKit does not render collapsible panels nested inside another
 * collapsible panel. History pages therefore use one outer panel with a
 * single markdown element containing the already-formatted transcript.
 */
function tracePanelGroupContent(title: string, content: string): object {
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: panelHeader(title),
    border: { color: 'grey', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content, text_size: 'notation' }],
  };
}

function tracePanelGroup(title: string, elements: object[]): object {
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: panelHeader(title),
    border: { color: 'grey', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements,
  };
}

function tracePanel(section: TraceSection): object {
  const body = section.language
    ? `\`\`\`${section.language}\n${escapeFence(section.body)}\n\`\`\``
    : section.body;
  return {
    tag: 'collapsible_panel',
    expanded: section.expanded === true,
    header: panelHeader(section.title),
    border: { color: section.expanded ? 'red' : 'grey', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: body, text_size: 'notation' }],
  };
}

function panelHeader(title: string): object {
  return {
    title: { tag: 'markdown', content: `**${escapeMd(title)}**` },
    vertical_align: 'center',
    icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
    icon_position: 'follow_text',
    icon_expanded_angle: -180,
  };
}

function contextLine(context: { profile?: string; sandbox: string }, threadId?: string): string {
  return [
    `⚙️ ${context.profile ? `\`--profile ${escapeCode(context.profile)}\`` : '默认 profile'}`,
    `🛡 **${escapeMd(context.sandbox)}**`,
    ...(threadId ? [`🔗 \`${escapeCode(threadId)}\``] : []),
  ].join(' · ');
}

function contentText(item: Record<string, unknown>): string {
  if (typeof item.text === 'string') return item.text;
  if (!Array.isArray(item.content)) return '';
  return item.content
    .map((part) => recordValue(part))
    .map((part) => part && typeof part.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n');
}

function sanitizeUserInput(input: string): string {
  const extracted = extractBridgeUserInput(input);
  if (extracted !== undefined) return extracted;
  return isInternalContextOnly(input) ? '' : redactEmbeddedBridgePrompts(input);
}

function isInternalContextOnly(input: string): boolean {
  return /^\s*<(?:bridge_context|bridge_instructions|environment_context|codex_internal_context)\b/.test(input);
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function escapeFence(value: string): string {
  return value.replace(/```/g, '`\u200b``');
}

function escapeMd(value: string): string {
  return value.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(value: string): string {
  return value.replace(/`/g, "'");
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
