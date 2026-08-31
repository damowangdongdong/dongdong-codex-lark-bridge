interface ButtonSpec {
  text: string;
  value: Record<string, unknown>;
  style?: 'primary' | 'danger' | 'default';
}

function button(spec: ButtonSpec): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: spec.text },
    type: spec.style ?? 'default',
    value: spec.value,
  };
}

function divMd(content: string): object {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

function actions(buttons: ButtonSpec[]): object {
  return { tag: 'action', actions: buttons.map(button) };
}

const HR: object = { tag: 'hr' };

function shell(title: string, elements: object[]): object {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: title } },
    elements,
  };
}

export function workspacesCard(current: string | undefined, named: Record<string, string>): object {
  const entries = Object.entries(named);
  const elements: object[] = [];

  elements.push(divMd(`当前 cwd：\`${escapeCode(current ?? '(未设置)')}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('暂无命名工作目录。'));
    elements.push(
      divMd('💡 发送 `/ws save <name>` 把当前 cwd 存为命名工作目录'),
    );
  } else {
    elements.push(HR);
    entries.forEach(([name, path], i) => {
      const marker = path === current ? '  ← 当前' : '';
      elements.push(divMd(`**${escapeMd(name)}** → \`${escapeCode(path)}\`${marker}`));
      elements.push(
        actions([
          { text: '切换到此处', value: { cmd: 'ws.use', name }, style: 'primary' },
          { text: '删除', value: { cmd: 'ws.remove', name }, style: 'danger' },
        ]),
      );
      if (i < entries.length - 1) elements.push(HR);
    });
  }

  return shell('📂 工作目录', elements);
}

export interface WorkspaceLaunchCardOptions {
  cwd: string;
  profiles: string[];
  configuredProfile?: string;
}

export function workspaceLaunchCard(options: WorkspaceLaunchCardOptions): object {
  const initialProfile = options.configuredProfile && options.profiles.includes(options.configuredProfile)
    ? options.configuredProfile
    : '__default__';
  return shell('🚀 选择 Codex 启动方式', [
    divMd(
      `工作目录已切换到：\`${escapeCode(options.cwd)}\`\n\n` +
      '请选择 Codex CLI profile，以及要创建新会话还是恢复历史会话。此卡片不会自动启动 Codex。',
    ),
    {
      tag: 'form',
      name: 'workspace_launch_form',
      elements: [
        { tag: 'markdown', content: '**Codex profile**' },
        {
          tag: 'select_static',
          name: 'codex_profile',
          initial_option: initialProfile,
          options: [
            {
              text: { tag: 'plain_text', content: '默认配置（不传 --profile）' },
              value: '__default__',
            },
            ...options.profiles.map((profile) => ({
              text: { tag: 'plain_text', content: profile },
              value: profile,
            })),
          ],
        },
        { tag: 'markdown', content: '**会话方式**' },
        {
          tag: 'select_static',
          name: 'launch_mode',
          initial_option: 'resume',
          options: [
            { text: { tag: 'plain_text', content: '恢复历史会话' }, value: 'resume' },
            { text: { tag: 'plain_text', content: '创建新会话' }, value: 'new' },
          ],
        },
        {
          tag: 'button',
          name: 'launch_btn',
          text: { tag: 'plain_text', content: '继续' },
          type: 'primary',
          form_action_type: 'submit',
          behaviors: [{ type: 'callback', value: { cmd: 'ws.launch' } }],
        },
      ],
    },
  ]);
}

export interface StatusInfo {
  profileName: string;
  cwd?: string;
  sessionId?: string;
  emptySessionText?: string;
  sessionStale: boolean;
  agentName: string;
  runtimeAccess: {
    label: string;
    value: string;
  };
  larkCliStatus?: 'app' | 'user-ready' | 'user-missing' | 'check-failed';
  activeRun: boolean;
  activeScopes?: string[];
  activeCommentScopes?: string[];
  queue?: { active: number; waiting: number; cap: number };
  ownerState: string;
  /** Session scope (= chatId or chatId:threadId in topic groups). */
  scope: string;
  /** Chat mode — used to label scope. */
  chatMode: 'p2p' | 'group' | 'topic';
  codexProfile?: string;
  codexLaunchState?: string;
}

export function statusCard(info: StatusInfo): object {
  const sessionLine = info.sessionId
    ? `\`${info.sessionId.slice(0, 8)}…\`${info.sessionStale ? ' ⚠️ 旧 cwd，下一条会新建' : ''}`
    : (info.emptySessionText ?? '(无)');
  // For topic groups, surface that the scope is per-topic so the user
  // knows /cd / /new only affect this topic.
  const scopeLine =
    info.chatMode === 'topic'
      ? `\`${escapeCode(info.scope)}\` _（话题独立 session）_`
      : `\`${escapeCode(info.scope)}\``;
  const cwdLine = info.cwd ? `\`${escapeCode(info.cwd)}\`` : '(未设置)';
  const queueLine = info.queue
    ? `${info.queue.active}/${info.queue.cap} active, ${info.queue.waiting} waiting`
    : 'unknown';
  const lines = [
    `🧭 **scope**: ${scopeLine}`,
    `🧩 **profile**: ${escapeMd(info.profileName)}`,
    `📁 **cwd**: ${cwdLine}`,
    `🔗 **session**: ${sessionLine}`,
    `🤖 **agent**: ${escapeMd(info.agentName)}`,
    ...(info.codexProfile ? [`⚙️ **Codex CLI profile**: ${escapeMd(info.codexProfile)}`] : []),
    `🛡 **${escapeMd(info.runtimeAccess.label)}**: ${escapeMd(info.runtimeAccess.value)}`,
    ...(info.codexLaunchState ? [`🚀 **launch**: ${escapeMd(info.codexLaunchState)}`] : []),
    ...(info.larkCliStatus ? [`🔐 **lark-cli**: ${info.larkCliStatus}`] : []),
    `🏃 **active run**: ${info.activeRun ? 'yes' : 'no'}`,
    ...(info.activeScopes && info.activeScopes.length > 0
      ? [
          `🏃 **active scopes**: ${info.activeScopes.map((scope) => `\`${escapeCode(scope)}\``).join(', ')}`,
        ]
      : []),
    ...(info.activeCommentScopes && info.activeCommentScopes.length > 0
      ? [
          `📝 **comment runs**: ${info.activeCommentScopes.map((scope) => `\`${escapeCode(scope)}\``).join(', ')}`,
        ]
      : []),
    `🚦 **queue**: ${queueLine}`,
    `👤 **owner API**: ${escapeMd(info.ownerState)}`,
  ];
  return shell('📊 当前状态', [
    divMd(lines.join('\n')),
    HR,
    actions([
      { text: '🆕 新会话', value: { cmd: 'new' }, style: 'primary' },
      { text: '🔁 恢复会话', value: { cmd: 'resume' } },
      { text: '📂 工作目录', value: { cmd: 'ws.list' } },
      { text: '💡 帮助', value: { cmd: 'help' } },
    ]),
  ]);
}

export function permissionsCard(input: {
  current: string;
  max: string;
  activeRun: boolean;
}): object {
  return shell('🛡 Codex 权限', [
    divMd(
      `当前：**${escapeMd(input.current)}**\n配置允许的上限：**${escapeMd(input.max)}**` +
      (input.activeRun ? '\n\n_当前 turn 继续使用启动时的权限；新选择从下一轮生效。_' : ''),
    ),
    HR,
    actions([
      { text: '🔎 只读', value: { cmd: 'permissions.set', arg: 'read-only' } },
      { text: '📝 工作区可写', value: { cmd: 'permissions.set', arg: 'workspace-write' } },
      { text: '🔓 Full access', value: { cmd: 'permissions.set', arg: 'danger-full-access' }, style: 'danger' },
    ]),
  ]);
}

export interface ResumeEntry {
  sessionId: string;
  displayId?: string;
  preview: string;
  relTime: string;
  lineCount?: number;
  detail?: string;
  current?: boolean;
}

export function resumeCard(cwd: string, entries: ResumeEntry[]): object {
  const elements: object[] = [];
  elements.push(divMd(`当前 cwd：\`${escapeCode(cwd)}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('此 cwd 下没有历史会话。'));
    return shell('🔁 恢复历史会话', elements);
  }

  elements.push(HR);
  entries.forEach((e, i) => {
    const marker = e.current ? '  ← 当前' : '';
    const detail = e.detail ?? `${e.lineCount ?? 0} 条`;
    const displayId = e.displayId ?? e.sessionId;
    elements.push(
      divMd(
        `**${i + 1}.** ${escapeMd(e.preview)}${marker}\n\`${displayId.slice(0, 8)}…\` · ${e.relTime} · ${escapeMd(detail)}`,
      ),
    );
    elements.push(
      actions([
        {
          text: e.current ? '已是当前会话' : '▸ 恢复此会话',
          value: { cmd: 'resume.use', arg: e.sessionId },
          style: e.current ? 'default' : 'primary',
        },
      ]),
    );
    if (i < entries.length - 1) elements.push(HR);
  });

  return shell('🔁 恢复历史会话', elements);
}

export function helpCard(agentName = 'Agent'): object {
  const escapedAgentName = escapeMd(agentName);
  const codex = /codex/i.test(agentName);
  return shell('💡 使用帮助', [
    divMd(
      [
        '**命令列表**',
        '',
        '- `/new` `/clear` `/reset` — 清空当前 chat 的会话',
        '- `/new chat [name]` — 新建群+新会话，自动拉你进群',
        '- `/resume [N]` — 列出并恢复历史会话（最多 N 条）',
        `- \`/cd <path>\` — 切换工作目录${codex ? '，再选择 Codex profile 和新建/恢复' : '（会重置 session）'}`,
        '- `/ws list|save <name>|use <name>|remove <name>` — 工作目录',
        ...(codex
          ? [
              '- `/permissions` — 查看或持久化本 scope 的 Codex 权限',
              '- `/attach` — 在本机终端附着当前 Codex thread',
              '- 运行卡片：`↵ 立即插入` 对应 Enter；`⇥ 排队` 对应 Tab',
              '- `/codex commands` — 查看 Codex 0.151 全部 `/` 命令及执行方式',
              '- `/ps` 查看 Codex 后台终端；`/ps bridge` 查看 bot 进程',
              '- `/stop terminals` 或 `/clean` — 停止当前 thread 的后台终端',
              '- `/delete` 预览删除；`/delete confirm` 永久删除当前 thread',
              '- 终端本地/交互命令会提示用 `/attach` 执行',
            ]
          : []),
        '- `/account` — 查看当前应用；`/account change` 换 appId/secret 并重连',
        '- `/config` — 调整偏好、访问控制和 lark-cli 身份策略',
        '- `/status` — 当前状态',
        codex
          ? '- `/stop` — 优先中断当前 turn；无活动 turn 时停止 Codex 后台终端（也可点卡片底部 ⏹ 终止 按钮）'
          : '- `/stop` — 结束当前正在跑的任务（也可点卡片底部 ⏹ 终止 按钮）',
        '- `/stop comment:<scopeHash>` — 管理员停止云文档评论任务',
        '- `/timeout [N|off|default]` — 当前 session 的探活分钟数,`/config` 改全局默认',
        '- `/timeout comment:<scopeHash> N` — 管理员设置云文档评论任务探活',
        codex
          ? '- `/ps` — 列出当前 thread 的 Codex 后台终端；`/ps bridge` 列出 bot'
          : '- `/ps` — 列出本机所有 bot，标识当前正在回复的那个',
        codex
          ? '- `/exit <id|#>` — 关掉指定 bot（用 `/ps bridge` 看 id/序号）'
          : '- `/exit <id|#>` — 关掉指定 bot（用 `/ps` 看 id/序号）',
        '- `/reconnect` — 强制重连 WebSocket(网络抖动后 bot 没反应时用)',
        `- \`/doctor [描述]\` — 把日志和描述交给 ${escapedAgentName} 自助诊断`,
        '- `/help` — 本帮助',
        '',
        `其他内容直接交给 ${escapedAgentName}。`,
      ].join('\n'),
    ),
    HR,
    actions([
      { text: '📊 状态', value: { cmd: 'status' }, style: 'primary' },
      { text: '🔁 恢复会话', value: { cmd: 'resume' } },
      { text: '📂 工作目录', value: { cmd: 'ws.list' } },
      { text: '🆕 新会话', value: { cmd: 'new' } },
    ]),
  ]);
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(s: string): string {
  return s.replace(/`/g, "'");
}
