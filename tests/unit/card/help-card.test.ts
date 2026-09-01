import { describe, expect, it } from 'vitest';
import { helpCard } from '../../../src/card/templates.js';

describe('help card', () => {
  it('renders the current Codex workflow as a readable tutorial', () => {
    const card = helpCard('Codex', '洞洞的codex') as {
      schema?: string;
      body?: { elements?: Array<Record<string, unknown>> };
    };
    const elements = card.body?.elements ?? [];
    const panels = elements.filter((element) => element.tag === 'collapsible_panel');
    const rendered = JSON.stringify(card);

    expect(card.schema).toBe('2.0');
    expect(panels).toHaveLength(7);
    expect(panels[0]).toMatchObject({ expanded: true });
    expect(panels.slice(1).every((panel) => panel.expanded === false)).toBe(true);
    expect(rendered).toContain('默认入口：与 洞洞的codex 的私聊');
    expect(rendered).toContain('/cd <绝对路径>');
    expect(rendered).toContain('Codex CLI profile');
    expect(rendered).toContain('/resume [N]');
    expect(rendered).toContain('↵ 立即插入');
    expect(rendered).toContain('⇥ 排队');
    expect(rendered).toContain('/codex commands');
    expect(rendered).toContain('附件');
    expect(rendered).toContain('云文档');
    expect(rendered).toContain('/meeting join');
    expect(rendered).toContain('lark-cli');

    const callbacks = findCallbacks(card);
    expect(callbacks).toEqual(['status', 'profile', 'resume', 'ws.list', 'new']);
  });
});

function findCallbacks(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(findCallbacks);
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  const callbackValue =
    record.type === 'callback' && typeof record.value === 'object' && record.value !== null
      ? record.value as Record<string, unknown>
      : undefined;
  const cmd = callbackValue?.cmd;
  const own = typeof cmd === 'string' ? [cmd] : [];
  return [...own, ...Object.values(record).flatMap(findCallbacks)];
}
