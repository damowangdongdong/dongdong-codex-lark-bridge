import type { NoticeEntry, RunState, ToolEntry } from './run-state';
import { deepMaskEmails } from './mask-email';

const SECTION_CHARS = 7_000;
const PAGE_CHARS = 12_000;

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
      sections.push(...sectionChunks('👤 Terminal input', block.content));
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
  ));
}

/** Render the transcript returned by thread/read after a resume. */
export function renderCodexHistoryCards(result: unknown, cwd: string): object[] {
  const response = recordValue(result);
  const thread = recordValue(response?.thread);
  if (!thread) return [];
  const threadId = stringValue(thread.id) ?? '';
  const name = stringValue(thread.name) ?? stringValue(thread.preview) ?? threadId;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const sections: TraceSection[] = [];
  turns.forEach((rawTurn, turnIndex) => {
    const turn = recordValue(rawTurn);
    if (!turn) return;
    const status = stringValue(turn.status) ?? 'unknown';
    sections.push({
      title: `第 ${turnIndex + 1} 轮 · ${status}`,
      body: `_以下历史默认折叠，点击各项标题查看。_`,
    });
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const rawItem of items) {
      const item = recordValue(rawItem);
      if (!item) continue;
      sections.push(...historyItemSections(item));
    }
  });
  if (!sections.length) sections.push({ title: '历史', body: '_此会话没有可显示的历史内容。_' });
  const pages = paginate(sections);
  return pages.map((page, index) => traceCard(
    `🔁 Codex 历史 ${index + 1}/${pages.length}`,
    `**${escapeMd(name || '(未命名)')}** · \`${escapeCode(threadId)}\`\n📁 \`${escapeCode(cwd)}\``,
    page,
  ));
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
    case 'userMessage':
      return sectionChunks('👤 User', contentText(item));
    case 'agentMessage':
      return sectionChunks(
        stringValue(item.phase) === 'commentary' ? '💬 Commentary' : '✅ Codex',
        stringValue(item.text) ?? contentText(item),
      );
    case 'reasoning':
      return sectionChunks('🧠 Reasoning', reasoningText(item) || stringify(item));
    case 'commandExecution':
      return [
        ...sectionChunks('🛠 Command', stringValue(item.command) ?? ''),
        ...sectionChunks('📤 Output', stringValue(item.aggregatedOutput) ?? ''),
      ];
    case 'fileChange':
      return sectionChunks('📝 File changes', stringify(item.changes ?? item), 'json');
    case 'mcpToolCall':
    case 'dynamicToolCall':
    case 'collabAgentToolCall':
    case 'subAgentActivity':
    case 'webSearch':
    case 'imageView':
    case 'imageGeneration':
    case 'contextCompaction':
    case 'hookPrompt':
    case 'functionCallOutput':
    case 'plan':
      return sectionChunks(`🔧 ${type}`, stringify(item), 'json');
    default:
      return sectionChunks(`• ${type}`, stringify(item), 'json');
  }
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

function paginate(sections: TraceSection[]): TraceSection[][] {
  const pages: TraceSection[][] = [];
  let page: TraceSection[] = [];
  let chars = 0;
  for (const section of sections) {
    const size = section.title.length + section.body.length;
    if (page.length && chars + size > PAGE_CHARS) {
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

function traceCard(title: string, context: string, sections: TraceSection[]): object {
  return deepMaskEmails({
    schema: '2.0',
    config: { summary: { content: title } },
    header: { title: { tag: 'plain_text', content: title } },
    body: {
      elements: [
        { tag: 'markdown', content: context, text_size: 'notation' },
        { tag: 'hr' },
        ...sections.map(tracePanel),
      ],
    },
  });
}

function tracePanel(section: TraceSection): object {
  const body = section.language
    ? `\`\`\`${section.language}\n${escapeFence(section.body)}\n\`\`\``
    : section.body;
  return {
    tag: 'collapsible_panel',
    expanded: section.expanded === true,
    header: {
      title: { tag: 'markdown', content: `**${escapeMd(section.title)}**` },
      vertical_align: 'center',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
      icon_position: 'follow_text',
      icon_expanded_angle: -180,
    },
    border: { color: section.expanded ? 'red' : 'grey', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: body, text_size: 'notation' }],
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

function reasoningText(item: Record<string, unknown>): string {
  const values = [item.summary, item.content, item.text]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => typeof value === 'string' ? value : stringValue(recordValue(value)?.text) ?? '')
    .filter(Boolean);
  return values.join('\n');
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
