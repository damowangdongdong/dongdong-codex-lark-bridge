/**
 * Feishu/Lark renders fenced code blocks with a native copy button. Keeping
 * the value in its own block means one click copies the exact thread ID to
 * the user's clipboard without a server-side card callback.
 */
export function codexThreadIdMarkdown(
  threadId: string,
  label = 'Codex thread ID',
): string {
  return [
    `🔗 **${label}**（点击代码块右上角复制）`,
    '```text',
    threadId,
    '```',
  ].join('\n');
}

export function copyableShellCommandMarkdown(command: string): string {
  return ['```bash', command, '```'].join('\n');
}
