import { describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import {
  fetchGrantedScopes,
  requireProjectChatScopes,
} from '../../../src/bot/app-scope.js';

function channelWithScopes(scopes: string[]): LarkChannel {
  return {
    rawClient: {
      application: {
        v6: {
          application: {
            get: vi.fn(async () => ({
              data: { app: { scopes: scopes.map((scope) => ({ scope })) } },
            })),
          },
        },
      },
    },
  } as unknown as LarkChannel;
}

describe('app scope checks', () => {
  it('reads granted scopes from the v6 application endpoint', async () => {
    const channel = channelWithScopes(['im:chat', 'im:chat.members:read']);

    await expect(fetchGrantedScopes(channel, 'cli_test')).resolves.toEqual(
      new Set(['im:chat', 'im:chat.members:read']),
    );
  });

  it('accepts the project-group scopes needed by Codex', async () => {
    await expect(
      requireProjectChatScopes(
        channelWithScopes(['im:chat', 'im:chat.members:read']),
        'cli_test',
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects startup when create or member-read scope is missing', async () => {
    await expect(
      requireProjectChatScopes(channelWithScopes(['im:chat:readonly']), 'cli_test'),
    ).rejects.toThrow(/im:chat/);
    await expect(
      requireProjectChatScopes(channelWithScopes(['im:chat']), 'cli_test'),
    ).resolves.toBeUndefined();
  });

  it('fails closed when the app-scope endpoint cannot be queried', async () => {
    const channel = channelWithScopes([]);
    const get = channel.rawClient.application.v6.application.get as unknown as ReturnType<typeof vi.fn>;
    get.mockRejectedValueOnce(new Error('permission denied'));

    await expect(requireProjectChatScopes(channel, 'cli_test')).rejects.toThrow(/无法确认/);
  });
});
