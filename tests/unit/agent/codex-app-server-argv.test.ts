import { describe, expect, it } from 'vitest';
import { buildCodexAppServerArgs } from '../../../src/agent/codex/app-server-argv.js';

describe('Codex app-server argv contract', () => {
  it('starts the default Codex configuration without a profile flag', () => {
    expect(buildCodexAppServerArgs({ endpoint: 'unix:///tmp/codex.sock' })).toEqual([
      '--ignore-rules',
      '-c',
      'shell_environment_policy.inherit="all"',
      'app-server',
      '--listen',
      'unix:///tmp/codex.sock',
    ]);
  });

  it('puts a selected profile before the app-server subcommand', () => {
    expect(
      buildCodexAppServerArgs({
        endpoint: 'ws://127.0.0.1:4500',
        profile: 'freerouter',
      }),
    ).toEqual([
      '--profile',
      'freerouter',
      '--ignore-rules',
      '-c',
      'shell_environment_policy.inherit="all"',
      'app-server',
      '--listen',
      'ws://127.0.0.1:4500',
    ]);
  });

  it('rejects mutually exclusive profile and isolated user config', () => {
    expect(() =>
      buildCodexAppServerArgs({
        endpoint: 'unix:///tmp/codex.sock',
        profile: 'freerouter',
        ignoreUserConfig: true,
      }),
    ).toThrow(/profile.*ignore-user-config/);
  });
});
