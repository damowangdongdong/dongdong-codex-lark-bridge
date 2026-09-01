import { extractBridgeUserInput } from '../agent/prompt';

const DEFAULT_PREVIEW_MAX_CHARS = 80;

export function normalizeSessionPreview(input: string, maxChars = DEFAULT_PREVIEW_MAX_CHARS): string {
  const text = extractBridgeUserInput(input) ?? input;
  return truncatePreview(text.replace(/\s+/g, ' ').trim(), maxChars);
}

function truncatePreview(input: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  const chars = Array.from(input);
  return chars.length > maxChars ? chars.slice(0, maxChars).join('') : input;
}
