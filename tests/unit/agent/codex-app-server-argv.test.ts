import { describe, expect, it } from 'vitest';
import { buildCodexAppServerArgs } from '../../../src/agent/codex/app-server-argv.js';

describe('Codex app-server argv contract', () => {
  it('starts the default Codex configuration without a profile flag', () => {
    expect(buildCodexAppServerArgs({ endpoint: 'unix:///tmp/codex.sock' })).toEqual([
      '-c',
      'shell_environment_policy.inherit="all"',
      '-c',
      'tools.update_plan.enabled=true',
      'app-server',
      '--listen',
      'unix:///tmp/codex.sock',
    ]);
  });

  it('starts app-server without the runtime-only profile flag', () => {
    expect(buildCodexAppServerArgs({ endpoint: 'ws://127.0.0.1:4500' })).toEqual([
      '-c',
      'shell_environment_policy.inherit="all"',
      '-c',
      'tools.update_plan.enabled=true',
      'app-server',
      '--listen',
      'ws://127.0.0.1:4500',
    ]);
  });

});
