import { describe, expect, it } from 'vitest';
import {
  codexSkillsCard,
  resumeCard,
  resumeHistoryChoiceCard,
  resumeTakeoverCard,
  statusCard,
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

function textContent(card: unknown): string {
  const found: string[] = [];
  walk(card, (record) => {
    if (typeof record.content === 'string') found.push(record.content);
  });
  return found.join('\n');
}

function expectCopyableThreadId(card: unknown, threadId: string): void {
  expect(textContent(card)).toContain(`\`\`\`text\n${threadId}\n\`\`\``);
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

  it('renders each full Codex thread ID in a native copyable code block', () => {
    const threadId = '019abcde-0123-4567-89ab-cdef01234567';
    const card = resumeCard('/data/project', [{
      sessionId: 'resume-nonce',
      displayId: threadId,
      preview: 'research run',
      relTime: '刚刚',
      detail: 'Codex · cli',
    }], { showNewCodexAction: true, copyableIds: true });

    expectCopyableThreadId(card, threadId);
    expect(textContent(card)).toContain('点击代码块右上角复制');
    expect(JSON.stringify(card)).not.toContain('resume.copy');
    expect(actions(card)).toContainEqual({ cmd: 'ws.new' });
  });

  it('renders Codex status and takeover IDs as full copyable code blocks', () => {
    const threadId = '019abcde-0123-4567-89ab-cdef01234567';
    const status = statusCard({
      profileName: 'default',
      sessionId: threadId,
      copyableSessionId: true,
      sessionStale: false,
      agentName: 'Codex',
      runtimeAccess: { label: '权限', value: 'Full access' },
      activeRun: false,
      ownerState: '正常',
      scope: 'oc_chat',
      chatMode: 'group',
    });
    const takeover = resumeTakeoverCard(threadId, 'nonce');

    expectCopyableThreadId(status, threadId);
    expectCopyableThreadId(takeover, threadId);
    expect(textContent(status)).not.toContain(`${threadId.slice(0, 8)}…`);
    expect(textContent(takeover)).not.toContain(`${threadId.slice(0, 8)}…`);
  });

  it('renders each skill in its own collapsible panel within the paged card', () => {
    const card = codexSkillsCard({
      entries: [
        {
          cwd: '/data/project',
          name: 'alpha',
          displayName: 'Alpha',
          description: 'First skill',
          scope: 'user',
          enabled: true,
        },
        {
          cwd: '/data/project',
          name: 'beta',
          description: 'Second skill',
          scope: 'system',
          enabled: false,
        },
      ],
      page: 1,
      pageCount: 3,
      total: 6,
    }) as { schema?: string; body?: { elements?: Array<Record<string, unknown>> } };

    const panels = (card.body?.elements ?? []).filter((element) => element.tag === 'collapsible_panel');
    expect(card.schema).toBe('2.0');
    expect(panels).toHaveLength(2);
    expect(panels[0]).toMatchObject({ expanded: false, border: { color: 'blue' } });
    expect(panels[1]).toMatchObject({ expanded: false, border: { color: 'grey' } });
    expect(JSON.stringify(panels[0])).toContain('$alpha');
    expect(JSON.stringify(panels[0])).not.toContain('$beta');
    expect(JSON.stringify(panels[1])).toContain('$beta');
    expect(JSON.stringify(panels[1])).not.toContain('$alpha');
  });

  it('offers send and skip actions for resumed history context', () => {
    const card = resumeHistoryChoiceCard('history-nonce');
    expect(actions(card)).toContainEqual({ cmd: 'resume.history.send', arg: 'history-nonce' });
    expect(actions(card)).toContainEqual({ cmd: 'resume.history.skip', arg: 'history-nonce' });
  });

  it('offers resume from the new-session confirmation card', () => {
    const card = workspaceNewCard({ cwd: '/data/project', profile: 'freerouter' });

    expect(JSON.stringify(card)).toContain('/data/project');
    expect(JSON.stringify(card)).toContain('freerouter');
    expect(actions(card)).toContainEqual({ cmd: 'ws.resume' });
  });
});
