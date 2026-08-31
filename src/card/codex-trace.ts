import type { RunState, ToolEntry } from './run-state';
import { deepMaskEmails } from './mask-email';

const SECTION_CHARS = 7_000;
const PAGE_CHARS = 12_000;

export function renderRunTraceCards(
  state: RunState,
  context: { profile?: string; sandbox: string },
): object[] {
  const sections: string[] = [];
  if (state.reasoning.content) {
    sections.push(...sectionChunks('🧠 Reasoning', state.reasoning.content));
  }
  for (const block of state.blocks) {
    if (block.kind === 'user') {
      sections.push(...sectionChunks('👤 Terminal input', block.content));
    } else if (block.kind === 'text') {
      sections.push(...sectionChunks('💬 Commentary', block.content));
    } else {
      sections.push(...toolSections(block.tool));
    }
  }
  if (state.usage) {
    sections.push(
      [
        '**📊 Token usage**',
        `input ${state.usage.inputTokens ?? 0} · output ${state.usage.outputTokens ?? 0}`,
        `cached ${state.usage.cachedInputTokens ?? 0} · reasoning ${state.usage.reasoningOutputTokens ?? 0}`,
      ].join('\n'),
    );
  }
  if (!sections.length) return [];
  const pages = paginate(sections);
  return pages.map((page, index) => traceCard(
    `🧾 Codex 完整轨迹 ${index + 1}/${pages.length}`,
    contextLine(context, state.session?.threadId),
    page,
  ));
}

export function renderCodexHistoryCards(
  result: unknown,
  cwd: string,
): object[] {
  const response = recordValue(result);
  const thread = recordValue(response?.thread);
  if (!thread) return [];
  const threadId = stringValue(thread.id) ?? '';
  const name = stringValue(thread.name) ?? stringValue(thread.preview) ?? threadId;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const sections: string[] = [];
  turns.forEach((rawTurn, turnIndex) => {
    const turn = recordValue(rawTurn);
    if (!turn) return;
    const status = stringValue(turn.status) ?? 'unknown';
    sections.push(`### 第 ${turnIndex + 1} 轮 · ${status}`);
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const rawItem of items) {
      const item = recordValue(rawItem);
      if (!item) continue;
      sections.push(...historyItemSections(item));
    }
  });
  if (!sections.length) sections.push('_此会话没有可显示的历史内容。_');
  const pages = paginate(sections);
  return pages.map((page, index) => traceCard(
    `🔁 Codex 历史 ${index + 1}/${pages.length}`,
    `**${escapeMd(name || '(未命名)')}** · \`${escapeCode(threadId)}\`\n📁 \`${escapeCode(cwd)}\``,
    page,
  ));
}

function toolSections(tool: ToolEntry): string[] {
  const status = tool.status === 'done' ? '✅' : tool.status === 'error' ? '❌' : '⏳';
  const input = stringify(tool.input);
  const output = tool.output ?? (tool.status === 'running' ? '运行中…' : '无输出');
  return [
    ...sectionChunks(`${status} ${tool.name} · input`, input, 'json'),
    ...sectionChunks(`${status} ${tool.name} · output`, output),
  ];
}

function historyItemSections(item: Record<string, unknown>): string[] {
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
    case 'webSearch':
    case 'imageView':
    case 'imageGeneration':
    case 'contextCompaction':
      return sectionChunks(`🔧 ${type}`, stringify(item), 'json');
    default:
      return sectionChunks(`• ${type}`, stringify(item), 'json');
  }
}

function sectionChunks(title: string, body: string, language = ''): string[] {
  const content = body || '_无内容_';
  const chunks: string[] = [];
  for (let offset = 0; offset < content.length; offset += SECTION_CHARS) {
    const chunk = content.slice(offset, offset + SECTION_CHARS);
    const suffix = content.length > SECTION_CHARS ? ` (${Math.floor(offset / SECTION_CHARS) + 1}/${Math.ceil(content.length / SECTION_CHARS)})` : '';
    chunks.push(`**${escapeMd(title)}${suffix}**\n\`\`\`${language}\n${escapeFence(chunk)}\n\`\`\``);
  }
  return chunks;
}

function paginate(sections: string[]): string[][] {
  const pages: string[][] = [];
  let page: string[] = [];
  let chars = 0;
  for (const section of sections) {
    if (page.length && chars + section.length > PAGE_CHARS) {
      pages.push(page);
      page = [];
      chars = 0;
    }
    page.push(section);
    chars += section.length;
  }
  if (page.length) pages.push(page);
  return pages;
}

function traceCard(title: string, context: string, sections: string[]): object {
  return deepMaskEmails({
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: context } },
      { tag: 'hr' },
      ...sections.map((content) => ({ tag: 'div', text: { tag: 'lark_md', content } })),
    ],
  });
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
