import type { AgentAdditionalContext } from './types';

export type BridgePromptSource = 'im' | 'card' | 'comment';

export const BRIDGE_SYSTEM_PROMPT_HEADING = '# lark-channel-bridge 运行约定';
const BRIDGE_SYSTEM_PROMPT_TITLE = BRIDGE_SYSTEM_PROMPT_HEADING.slice(2);
const BRIDGE_SYSTEM_PROMPT_SIGNATURE = '你正在 lark-channel-bridge 里跑';

export interface BridgePromptMention {
  openId?: string;
  name?: string;
  isBot?: boolean;
}

export interface BridgePromptContext {
  chatId: string;
  chatType: string;
  senderId: string;
  senderName?: string;
  /** Whether the sender is a human user or another bot ('app' sender). */
  senderType?: 'user' | 'bot';
  /** The bridge bot's own open_id — "this id is you" for self-identification. */
  botOpenId?: string;
  /** Accounts @-mentioned in the triggering message(s), deduped across the batch. */
  mentions?: BridgePromptMention[];
  threadId?: string;
  messageIds?: string[];
  source: BridgePromptSource;
}

export interface BridgePromptQuotedMessage {
  messageId: string;
  senderId: string;
  senderName?: string;
  createdAt?: string;
  rawContentType: string;
  content: string;
}

export interface BridgePromptInteractiveCard {
  messageId?: string;
  content: unknown;
}

/**
 * A prior message in the same Feishu topic, supplied as read-only context when
 * the bot is first pulled into a topic it hasn't been part of. Distinct from
 * `quotedMessages` (an explicit reply-quote): this is the topic's upstream
 * conversation the bot would otherwise be blind to.
 */
export interface BridgePromptTopicMessage {
  messageId: string;
  senderId: string;
  senderName?: string;
  senderType?: 'user' | 'bot';
  createdAt?: string;
  rawContentType: string;
  content: string;
}

export interface BridgePromptComment {
  commentScopeId: string;
  isWholeDocument: boolean;
  docsLink?: string;
  question: string;
  quote?: string;
}

export interface BridgePromptAttachment {
  path: string;
  kind: string;
  hash?: string;
  size?: number;
  mime?: string;
  sourceMessageId?: string;
  requiredness?: 'required' | 'optional';
  decision?: 'accepted' | 'rejected' | 'skipped';
  rejectionReason?: string;
}

export interface BuildAgentPromptInput {
  context: BridgePromptContext;
  instructions?: string[];
  userInput: string;
  topicContext?: BridgePromptTopicMessage[];
  quotedMessages?: BridgePromptQuotedMessage[];
  interactiveCards?: BridgePromptInteractiveCard[];
  comment?: BridgePromptComment;
  attachments?: BridgePromptAttachment[];
}

export interface BuiltCodexPrompt {
  prompt: string;
  additionalContext?: AgentAdditionalContext;
}

export function buildAgentPrompt(input: BuildAgentPromptInput): string {
  const sections = [
    promptSection('bridge_context', input.context),
    input.instructions && input.instructions.length > 0
      ? promptSection('bridge_instructions', input.instructions)
      : undefined,
    input.topicContext && input.topicContext.length > 0
      ? promptSection('topic_context', input.topicContext)
      : undefined,
    input.quotedMessages && input.quotedMessages.length > 0
      ? promptSection('quoted_messages', input.quotedMessages)
      : undefined,
    input.interactiveCards && input.interactiveCards.length > 0
      ? promptSection('interactive_cards', input.interactiveCards)
      : undefined,
    input.comment ? promptSection('comment_context', input.comment) : undefined,
    promptSection('user_input', {
      text: input.userInput,
      ...(input.attachments && input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
    }),
  ];

  return sections.filter(Boolean).join('\n\n');
}

/**
 * Keep Codex's user input identical to what the human wrote. Feishu-only data
 * is supplied through app-server's native additionalContext field, and only
 * when the transport added information that is not present in the message.
 */
export function buildCodexPrompt(input: BuildAgentPromptInput): BuiltCodexPrompt {
  const application: Record<string, unknown> = {};
  const messageContext: Record<string, unknown> = {};
  const mentions = (input.context.mentions ?? []).filter(
    (mention) => !input.context.botOpenId || mention.openId !== input.context.botOpenId,
  );
  const needsChannelContext = input.context.senderType === 'bot' || mentions.length > 0;

  if (needsChannelContext) {
    application.channel = {
      chatId: input.context.chatId,
      chatType: input.context.chatType,
      senderId: input.context.senderId,
      ...(input.context.senderName ? { senderName: input.context.senderName } : {}),
      ...(input.context.senderType ? { senderType: input.context.senderType } : {}),
      ...(input.context.botOpenId ? { botOpenId: input.context.botOpenId } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(input.context.threadId ? { threadId: input.context.threadId } : {}),
    };
  }
  if (input.instructions && input.instructions.length > 0) {
    application.notes = input.instructions;
  }
  if (input.topicContext && input.topicContext.length > 0) {
    messageContext.topicMessages = input.topicContext;
  }
  if (input.quotedMessages && input.quotedMessages.length > 0) {
    messageContext.quotedMessages = input.quotedMessages;
  }
  if (input.interactiveCards && input.interactiveCards.length > 0) {
    messageContext.interactiveCards = input.interactiveCards;
  }
  const attachments = compactCodexAttachments(input.attachments ?? []);
  if (attachments.length > 0) messageContext.attachments = attachments;

  const additionalContext: AgentAdditionalContext = {};
  if (Object.keys(application).length > 0) {
    additionalContext['lark-channel'] = {
      kind: 'application',
      value: safeJsonStringify(application),
    };
  }
  if (Object.keys(messageContext).length > 0) {
    additionalContext['lark-message-context'] = {
      kind: 'untrusted',
      value: safeJsonStringify(messageContext),
    };
  }

  return {
    prompt: input.userInput,
    ...(Object.keys(additionalContext).length > 0 ? { additionalContext } : {}),
  };
}

export function promptSection(tag: string, value: unknown): string {
  return `<${tag}>\n${safeJsonStringify(value)}\n</${tag}>`;
}

export function safeJsonStringify(value: unknown): string {
  return (JSON.stringify(value) ?? 'null')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function compactCodexAttachments(
  attachments: BridgePromptAttachment[],
): Array<Record<string, unknown>> {
  return attachments
    .filter((attachment) => attachment.kind !== 'image' || attachment.decision !== 'accepted')
    .map((attachment) => ({
      kind: attachment.kind,
      ...(attachment.path ? { path: attachment.path } : {}),
      ...(attachment.mime ? { mime: attachment.mime } : {}),
      ...(attachment.requiredness ? { requiredness: attachment.requiredness } : {}),
      ...(attachment.decision ? { decision: attachment.decision } : {}),
      ...(attachment.rejectionReason ? { rejectionReason: attachment.rejectionReason } : {}),
    }));
}

/** Return only the human-authored text from a structured bridge prompt. */
export function extractBridgeUserInput(input: string): string | undefined {
  const candidate = input.trimStart();
  if (!isBridgeWrappedInput(candidate)) return undefined;
  const matches = [...candidate.matchAll(/<user_input>\r?\n([\s\S]*?)\r?\n<\/user_input>/g)];
  for (let index = matches.length - 1; index >= 0; index--) {
    const body = matches[index]?.[1];
    if (!body) continue;
    try {
      const parsed = JSON.parse(body) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const text = (parsed as Record<string, unknown>).text;
      if (typeof text === 'string') return text;
    } catch {
      // Earlier system-prompt examples may contain non-JSON user_input blocks.
    }
  }
  return undefined;
}

/** Remove complete bridge runtime prompts embedded in quoted cards or tool output. */
export function redactEmbeddedBridgePrompts(input: string): string {
  let cursor = 0;
  let result = '';
  while (cursor < input.length) {
    const titleIndex = input.indexOf(BRIDGE_SYSTEM_PROMPT_TITLE, cursor);
    if (titleIndex < 0) return result + input.slice(cursor);

    const nextTitle = input.indexOf(BRIDGE_SYSTEM_PROMPT_TITLE, titleIndex + BRIDGE_SYSTEM_PROMPT_TITLE.length);
    const signatureIndex = input.indexOf(BRIDGE_SYSTEM_PROMPT_SIGNATURE, titleIndex + BRIDGE_SYSTEM_PROMPT_TITLE.length);
    if (signatureIndex < 0 || (nextTitle >= 0 && signatureIndex > nextTitle)) {
      result += input.slice(cursor, titleIndex + BRIDGE_SYSTEM_PROMPT_TITLE.length);
      cursor = titleIndex + BRIDGE_SYSTEM_PROMPT_TITLE.length;
      continue;
    }

    const blockStart = input.slice(Math.max(0, titleIndex - 2), titleIndex) === '# '
      ? titleIndex - 2
      : titleIndex;
    const closeIndex = input.indexOf('</user_input>', signatureIndex);
    if (closeIndex < 0 || (nextTitle >= 0 && closeIndex > nextTitle)) {
      return `${result}${input.slice(cursor, blockStart)}[bridge 内部运行约定已隐藏]`;
    }

    const blockEnd = closeIndex + '</user_input>'.length;
    const block = input.slice(blockStart, blockEnd);
    const extracted = extractBridgeUserInput(block);
    result += input.slice(cursor, blockStart);
    result += extracted ?? '[bridge 内部运行约定已隐藏]';
    cursor = blockEnd;
  }
  return result;
}

function isBridgeWrappedInput(input: string): boolean {
  return input.startsWith(BRIDGE_SYSTEM_PROMPT_HEADING)
    || input.startsWith(BRIDGE_SYSTEM_PROMPT_TITLE)
    || /^<(?:bridge_context|bridge_instructions)\b/.test(input);
}
