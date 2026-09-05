import { describe, expect, it } from 'vitest';
import { codexModelCard } from '../../../src/card/templates.js';

describe('Codex model card', () => {
  it('renders model and reasoning-effort dropdowns with the current selections', () => {
    const card = codexModelCard({
      models: [
        {
          value: 'default',
          label: '跟随 Codex 默认模型',
          supportedEfforts: ['low', 'medium', 'high'],
        },
        {
          value: 'gpt-5.3-codex',
          label: 'GPT-5.3-Codex',
          supportedEfforts: ['medium', 'high', 'xhigh'],
        },
      ],
      currentModel: 'gpt-5.3-codex',
      currentEffort: 'high',
    }) as { body?: { elements?: unknown[] } };

    const rendered = JSON.stringify(card);
    expect(rendered).toContain('"name":"codex_model"');
    expect(rendered).toContain('"initial_option":"gpt-5.3-codex"');
    expect(rendered).toContain('"name":"codex_effort"');
    expect(rendered).toContain('"initial_option":"high"');
    expect(rendered).toContain('"value":"xhigh"');
    expect(rendered).toContain('"cmd":"model.submit"');
  });
});
