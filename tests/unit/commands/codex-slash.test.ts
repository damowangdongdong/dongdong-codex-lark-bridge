import { describe, expect, it } from 'vitest';
import {
  CODEX_SLASH_COMMANDS,
  codexSlashSurface,
} from '../../../src/commands/codex-slash.js';

const CODEX_COMPATIBLE_COMMANDS = [
  '/permissions',
  '/ide',
  '/keymap',
  '/vim',
  '/setup-default-sandbox',
  '/sandbox-add-read-dir',
  '/agent',
  '/subagents',
  '/apps',
  '/plugins',
  '/hooks',
  '/clear',
  '/rename',
  '/archive',
  '/delete',
  '/compact',
  '/copy',
  '/diff',
  '/exit',
  '/experimental',
  '/approve',
  '/memories',
  '/skills',
  '/import',
  '/feedback',
  '/init',
  '/logout',
  '/mcp',
  '/mention',
  '/model',
  '/fast',
  '/plan',
  '/goal',
  '/personality',
  '/ps',
  '/stop',
  '/clean',
  '/fork',
  '/app',
  '/side',
  '/btw',
  '/raw',
  '/resume',
  '/new',
  '/quit',
  '/review',
  '/status',
  '/usage',
  '/debug-config',
  '/statusline',
  '/title',
  '/theme',
  '/pets',
  '/pet',
];

describe('Codex slash command registry', () => {
  it('covers the Codex CLI-compatible commands and documented aliases', () => {
    const registered = Object.keys(CODEX_SLASH_COMMANDS).filter(
      (command) =>
        command !== '/permission' && command !== '/profile' && command !== '/skill',
    );
    expect(registered.sort()).toEqual([...CODEX_COMPATIBLE_COMMANDS].sort());
  });

  it('keeps the requested singular permissions alias and rejects unknown commands', () => {
    expect(codexSlashSurface('/permission')).toBe('bridge');
    expect(codexSlashSurface('/profile')).toBe('bridge');
    expect(codexSlashSurface('/skill')).toBe('app-server');
    expect(codexSlashSurface('/logout')).toBe('app-server');
    expect(codexSlashSurface('/title')).toBe('app-server');
    expect(codexSlashSurface('/btw')).toBe('attached-tui');
    expect(codexSlashSurface('/clean')).toBe('app-server');
    expect(codexSlashSurface('/does-not-exist')).toBeUndefined();
  });
});
