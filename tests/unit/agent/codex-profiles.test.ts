import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverCodexProfiles,
  parseCodexProfileNames,
} from '../../../src/config/codex-profiles.js';

const cleanup: string[] = [];

describe('Codex profile discovery', () => {
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('parses bare and quoted profile tables without treating ordinary tables as profiles', () => {
    expect(parseCodexProfileNames(`
model = "default"
[profiles.freerouter]
model_provider = "free"
[profiles."work fast"]
model = "gpt"
[mcp_servers.example]
command = "example"
`)).toEqual(['freerouter', 'work fast']);
  });

  it('merges user and project Codex profiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-profiles-'));
    cleanup.push(root);
    const codexHome = join(root, 'codex-home');
    const cwd = join(root, 'workspace');
    await Promise.all([mkdir(codexHome), mkdir(join(cwd, '.codex'), { recursive: true })]);
    await Promise.all([
      writeFile(join(codexHome, 'config.toml'), '[profiles.freerouter]\nmodel = "free"\n'),
      writeFile(join(codexHome, 'work.config.toml'), 'model = "work"\n'),
      writeFile(join(cwd, '.codex', 'config.toml'), '[profiles.local]\nmodel = "local"\n'),
    ]);

    await expect(discoverCodexProfiles({ cwd, codexHome })).resolves.toEqual([
      'freerouter',
      'local',
      'work',
    ]);
  });
});
