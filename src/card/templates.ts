interface ButtonSpec {
  text: string;
  value: Record<string, unknown>;
  style?: 'primary' | 'danger' | 'default';
  confirm?: {
    title: string;
    text: string;
  };
}

function button(spec: ButtonSpec): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: spec.text },
    type: spec.style ?? 'default',
    value: spec.value,
    ...(spec.confirm
      ? {
          confirm: {
            title: { tag: 'plain_text', content: spec.confirm.title },
            text: { tag: 'plain_text', content: spec.confirm.text },
          },
        }
      : {}),
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
  routesToProjectGroup?: boolean;
  projectChatName?: string;
}

export function workspaceLaunchCard(options: WorkspaceLaunchCardOptions): object {
  const initialProfile = options.configuredProfile && options.profiles.includes(options.configuredProfile)
    ? options.configuredProfile
    : '__default__';
  return shell('🚀 选择 Codex 启动方式', [
    divMd(
      `已选择工作目录：\`${escapeCode(options.cwd)}\`\n\n` +
      '请选择 Codex CLI profile，以及要创建新会话还是恢复历史会话。' +
      (options.routesToProjectGroup
        ? '继续后会进入该路径的专属项目群；已有群会直接复用且不会重命名。'
        : '此卡片不会自动启动 Codex。'),
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
        ...(options.routesToProjectGroup && options.projectChatName
          ? [
              {
                tag: 'markdown',
                content: '**项目群名称（仅首次创建时生效）**\n_可直接修改；已有路径群会原样复用。_',
              },
              {
                tag: 'input',
                name: 'project_chat_name',
                default_value: options.projectChatName,
                placeholder: { tag: 'plain_text', content: options.projectChatName },
                input_type: 'text',
              },
            ]
          : []),
        { tag: 'markdown', content: '**会话方式**' },
        {
          tag: 'select_static',
          name: 'launch_mode',
          initial_option: 'resume',
          options: [
            { text: { tag: 'plain_text', content: '恢复历史会话' }, value: 'resume' },
            { text: { tag: 'plain_text', content: '创建新 Codex 会话' }, value: 'new' },
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
  sessionLabel?: string;
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
    ? `\`${info.sessionId.slice(0, 8)}…\`${info.sessionStale ? ' ⚠️ 旧工作目录，下一条会新建' : ''}`
    : (info.emptySessionText ?? '(无)');
  // For topic groups, surface that the scope is per-topic so the user
  // knows /cd / /new only affect this topic.
  const scopeLine =
    info.chatMode === 'topic'
      ? `\`${escapeCode(info.scope)}\` _（话题独立会话）_`
      : `\`${escapeCode(info.scope)}\``;
  const cwdLine = info.cwd ? `\`${escapeCode(info.cwd)}\`` : '(未设置)';
  const queueLine = info.queue
    ? `运行中 ${info.queue.active}/${info.queue.cap}，等待 ${info.queue.waiting}`
    : '未知';
  const larkCliLine = info.larkCliStatus
    ? {
        app: '应用身份',
        'user-ready': '用户身份已就绪',
        'user-missing': '缺少用户授权',
        'check-failed': '状态检查失败',
      }[info.larkCliStatus]
    : undefined;
  const lines = [
    `🧭 **对话范围**: ${scopeLine}`,
    `🧩 **Bridge 配置**: ${escapeMd(info.profileName)}`,
    `📁 **工作目录**: ${cwdLine}`,
    `🔗 **${escapeMd(info.sessionLabel ?? '会话')}**: ${sessionLine}`,
    `🤖 **Agent**: ${escapeMd(info.agentName)}`,
    ...(info.codexProfile ? [`⚙️ **Codex 配置**: ${escapeMd(info.codexProfile)}`] : []),
    `🛡 **${escapeMd(info.runtimeAccess.label)}**: ${escapeMd(info.runtimeAccess.value)}`,
    ...(info.codexLaunchState ? [`🚀 **会话方式**: ${escapeMd(info.codexLaunchState)}`] : []),
    ...(larkCliLine ? [`🔐 **lark-cli 身份**: ${larkCliLine}`] : []),
    `🏃 **当前任务**: ${info.activeRun ? '运行中' : '无'}`,
    ...(info.activeScopes && info.activeScopes.length > 0
      ? [
          `🏃 **运行中的范围**: ${info.activeScopes.map((scope) => `\`${escapeCode(scope)}\``).join(', ')}`,
        ]
      : []),
    ...(info.activeCommentScopes && info.activeCommentScopes.length > 0
      ? [
          `📝 **文档评论任务**: ${info.activeCommentScopes.map((scope) => `\`${escapeCode(scope)}\``).join(', ')}`,
        ]
      : []),
    `🚦 **队列**: ${queueLine}`,
    `👤 **管理员身份**: ${escapeMd(info.ownerState)}`,
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

export function resumeTakeoverCard(threadId: string, nonce: string): object {
  return shell('⚠️ Codex 会话正在使用中', [
    divMd(
      `thread \`${escapeCode(threadId.slice(0, 8))}…\` 正由另一个 Codex 进程持有。` +
      '\n\n接管会终止该 Codex 进程，其中正在运行的其他会话也会中断。',
    ),
    actions([
      {
        text: '终止占用并接管',
        value: { cmd: 'resume.takeover', arg: nonce },
        style: 'danger',
        confirm: {
          title: '确认接管会话？',
          text: '将终止当前持有该 thread 的 Codex 进程，然后在飞书中恢复会话。',
        },
      },
      { text: '重新加载会话列表', value: { cmd: 'resume' } },
    ]),
  ]);
}

export function helpCard(agentName = 'Agent', botName?: string): object {
  const visibleBotName = botName?.trim() || agentName;
  const escapedBotName = escapeMd(visibleBotName);
  const escapedAgentName = escapeMd(agentName);
  const codex = /codex/i.test(agentName);

  const quickStart = codex
    ? [
        `1. 打开与 **${escapedBotName}** 的私聊；这里是默认入口，不需要 @。`,
        '2. 发送 `/cd <绝对路径>`，例如 `/cd /Users/me/project`；也可以用 `/ws use <名称>` 选择已保存目录。',
        '3. 在启动卡中选择 **Codex CLI profile**、**新建/恢复会话**；首次建群时还可以修改项目群名称。',
        `4. 点击“继续”，进入该路径的项目群；群里默认用 **@${escapedBotName} + 任务** 开始工作。`,
        '',
        '_同一路径会复用仍可访问的项目群；如果你已退出旧群，再次从私聊选择该路径会新建一个可访问的群。_',
      ]
    : [
        `1. 打开与 **${escapedBotName}** 的私聊；这里是默认入口，不需要 @。`,
        '2. 发送 `/cd <绝对路径>` 选择工作目录，或用 `/ws use <名称>` 切换已保存目录。',
        `3. 直接把任务发给 ${escapedAgentName}；群聊中默认需要 @${escapedBotName}。`,
        '4. 用 `/resume` 继续历史会话，或用 `/new` 开始全新会话。',
      ];

  const panels: object[] = [
    tutorialPanel('🚀 四步快速开始', quickStart, true),
    tutorialPanel('📁 工作目录与项目群', [
      '- `/cd <绝对路径>` — 切换当前工作目录。',
      '- `/ws list` — 查看当前目录和已保存目录。',
      '- `/ws save <名称>` / `/ws use <名称>` / `/ws remove <名称>` — 保存、切换或删除目录快捷方式。',
      ...(codex
        ? [
            '- `/new chat [名称]` — 为当前路径进入独立项目群，并创建新的 Codex thread。',
            '- `/profile` — 在项目群内重新选择 Codex CLI profile，以及新建或恢复会话。',
            '- 每个规范化路径只绑定一个当前项目群；仍在群里就复用，已退群就重新创建。',
          ]
        : []),
    ]),
    tutorialPanel('🔁 会话、历史与终端同步', [
      '- `/new`、`/clear`、`/reset` — 清空当前聊天或话题的会话，下一条任务从新会话开始。',
      '- `/resume [N]` — 浏览并恢复历史会话；恢复后会先展示默认折叠的完整历史。',
      ...(codex
        ? [
            '- `/attach` — 生成精确的本机终端命令，把 Codex TUI 附着到当前 thread。',
            '- 飞书与附着终端共享同一 thread：任一端输入，进度和最终回答都会同步。',
            '- 任务运行时，`↵ 立即插入` 会立刻补充当前任务；`⇥ 排队` 会等当前任务结束后执行。',
            '- 每轮结束会发送默认折叠的完整轨迹；点击章节可查看 reasoning、进度、工具输入输出和用量。',
          ]
        : []),
    ]),
    tutorialPanel('💬 对话、附件与云文档', [
      `- 私聊直接发送任务；群聊和话题群默认需要 **@${escapedBotName}**，可在 \`/config\` 调整。`,
      '- 可以回复引用一条消息再提问；首次进入话题时，Bot 会读取该话题已有上下文。',
      '- 图片或文件可和任务一起发送；Bridge 会按当前附件策略处理，再把可用附件交给 Agent。',
      '- 在支持的飞书云文档评论中 @Bot 即可提问；回复仍写回同一评论线程，不需要 `/doc` 绑定。',
      '- `/stop comment:<scopeHash>` 和 `/timeout comment:<scopeHash> N` 可由管理员控制评论任务。',
    ]),
    tutorialPanel('🧰 运行控制与显示', [
      '- `/status` — 查看当前 profile、工作目录、会话、权限、lark-cli 身份、运行和排队状态。',
      '- `/config` — 设置模型、回复样式、工具调用、COT 过程消息、并发、探活、群聊 @ 和 lark-cli 身份策略。',
      ...(codex
        ? [
            '- `/permissions` — 查看或设置当前聊天/话题的 `read-only`、`workspace-write`、`danger-full-access`。',
            '- `/stop` — 中断当前 turn；没有活动 turn 时停止当前 thread 的后台终端。',
            '- `/ps` — 查看当前 thread 的后台终端；`/stop terminals` 或 `/clean` 停止它们。',
            '- `/codex commands` — 查看当前 Codex 完整命令清单，以及哪些命令在飞书、app-server 或附着 TUI 中执行。',
          ]
        : ['- `/stop` — 中断当前任务；也可以点运行卡底部的“⏹ 终止”。']),
      '- `/timeout [N|off|default]` — 查看或调整当前 session 的空闲探活。',
    ]),
    tutorialPanel('🎙 会议与 lark-cli', [
      '- 会议能力需管理员先在 `/config` 或 Web 控制台启用并重启 Bot。',
      '- `/meeting join <9位会议号>` — 让 Bot 入会；`/meeting` 查看当前会议。',
      '- `/meeting ask <问题>`、`/meeting notes [会议号]`、`/meeting transcript [会议号]`、`/meeting stop [会议号]`、`/meeting leave [会议号]` — 提问、纪要、查看字幕、中断和离会。',
      '- lark-cli 默认使用应用身份；需要访问个人文档、日历等资源时，在 `/config` 切换并完成用户授权。',
      '- `/status` 会显示 lark-cli 当前是应用身份，还是用户身份已就绪。',
    ]),
    tutorialPanel('🛠 管理与故障排查', [
      '- `/doctor [现象描述]` — 运行低敏诊断，并让 Agent 结合描述分析。',
      '- `/reconnect` — 网络恢复后强制重连飞书 WebSocket。',
      `- \`${codex ? '/ps bridge' : '/ps'}\` — 查看本机 Bridge 进程；\`/exit <id|#>\` 关闭指定进程。`,
      '- `/account` — 查看当前飞书应用；`/account change` 更换凭据并重连。',
      '- `/invite` / `/remove` — 管理允许使用 Bot 的用户、管理员和群聊。',
      ...(codex
        ? ['- `/delete` 先预览；只有 `/delete confirm` 才会永久删除当前 Codex thread 及子 thread。']
        : []),
      '- 任何时候发送 `/help` 都能重新打开本教程。',
    ]),
  ];

  return {
    schema: '2.0',
    config: { summary: { content: `${visibleBotName} 使用教程` } },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: `💡 ${visibleBotName} 使用教程` },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            `**默认入口：与 ${escapedBotName} 的私聊**\n\n` +
            '从私聊选择项目，再去专属项目群持续工作。项目群里也可以发送 `/help` 查看同一份教程。',
        },
        { tag: 'hr' },
        ...panels,
        { tag: 'hr' },
        tutorialActions(),
      ],
    },
  };
}

function tutorialPanel(title: string, lines: string[], expanded = false): object {
  return {
    tag: 'collapsible_panel',
    expanded,
    header: {
      title: { tag: 'markdown', content: `**${title}**` },
      vertical_align: 'center',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        size: '16px 16px',
      },
      icon_position: 'follow_text',
      icon_expanded_angle: -180,
    },
    border: { color: expanded ? 'blue' : 'grey', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: lines.join('\n'), text_size: 'notation' }],
  };
}

function tutorialActions(): object {
  const specs: Array<{ text: string; cmd: string; primary?: boolean }> = [
    { text: '📊 状态', cmd: 'status', primary: true },
    { text: '🔁 恢复会话', cmd: 'resume' },
    { text: '📂 工作目录', cmd: 'ws.list' },
    { text: '🆕 新会话', cmd: 'new' },
  ];
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: 'small',
    columns: specs.map((spec) => ({
      tag: 'column',
      width: 'auto',
      elements: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: spec.text },
          ...(spec.primary ? { type: 'primary' } : {}),
          behaviors: [{ type: 'callback', value: { cmd: spec.cmd } }],
        },
      ],
    })),
  };
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(s: string): string {
  return s.replace(/`/g, "'");
}
