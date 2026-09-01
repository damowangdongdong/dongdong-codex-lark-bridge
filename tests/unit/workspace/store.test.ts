import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceStore } from '../../../src/workspace/store.js';

const cleanup: string[] = [];

describe('WorkspaceStore new chat inheritance', () => {
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('persists Codex settings for a fresh thread in the new scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-new-chat-'));
    cleanup.push(root);
    const path = join(root, 'workspaces.json');
    const store = new WorkspaceStore(path);
    store.setCwd('dm', '/repo/project');
    store.setCodexLaunch('dm', 'freerouter', 'resume');
    store.confirmCodexResume('dm');
    store.setCodexSandbox('dm', 'danger-full-access');
    store.setCodexModel('dm', 'gpt-test');
    store.setCodexPersonality('dm', 'pragmatic');
    store.inheritForNewScope('dm', 'project-chat', '/repo/project');
    await store.flush();

    const reloaded = new WorkspaceStore(path);
    await reloaded.load();
    expect(reloaded.selectionFor('project-chat')).toEqual({
      cwd: '/repo/project',
      codexProfile: 'freerouter',
      launchMode: 'new',
      codexSandbox: 'danger-full-access',
      codexModel: 'gpt-test',
      codexPersonality: 'pragmatic',
    });
  });
});
