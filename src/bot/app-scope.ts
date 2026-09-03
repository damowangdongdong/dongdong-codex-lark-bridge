import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';

/**
 * Scope that lets the app receive group messages that DON'T @ the bot.
 * Without it, Feishu's event gateway only pushes @-bot group messages, so
 * `requireMentionInGroup: false` silently has no effect. Kept as a named
 * constant so it's easy to adjust if the platform renames the scope id.
 */
export const GROUP_MSG_SCOPE = 'im:message.group_msg';

/**
 * The app-identity scopes needed by Codex's path-bound project groups.
 * `im:chat` is required to create the group. Feishu accepts any one of the
 * member-read scopes below for the roster lookup used to decide whether an
 * existing project group can be reused.
 */
export const PROJECT_CHAT_CREATE_SCOPE = 'im:chat';
export const PROJECT_CHAT_MEMBER_SCOPE_ALTERNATIVES = [
  'im:chat:readonly',
  'im:chat',
  'im:chat.group_info:readonly',
  'im:chat.members:read',
] as const;

function appScopeConsoleUrl(appId: string): string {
  const scopes = [...new Set([
    PROJECT_CHAT_CREATE_SCOPE,
    ...PROJECT_CHAT_MEMBER_SCOPE_ALTERNATIVES,
  ])].join(',');
  return `https://open.feishu.cn/app/${encodeURIComponent(appId)}/auth?q=${encodeURIComponent(scopes)}&op_from=openapi&token_type=tenant`;
}

/**
 * Fetch the set of scopes currently granted to this app via
 * `application.v6.application.get`. The channel's `getAppInfo()` only
 * surfaces owner/name, so we read the `scopes` array off the raw node-sdk
 * client instead.
 *
 * Returns `null` on API failure. Callers decide whether an unknown scope set
 * is tolerable; startup validation fails closed, while optional diagnostics
 * can treat it as unavailable.
 */
export async function fetchGrantedScopes(
  channel: LarkChannel,
  appId: string,
): Promise<Set<string> | null> {
  try {
    const res = await channel.rawClient.application.v6.application.get({
      params: { lang: 'zh_cn', user_id_type: 'open_id' },
      path: { app_id: appId },
    });
    const scopes = res.data?.app?.scopes ?? [];
    return new Set(scopes.map((s) => s.scope));
  } catch (err) {
    log.warn('app-scope', 'fetch-failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Whether the app has the group-message scope.
 * `null` means the lookup failed (treat as "don't know" — see above).
 */
export async function hasGroupMsgScope(
  channel: LarkChannel,
  appId: string,
): Promise<boolean | null> {
  const scopes = await fetchGrantedScopes(channel, appId);
  if (scopes === null) return null;
  return scopes.has(GROUP_MSG_SCOPE);
}

/**
 * Fail startup when Codex project-group operations cannot work. Bot scopes
 * are granted to the app in the Feishu developer console; they cannot be
 * elevated by a running bridge or by a user OAuth login.
 */
export async function requireProjectChatScopes(
  channel: LarkChannel,
  appId: string,
): Promise<void> {
  const scopes = await fetchGrantedScopes(channel, appId);
  if (scopes === null) {
    throw new Error(
      `无法确认飞书应用身份权限（app ${appId}）。请在开发者后台开通项目群所需权限后重启 bridge。`,
    );
  }

  const missing: string[] = [];
  if (!scopes.has(PROJECT_CHAT_CREATE_SCOPE)) {
    missing.push(PROJECT_CHAT_CREATE_SCOPE);
  }
  if (!PROJECT_CHAT_MEMBER_SCOPE_ALTERNATIVES.some((scope) => scopes.has(scope))) {
    missing.push(PROJECT_CHAT_MEMBER_SCOPE_ALTERNATIVES.join(' / '));
  }
  if (missing.length > 0) {
    throw new Error(
      `飞书应用身份权限未开通：${missing.join('；')}。请在开发者后台为 app ${appId} 开通后重启 bridge：${appScopeConsoleUrl(appId)}`,
    );
  }
}
