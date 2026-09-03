import { describe, expect, it } from 'vitest';
import {
  resumeCard,
  workspaceLaunchCard,
  workspaceNewCard,
} from '../../../src/card/templates.js';

function walk(value: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  visit(record);
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) child.forEach((entry) => walk(entry, visit));
    else walk(child, visit);
  }
}

function actions(card: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  walk(card, (record) => {
    if (record.value && typeof record.value === 'object') {
      found.push(record.value as Record<string, unknown>);
    }
  });
  return found;
}

describe('Codex workspace launch cards', () => {
  it('offers a direct resume callback from the workspace selection form', () => {
    const card = workspaceLaunchCard({
      cwd: '/data/project',
      profiles: ['freerouter'],
      configuredProfile: 'freerouter',
      routesToProjectGroup: true,
      projectChatName: 'Codex 项目群｜project',
    });

    expect(actions(card)).toContainEqual({ cmd: 'ws.resume' });
  });

  it('renders Codex thread IDs in disabled, selectable inputs and offers new-session action', () => {
    const threadId = '019abcde-0123-4567-89ab-cdef01234567';
    const card = resumeCard('/data/project', [{
      sessionId: 'resume-nonce',
      displayId: threadId,
      preview: 'research run',
      relTime: '刚刚',
      detail: 'Codex · cli',
      copyableId: true,
    }], { showNewCodexAction: true });

    const inputs: Record<string, unknown>[] = [];
    walk(card, (record) => {
      if (record.tag === 'input') inputs.push(record);
    });
    expect(inputs).toContainEqual(expect.objectContaining({
      default_value: threadId,
      input_type: 'text',
      disabled: true,
    }));
    expect(actions(card)).toContainEqual({ cmd: 'resume.copy', arg: threadId });
    expect(actions(card)).toContainEqual({ cmd: 'ws.new' });
  });

  it('offers resume from the new-session confirmation card', () => {
    const card = workspaceNewCard({ cwd: '/data/project', profile: 'freerouter' });

    expect(JSON.stringify(card)).toContain('/data/project');
    expect(JSON.stringify(card)).toContain('freerouter');
    expect(actions(card)).toContainEqual({ cmd: 'ws.resume' });
  });
});
