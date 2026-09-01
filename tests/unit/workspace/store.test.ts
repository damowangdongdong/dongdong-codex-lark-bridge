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

  it('持久化路径到项目群的唯一映射', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-project-chat-'));
    cleanup.push(root);
    const path = join(root, 'workspaces.json');
    const store = new WorkspaceStore(path);
    store.setProjectChat('/repo/project', { chatId: 'oc_project', name: 'Codex · project' });
    await store.flush();

    const reloaded = new WorkspaceStore(path);
    await reloaded.load();
    expect(reloaded.projectChatFor('/repo/project')).toEqual({
      chatId: 'oc_project',
      name: 'Codex · project',
    });
    expect(reloaded.projectPathForChat('oc_project')).toBe('/repo/project');
    expect(reloaded.removeProjectChat('/repo/project')).toBe(true);
    expect(reloaded.projectChatFor('/repo/project')).toBeUndefined();
    await reloaded.flush();
  });

  it('在启动卡确认前保留当前路径和 Codex 设置', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-pending-launch-'));
    cleanup.push(root);
    const store = new WorkspaceStore(join(root, 'workspaces.json'));
    store.setCwd('project-chat', '/repo/old');
    store.setCodexLaunch('project-chat', 'freerouter', 'resume');
    store.confirmCodexResume('project-chat');
    store.setCodexSandbox('project-chat', 'danger-full-access');

    store.prepareCodexLaunch('project-chat', '/repo/new');

    expect(store.cwdFor('project-chat')).toBe('/repo/old');
    expect(store.pendingCodexCwdFor('project-chat')).toBe('/repo/new');
    expect(store.codexProfileFor('project-chat')).toBe('freerouter');
    store.cancelCodexLaunch('project-chat');
    expect(store.selectionFor('project-chat')).toMatchObject({
      cwd: '/repo/old',
      codexProfile: 'freerouter',
      launchMode: 'resume',
      codexSandbox: 'danger-full-access',
    });
    await store.flush();
  });

  it('持久化 Bot 默认 Codex profile，同时允许项目群覆盖', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-default-codex-profile-'));
    cleanup.push(root);
    const path = join(root, 'workspaces.json');
    const store = new WorkspaceStore(path);

    store.setDefaultCodexProfile('freerouter');
    store.setCwd('project-chat', '/repo/project');
    store.setCodexLaunch('project-chat', null, 'new');
    await store.flush();

    const reloaded = new WorkspaceStore(path);
    await reloaded.load();
    expect(reloaded.defaultCodexProfile('configured')).toBe('freerouter');
    expect(reloaded.codexProfileFor('new-chat', 'configured')).toBe('freerouter');
    expect(reloaded.codexProfileFor('project-chat', 'configured')).toBeUndefined();
  });
});
