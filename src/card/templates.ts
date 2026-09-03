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

export interface CodexProfileCardOptions {
  botName: string;
  profiles: string[];
  configuredProfile?: string;
}

export function codexProfileCard(options: CodexProfileCardOptions): object {
  const initialProfile = options.configuredProfile && options.profiles.includes(options.configuredProfile)
    ? options.configuredProfile
    : '__default__';
  return {
    schema: '2.0',
    config: { summary: { content: '切换 Codex profile' } },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '⚙️ 切换 Codex profile' },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            `为 **${escapeMd(options.botName)}** 选择默认的 Codex CLI profile。\n\n` +
            '之后从本私聊使用 `/cd` 或 `/ws use` 时，启动卡会默认选中它。' +
            '已有项目群保留各自的 profile；在项目群发送 `/profile` 可单独切换。',
        },
        {
          tag: 'form',
          name: 'codex_profile_form',
          elements: [
            { tag: 'markdown', content: '**默认 Codex CLI profile**' },
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
            {
              tag: 'button',
              name: 'profile_submit',
              text: { tag: 'plain_text', content: '切换 profile' },
              type: 'primary',
              form_action_type: 'submit',
              behaviors: [{ type: 'callback', value: { cmd: 'profile.set' } }],
            },
          ],
        },
      ],
    },
  };
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
        {
          tag: 'button',
          name: 'resume_btn',
          text: { tag: 'plain_text', content: '🔁 恢复历史会话' },
          form_action_type: 'submit',
          behaviors: [{ type: 'callback', value: { cmd: 'ws.resume' } }],
        },
      ],
    },
  ]);
}

export interface WorkspaceNewCardOptions {
  cwd: string;
  profile: string;
}

export function workspaceNewCard(options: WorkspaceNewCardOptions): object {
  return shell('🆕 新建 Codex 会话', [
    divMd(
      `已选择 Codex profile：**${escapeMd(options.profile)}**\n` +
      `📁 当前 cwd：\`${escapeCode(options.cwd)}\`\n\n` +
      '下一条消息会在此工作目录创建新的 Codex 会话。',
    ),
    HR,
    actions([
      {
        text: '🔁 恢复历史会话',
        value: { cmd: 'ws.resume' },
      },
    ]),
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

export interface CodexSkillCardEntry {
  cwd: string;
  name: string;
  displayName?: string;
  description?: string;
  scope?: string;
  enabled?: boolean;
  path?: string;
}

export interface CodexSkillsCardOptions {
  entries: CodexSkillCardEntry[];
  errors?: string[];
  page: number;
  pageCount: number;
  total: number;
}

export function codexSkillsCard(options: CodexSkillsCardOptions): object {
  const elements: object[] = [
    {
      tag: 'markdown',
      content: `共 **${options.total}** 个技能 · 第 **${options.page} / ${options.pageCount}** 页`,
    },
  ];

  if (options.entries.length === 0) {
    elements.push({ tag: 'hr' }, { tag: 'markdown', content: '未发现可用技能。' });
  } else {
    elements.push({ tag: 'hr' });
    options.entries.forEach((entry, index) => {
      elements.push(codexSkillPanel(entry));
      if (index < options.entries.length - 1) elements.push({ tag: 'hr' });
    });
  }

  if (options.errors?.length) {
    elements.push(
      { tag: 'hr' },
      { tag: 'markdown', content: ['**扫描错误**', ...options.errors.map((error) => `- ${escapeMd(error)}`)].join('\n') },
    );
  }

  const pageActions: ButtonSpec[] = [];
  if (options.page > 1) {
    pageActions.push({ text: '‹ 上一页', value: { cmd: 'codex.skills.page', arg: String(options.page - 1) } });
  }
  if (options.page < options.pageCount) {
    pageActions.push({ text: '下一页 ›', value: { cmd: 'codex.skills.page', arg: String(options.page + 1) }, style: 'primary' });
  }
  if (pageActions.length) elements.push({ tag: 'hr' }, callbackActions(pageActions));

  return {
    schema: '2.0',
    config: { summary: { content: 'Codex Skills' } },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '🧩 Codex Skills' },
    },
    body: { elements },
  };
}

function codexSkillPanel(entry: CodexSkillCardEntry): object {
  const displayName = entry.displayName && entry.displayName !== entry.name
    ? ` · **${escapeMd(entry.displayName)}**`
    : '';
  const scope = entry.scope ? escapeMd(entry.scope) : '未标注范围';
  const status = entry.enabled === true
    ? '已启用'
    : entry.enabled === false
      ? '已停用'
      : '状态未知';
  const body = [
    `**技能标识**：\`$${escapeCode(entry.name)}\``,
    `**工作区**：\`${escapeCode(entry.cwd)}\``,
    `**范围**：${scope}`,
    `**状态**：${status}`,
    ...(entry.description ? [`**简介**：\n${escapeMd(entry.description)}`] : []),
    ...(entry.path ? [`**来源**：\`${escapeCode(entry.path)}\``] : []),
  ];
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'markdown', content: `**\`$${escapeCode(entry.name)}\`**${displayName}` },
      vertical_align: 'center',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        size: '16px 16px',
      },
      icon_position: 'follow_text',
      icon_expanded_angle: -180,
    },
    border: { color: entry.enabled === false ? 'grey' : 'blue', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: body.join('\n\n'), text_size: 'notation' }],
  };
}

function callbackActions(buttons: ButtonSpec[]): object {
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: 'small',
    columns: buttons.map((spec) => ({
      tag: 'column',
      width: 'auto',
      elements: [{
        tag: 'button',
        text: { tag: 'plain_text', content: spec.text },
        ...(spec.style ? { type: spec.style } : {}),
        behaviors: [{ type: 'callback', value: spec.value }],
      }],
    })),
  };
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

export function resumeCard(
  cwd: string,
  entries: ResumeEntry[],
  options: { showNewCodexAction?: boolean } = {},
): object {
  const elements: object[] = [];
  elements.push(divMd(`当前 cwd：\`${escapeCode(cwd)}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('此 cwd 下没有历史会话。'));
    if (options.showNewCodexAction) {
      elements.push(HR);
      elements.push(
        actions([
          {
            text: '🆕 不恢复，创建新 Codex 会话',
            value: { cmd: 'ws.new' },
            style: 'primary',
          },
        ]),
      );
    }
    return shell('🔁 恢复历史会话', elements);
  }

  elements.push(HR);
  entries.forEach((e, i) => {
    const marker = e.current ? '  ← 当前' : '';
    const detail = e.detail ?? `${e.lineCount ?? 0} 条`;
    const displayId = e.displayId ?? e.sessionId;
    elements.push(
      divMd(
        `**${i + 1}.** ${escapeMd(e.preview)}${marker}\n\`${escapeCode(displayId)}\` · ${escapeMd(e.relTime)} · ${escapeMd(detail)}`,
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

  if (options.showNewCodexAction) {
    elements.push(HR);
    elements.push(
      actions([
        {
          text: '🆕 不恢复，创建新 Codex 会话',
          value: { cmd: 'ws.new' },
          style: 'primary',
        },
      ]),
    );
  }

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

/** Ask whether the transcript should be posted after a Codex resume. */
export function resumeHistoryChoiceCard(nonce: string): object {
  return shell('📚 是否发送历史上下文？', [
    divMd('会话已恢复。历史上下文可能较长，请选择是否发送到当前对话。'),
    actions([
      {
        text: '发送历史上下文',
        value: { cmd: 'resume.history.send', arg: nonce },
        style: 'primary',
      },
      {
        text: '跳过，不发送',
        value: { cmd: 'resume.history.skip', arg: nonce },
      },
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
        `1. 打开与 **${escapedBotName}** 的私聊；这是默认入口，不需要 @。`,
        '2. 发送 `/cd <绝对路径>`，例如 `/cd /Users/me/project`；也可以先用 `/ws save <名称>` 保存，再用 `/ws use <名称>` 切换。',
        '3. 在启动卡中选择 **Codex CLI profile**，再选择**新建**或**恢复会话**；首次进入路径群时还可以修改群名。',
        `4. 点击“继续”进入项目群，群里用 **@${escapedBotName} + 任务** 开始工作；私聊也可以直接发任务。`,
        '',
        '_同一路径会复用仍可访问的项目群；如果已退出旧群，再次从私聊选择该路径会新建一个可访问的群。_',
      ]
    : [
        `1. 打开与 **${escapedBotName}** 的私聊；这是默认入口，不需要 @。`,
        '2. 发送 `/cd <绝对路径>` 选择工作目录，或用 `/ws use <名称>` 切换已保存目录。',
        `3. 直接把任务发给 ${escapedAgentName}；群聊和话题群默认需要 @${escapedBotName}。`,
        '4. 用 `/resume` 继续历史会话，或用 `/new` 开始全新会话；之后每条消息都会沿用当前 scope 的会话。',
      ];

  const panels: object[] = [
    tutorialPanel('🚀 四步快速开始', quickStart, true),
    tutorialPanel('🧭 消息范围与工作目录', [
      `- **私聊**：直接发消息，不需要 @；**群聊/话题群**：默认先 @${escapedBotName}，可在 \`/config\` 关闭这个要求。`,
      '- 每个私聊、群、话题和云文档评论线程都有独立 scope；会话、工作目录、队列不会互相串。',
      '- `/cd <绝对路径>` — 切换当前工作目录。路径必须存在且是目录；切换会中断当前任务并重置会话。',
      '- `/ws list` — 查看当前目录和已保存目录；`/ws save <名称>`、`/ws use <名称>`、`/ws remove <名称>` 管理快捷方式。',
      ...(codex
        ? [
            '- `/new chat [名称]` — 按当前路径进入独立项目群；同一路径会复用仍可访问的群。',
            '- `/profile` — 私聊切换 Bot 默认 Codex CLI profile；项目群中则切换该群的 profile 和新建/恢复方式。',
          ]
        : []),
    ]),
    tutorialPanel('🔁 会话、历史与 Codex 同步', [
      '- `/new`、`/clear`、`/reset` — 清空当前 scope 的会话；下一条消息从新会话开始。',
      '- `/resume [N]` — 分页浏览历史会话并恢复；选择后会先展示可展开的完整历史。',
      '- `/status` — 一眼查看当前 profile、cwd、会话、权限、lark-cli 身份、运行和排队状态。',
      ...(codex
        ? [
            '- `/attach` — 生成精确的本机命令，把 Codex TUI 附着到当前 thread；飞书与终端共享输入、进度和最终回答。',
            '- 运行中点击 **↵ 立即插入** 会 steer 当前 turn（Enter 语义）；点击 **⇥ 排队** 会在当前 turn 完成后执行（Tab 语义）。',
            '- 每轮完成会发送分页的完整轨迹卡；reasoning、过程、工具输入/输出、附着终端输入和 token 用量分开展示。',
          ]
        : []),
    ]),
    tutorialPanel('🧾 Bridge 命令速查', [
      '- `/help` → 示例：`/help`；效果：重新打开这张教程卡。',
      '- `/status` → 示例：`/status`；效果：显示 profile、cwd、会话、权限、lark-cli 身份、运行和队列状态。',
      '- `/new` → 示例：`/new`；效果：中断当前任务并清空当前 scope，会话从下一条消息重新开始。',
      '- `/clear` → 示例：`/clear`；效果：与 `/new` 相同，清空当前 scope 会话。',
      '- `/reset` → 示例：`/reset`；效果：与 `/new` 相同，清空当前 scope 会话。',
      '- `/cd <绝对路径>` → 示例：`/cd ~/project`；效果：切换 cwd，Codex 弹出 profile/新建或恢复卡，Claude 直接重置会话。',
      '- `/ws list` → 示例：`/ws list`；效果：以卡片列出当前 cwd 和已保存目录。',
      '- `/ws save <名称>` → 示例：`/ws save backend`；效果：把当前 cwd 保存成 `backend` 快捷方式。',
      '- `/ws use <名称>` → 示例：`/ws use backend`；效果：切换到该目录（Codex 会再次显示启动卡）。',
      '- `/ws remove <名称>` → 示例：`/ws remove backend`；效果：删除目录快捷方式，不删除磁盘文件。',
      '- `/resume [N]` → 示例：`/resume 2`；效果：打开第 2 页历史会话，点选后恢复并展示历史。',
      '- `/account` → 示例：`/account`；效果：查看当前飞书应用。',
      '- `/account change` → 示例：`/account change`；效果：打开表单重新绑定 App ID/Secret，成功后重连。',
      '- `/config` → 示例：`/config`；效果：打开偏好、访问控制和 lark-cli 身份设置卡，提交后立即生效。',
      '- `/stop` → 示例：`/stop`；效果：中断当前任务；Codex 没有活动 turn 时停止本 thread 的后台终端。',
      '- `/stop terminals` → 示例：`/stop terminals`；效果：停止当前 Codex thread 的全部后台终端。',
      '- `/timeout <分钟|off|default>` → 示例：`/timeout 15`；效果：当前 scope 15 分钟无输出后自动终止；`off` 关闭，`default` 回退全局值。',
      '- `/ps` → 示例：`/ps`；效果：Claude 列出本机 Bridge 进程，Codex 列出当前 thread 的后台终端。',
      '- `/ps bridge` → 示例：`/ps bridge`；效果：在 Codex 中明确查看本机 Bridge 进程。',
      '- `/exit <id|#>` → 示例：`/exit 2`；效果：停止指定 Bridge 进程（id 或 `/ps` 表格中的序号）。',
      '- `/reconnect` → 示例：`/reconnect`；效果：断开并重新连接飞书 WebSocket。',
      '- `/doctor [描述]` → 示例：`/doctor 群里收不到回复`；效果：执行低敏诊断并把现象交给 Agent 分析。',
      '- `/invite user @某人` → 示例：`/invite user @小王`；效果：允许该用户私聊使用 Bot。',
      '- `/invite admin @某人` → 示例：`/invite admin @小王`；效果：把该用户加入管理员名单。',
      '- `/invite group` → 示例（在目标群发送）：`/invite group`；效果：开放当前群，群内成员均可使用。',
      '- `/invite all group` → 示例：`/invite all group`；效果：一次开放 Bot 已加入的所有群。',
      '- `/remove user @某人` → 示例：`/remove user @小王`；效果：移除用户白名单。',
      '- `/remove admin @某人` → 示例：`/remove admin @小王`；效果：移除管理员身份。',
      '- `/remove group` → 示例（在目标群发送）：`/remove group`；效果：关闭当前群的响应权限。',
      '- `/meeting` → 示例：`/meeting`；效果：显示正在跟踪的会议、字幕数量和推送状态。',
      '- `/meeting join <9位会议号>` → 示例：`/meeting join 123456789`；效果：让 Bot 入会并开始收集字幕。',
      '- `/meeting ask <问题>` → 示例：`/meeting ask 刚才的结论是什么？`；效果：把会议上下文交给 Agent，并将回答发给提问者。',
      '- `/meeting notes [会议号]` → 示例：`/meeting notes`；效果：基于字幕生成讨论、结论和待办纪要。',
      '- `/meeting transcript [会议号]` → 示例：`/meeting transcript`；效果：显示 Agent 实际拿到的最近字幕。',
      '- `/meeting stop [会议号]` → 示例：`/meeting stop`；效果：中断该会议当前正在执行的任务。',
      '- `/meeting leave [会议号]` → 示例：`/meeting leave`；效果：让 Bot 离开会议。',
      '- `/doc` → 示例：`/doc`；效果：提示云文档评论不需要绑定工作区；在评论中 @Bot 即可。',
    ]),
    tutorialPanel('🧩 Codex 命令与执行位置', [
      '- `/codex commands` → 示例：`/codex commands`；效果：按“飞书原生/app-server/双重语义/附着 TUI”列出完整兼容清单；`/codex help` 同义。',
      '- `/codex skills page N` → 示例：`/codex skills page 2`；效果：直接打开第 2 页技能列表。',
      '- `/permissions` → 示例：`/permissions workspace-write`；效果：设置当前聊天/话题的 Codex 权限；不带参数则显示可点击权限卡。',
      '- `/permission` → 示例：`/permission read-only`；效果：`/permissions` 的兼容别名。',
      '- `/clear` → 示例：`/clear`；效果：清空当前 Codex scope。',
      '- `/resume` → 示例：`/resume 1`；效果：浏览并恢复历史 thread。',
      '- `/new` → 示例：`/new`；效果：创建新的 Codex thread。',
      '- `/status` → 示例：`/status`；效果：查看 Codex profile、thread、cwd、权限和运行状态。',
      '- `/profile` → 示例：`/profile`；效果：选择 Codex CLI profile。',
      '- `/apps` → 示例：`/apps`；效果：列出当前可用 Apps。',
      '- `/plugins` → 示例：`/plugins`；效果：列出当前工作目录可用插件。',
      '- `/hooks` → 示例：`/hooks`；效果：列出当前工作目录配置的 hooks。',
      '- `/rename <名称>` → 示例：`/rename 发布前检查`；效果：修改当前 thread 名称。',
      '- `/title <名称>` → 示例：`/title 发布前检查`；效果：修改当前 thread 名称。',
      '- `/archive` → 示例：`/archive`；效果：归档当前 Codex thread。',
      '- `/delete` → 示例：`/delete` 后再发 `/delete confirm`；效果：先预览，二次确认后永久删除当前 thread 及子 thread。',
      '- `/compact` → 示例：`/compact`；效果：请求 Codex 压缩当前 thread 上下文。',
      '- `/experimental` → 示例：`/experimental`；效果：查看实验功能状态；带参数可切换支持的实验开关。',
      '- `/memories` → 示例：`/memories`；效果：查看或管理 Codex memories。',
      '- `/skill` → 示例：`/skill research-pipeline 先分析目标`；效果：调用指定 skill；无 thread 时自动创建。',
      '- `/skills` → 示例：`/skills`；效果：分页列出技能，每页 6 个并可展开查看说明。',
      '- `/mcp` → 示例：`/mcp verbose`；效果：查看 MCP 服务状态；`verbose` 显示更完整的工具和授权信息。',
      '- `/model` → 示例：`/model`；效果：查看或切换当前 Codex 模型。',
      '- `/fast` → 示例：`/fast`；效果：查看或切换快速模式。',
      '- `/plan` → 示例：`/plan`；效果：查看或切换 Codex 计划模式。',
      '- `/goal <目标>` → 示例：`/goal 修复登录超时`；效果：没有 thread 时自动新建并启动，已有 thread 时更新持久目标；`/goal pause|resume|clear` 管理状态。',
      '- `/personality` → 示例：`/personality`；效果：查看或切换 Codex 回复风格。',
      '- `/clean` → 示例：`/clean`；效果：停止当前 thread 的全部后台终端。',
      '- `/fork` → 示例：`/fork`；效果：从当前 thread 创建分支会话。',
      '- `/review [说明]` → 示例：`/review 检查未提交改动`；效果：启动 Codex review，默认检查未提交改动。',
      '- `/usage` → 示例：`/usage`；效果：读取并显示 Codex 账号用量。',
      '- `/debug-config` → 示例：`/debug-config`；效果：显示 Codex 当前生效配置，便于排查。',
      '- `/logout` → 示例：`/logout`；效果：退出 Codex 登录状态。',
      '- `/ps` → 示例：`/ps`；效果：查看当前 thread 的后台终端。',
      '- `/stop` → 示例：`/stop`；效果：中断活动 turn；没有活动 turn 时停止后台终端。',
      '- `/exit` → 示例：`/exit 1`；效果：停止指定 Bridge 进程。',
      '- `/attach` → 示例：`/attach`；效果：输出 `codex --remote ... resume ...`，在终端附着同一个 thread。',
      '- `/ide` → 示例：`/ide`；效果：返回 `/attach` 指引，在附着 TUI 打开 IDE 集成。',
      '- `/keymap` → 示例：`/keymap`；效果：返回 `/attach` 指引，在附着 TUI 查看按键映射。',
      '- `/vim` → 示例：`/vim`；效果：返回 `/attach` 指引，在附着 TUI 切换 Vim 模式。',
      '- `/setup-default-sandbox` → 示例：`/setup-default-sandbox`；效果：返回 `/attach` 指引，在附着 TUI 配置默认 sandbox。',
      '- `/sandbox-add-read-dir` → 示例：`/sandbox-add-read-dir`；效果：返回 `/attach` 指引，在附着 TUI 增加只读目录。',
      '- `/agent` → 示例：`/agent`；效果：返回 `/attach` 指引，在附着 TUI 选择 agent。',
      '- `/subagents` → 示例：`/subagents`；效果：返回 `/attach` 指引，在附着 TUI 查看子 agent。',
      '- `/copy` → 示例：`/copy`；效果：返回 `/attach` 指引，在附着 TUI 复制内容。',
      '- `/diff` → 示例：`/diff`；效果：返回 `/attach` 指引，在附着 TUI 查看差异。',
      '- `/approve` → 示例：`/approve`；效果：返回 `/attach` 指引，在附着 TUI 审批操作。',
      '- `/import` → 示例：`/import`；效果：返回 `/attach` 指引，在附着 TUI 导入内容。',
      '- `/feedback` → 示例：`/feedback`；效果：返回 `/attach` 指引，在附着 TUI 打开反馈入口。',
      '- `/init` → 示例：`/init`；效果：返回 `/attach` 指引，在附着 TUI 初始化项目。',
      '- `/mention` → 示例：`/mention`；效果：返回 `/attach` 指引，在附着 TUI 使用提及功能。',
      '- `/app` → 示例：`/app`；效果：返回 `/attach` 指引，在附着 TUI 打开 app 选择器。',
      '- `/side` → 示例：`/side`；效果：返回 `/attach` 指引，在附着 TUI 打开侧栏。',
      '- `/btw` → 示例：`/btw`；效果：返回 `/attach` 指引，在附着 TUI 发起旁路提问。',
      '- `/raw` → 示例：`/raw`；效果：返回 `/attach` 指引，在附着 TUI 查看原始内容。',
      '- `/quit` → 示例：`/quit`；效果：返回 `/attach` 指引，在附着 TUI 退出界面。',
      '- `/statusline` → 示例：`/statusline`；效果：返回 `/attach` 指引，在附着 TUI 配置状态栏。',
      '- `/theme` → 示例：`/theme`；效果：返回 `/attach` 指引，在附着 TUI 切换主题。',
      '- `/pets` → 示例：`/pets`；效果：返回 `/attach` 指引，在附着 TUI 查看宠物设置。',
      '- `/pet` → 示例：`/pet`；效果：返回 `/attach` 指引，在附着 TUI 与宠物互动。',
    ]),
    tutorialPanel('🛡 设置、权限与访问控制', [
      '- `/config` → 示例：`/config`；效果：打开设置卡，可调整运行模式（个人版/团队版）、模型、回复方式、工具调用显示、COT、并发上限、探活、群聊 @ 和 lark-cli 身份策略。',
      '- Codex `/permissions` 可选 `read-only`、`workspace-write`、`danger-full-access`；实际权限不会超过 profile 的上限。',
      '- 默认只有应用 owner 能用聊天入口；`/invite user @某人` 开放私聊，`/invite group` 开放当前群，`/invite all group` 开放 Bot 所在全部群，`/invite admin @某人` 添加管理员；用 `/remove ...` 撤销。',
      '- owner/admin 才能执行敏感管理命令；团队版允许任何人 @Bot，但仍保留管理命令限制，并强制 lark-cli 使用应用身份。',
      '- lark-cli 默认是应用身份；需要个人日历、邮箱、云盘等资源时切换为用户身份并完成授权。`/status` 会显示当前状态。',
    ]),
    tutorialPanel('🎙 会议、附件与故障排查', [
      '- **附件**：图片或文件可以和任务一起发送，Bridge 会下载到本地缓存并按附件策略交给 Agent。',
      '- **云文档**：在支持的文档评论里 @Bot 即可提问；回复写回同一评论线程，不需要单独绑定工作区。',
      '- 会议智能体默认关闭；管理员在 `/config` 或 Web 控制台开启并重启后，使用 `/meeting join <9位会议号>` 入会。`/meeting` 看状态，`ask` 提问，`notes` 总结，`transcript` 看字幕，`stop` 中断，`leave` 离会。',
      '- `/timeout 10` 为当前 scope 开启 10 分钟空闲探活；`/timeout off` 关闭，`/timeout default` 回到全局设置。',
      '- `/doctor [描述]` 运行低敏诊断；网络恢复后用 `/reconnect`；Codex 终端卡住时用 `/stop terminals`。',
      '- `/account change` 重新绑定飞书应用；任何时候发送 `/help` 都能回到本教程。',
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
        tutorialActions(codex),
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

function tutorialActions(codex: boolean): object {
  const specs: Array<{ text: string; cmd: string; primary?: boolean }> = [
    { text: '📊 状态', cmd: 'status', primary: true },
    ...(codex ? [{ text: '⚙️ Codex profile', cmd: 'profile' }] : []),
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
