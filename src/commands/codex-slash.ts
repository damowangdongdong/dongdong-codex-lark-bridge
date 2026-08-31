export type CodexSlashSurface = 'bridge' | 'app-server' | 'attached-tui' | 'hybrid';

/**
 * Codex CLI 0.151 slash-command inventory.
 *
 * `bridge` commands have a native Feishu interaction, `app-server` commands
 * map to a Codex RPC, `attached-tui` commands depend on terminal-local UI
 * state, and `hybrid` commands retain a bridge control spelling while also
 * exposing the Codex behavior.
 */
export const CODEX_SLASH_COMMANDS = {
  '/permissions': 'bridge',
  '/ide': 'attached-tui',
  '/keymap': 'attached-tui',
  '/vim': 'attached-tui',
  '/setup-default-sandbox': 'attached-tui',
  '/sandbox-add-read-dir': 'attached-tui',
  '/agent': 'attached-tui',
  '/subagents': 'attached-tui',
  '/apps': 'app-server',
  '/plugins': 'app-server',
  '/hooks': 'app-server',
  '/clear': 'bridge',
  '/rename': 'app-server',
  '/archive': 'app-server',
  '/delete': 'app-server',
  '/compact': 'app-server',
  '/copy': 'attached-tui',
  '/diff': 'attached-tui',
  '/exit': 'hybrid',
  '/experimental': 'app-server',
  '/approve': 'attached-tui',
  '/memories': 'app-server',
  '/skills': 'app-server',
  '/import': 'attached-tui',
  '/feedback': 'attached-tui',
  '/init': 'attached-tui',
  '/logout': 'attached-tui',
  '/mcp': 'app-server',
  '/mention': 'attached-tui',
  '/model': 'app-server',
  '/fast': 'app-server',
  '/plan': 'app-server',
  '/goal': 'app-server',
  '/personality': 'app-server',
  '/ps': 'hybrid',
  '/stop': 'hybrid',
  '/clean': 'app-server',
  '/fork': 'app-server',
  '/app': 'attached-tui',
  '/side': 'attached-tui',
  '/btw': 'attached-tui',
  '/raw': 'attached-tui',
  '/resume': 'bridge',
  '/new': 'bridge',
  '/quit': 'attached-tui',
  '/review': 'app-server',
  '/status': 'bridge',
  '/usage': 'app-server',
  '/debug-config': 'app-server',
  '/statusline': 'attached-tui',
  '/title': 'attached-tui',
  '/theme': 'attached-tui',
  '/pets': 'attached-tui',
  '/pet': 'attached-tui',
  // User-facing compatibility spelling requested by the bridge workflow.
  '/permission': 'bridge',
} as const satisfies Record<string, CodexSlashSurface>;

export type CodexSlashCommand = keyof typeof CODEX_SLASH_COMMANDS;

export function codexSlashSurface(command: string): CodexSlashSurface | undefined {
  return CODEX_SLASH_COMMANDS[command as CodexSlashCommand];
}
