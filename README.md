# lark-channel-bridge

把飞书 / Lark 消息接到本机的 Claude Code 或 Codex CLI。你可以在私聊、群聊、话题群和云文档评论里发任务，让本机 agent 读取项目、处理图片和文件、修改代码，并把过程与结果同步回飞书。

**默认语言：中文。** [阅读 English README](./README.en.md)

## 你可以用它做什么

- 在飞书里直接使用本机已登录的 Claude Code 或 Codex CLI，不需要把代码上传到第三方服务。
- 每个私聊、群、话题和云文档评论线程都有独立会话；会话、工作目录、权限和队列互不串线。
- 回复支持流式消息卡片或一次性纯文本；可选展示工具调用和 COT 过程消息。
- 图片、文件和引用消息可以跟任务一起发送；Bridge 下载附件后交给 agent。
- Codex 支持 app-server、历史恢复、终端附着、技能、MCP、review、持久目标和后台终端控制。
- 支持多个 profile，可分别运行不同飞书应用、不同 agent，或同时运行 Claude 与 Codex。
- 可选开启会议智能体：入会、读取字幕、在会议中回答问题，并生成纪要。
- 所有状态默认保存在本机；默认不发送遥测数据。

## 5 分钟开始使用

### 前置条件

- Node.js `>= 20.12.0`。
- Codex 在 macOS/Linux 上执行会话接管时还需要 `lsof` 和 `ps`（Windows 使用系统自带进程工具）。
- 本机安装并登录至少一个 agent：
  - [Claude Code 快速开始](https://docs.anthropic.com/en/docs/claude-code/quickstart)，命令为 `claude`。
  - [Codex CLI 文档](https://developers.openai.com/codex/cli)，命令为 `codex`。
- 一个飞书 / Lark PersonalAgent 应用。首次运行的二维码向导可以创建并绑定应用。

选择 Codex 时，飞书应用还必须在开发者后台开通项目群权限：

- `im:chat`：创建项目群。
- 以下成员读取权限至少开通一个：`im:chat:readonly`、`im:chat`、`im:chat.group_info:readonly`、`im:chat.members:read`。其中 `im:chat` 同时满足建群和成员读取要求。

Bridge 启动时会预检这些 **Bot 应用身份权限**；缺少权限时不会上线，并提示开发者后台授权链接。`lark-cli auth login` 的用户授权不能替代应用权限。成员读取权限用于检查路径绑定的项目群中当前用户是否仍在群内：用户已退群时才会清除旧绑定并创建新群；如果查询失败或超时，Bridge 会停止本次创建以避免重复建群。

Web 控制台“我的群”列表是另一条用户授权流程，只在使用该功能时请求 `im:chat:read`，不用于替代上述 Bot 成员读取权限。

### 安装并启动

```bash
npm install --global lark-channel-bridge
# 或
pnpm add --global lark-channel-bridge

# 前台启动，适合首次配置和排障
lark-channel-bridge run
```

首次启动会依次：

1. 在终端显示二维码，用飞书 App 扫码。
2. 选择或创建 PersonalAgent 应用。
3. 选择要初始化的 agent（Claude 或 Codex）。
4. 将 profile、应用凭据和本地状态写入 `~/.lark-channel/`。

没有指定工作目录也可以启动。Bridge 会创建 profile 托管的默认目录；启动后在飞书发送 `/cd <绝对路径>` 切换到项目。

已有应用时可以跳过创建步骤：

```bash
lark-channel-bridge run --app-id cli_xxx
lark-channel-bridge run --app-id cli_xxx --tenant lark
```

命令会交互式读取 App Secret。不要把 Secret 写进 shell 历史或提交到仓库。

### 在飞书里发第一条任务

```text
/cd /Users/me/project
请检查这个项目的测试失败原因，并给出修复方案。
```

Claude 会切换目录并开始新会话。Codex 会先显示启动卡，让你选择 Codex CLI profile，以及新建还是恢复 thread；从私聊继续时，Bridge 会进入该路径的专属项目群。

## 消息从哪里进入

- **私聊**：直接发消息，不需要 `@bot`。
- **群聊和话题群**：默认需要 `@bot`；可以在 `/config` 里关闭这个要求。`@all` 永远不会触发回复。
- **云文档评论**：在支持的文档评论中 `@bot` 即可。评论会话按文档和评论线程隔离，不需要 `/doc` 绑定工作区。

Cloud-doc comments are document-scoped：云文档评论按文档权限生效，回复留在同一评论线程。
- **引用消息**：回复一条消息再提问时，引用内容会作为当前任务上下文。
- **附件**：图片和文件可以与文字一起发送。Bridge 会下载到 profile 的媒体缓存，经过当前附件策略检查后交给 agent。

陌生用户默认不会收到权限错误，而是静默忽略。应用 owner 始终可以使用 bot；管理员可以使用管理命令并绕过群白名单。团队版会开放普通用户的 `@bot` 使用，但仍限制敏感管理命令。

## Bridge 命令：每条命令都有示例

以下命令在飞书消息中使用。`<...>` 表示替换成自己的值，`[...]` 表示可选参数。

### 开始工作、切目录、恢复会话

| 命令 | 可复制的示例 | 执行后的效果 |
|---|---|---|
| `/help` | `/help` | 打开按场景组织的帮助卡；卡片按钮可直接查看状态、目录、历史或新会话。 |
| `/status` | `/status` | 显示当前 profile、agent、cwd、会话 ID、权限、lark-cli 身份、运行中任务和队列。 |
| `/cd` | `/cd ~/work/demo` | 切换当前 scope 的工作目录并中断正在运行的任务；Claude 立即新建会话，Codex 显示启动选择卡。 |
| `/ws list` | `/ws list` | 用卡片列出当前 cwd 和命名工作目录。 |
| `/ws save` | `/ws save backend` | 把当前 cwd 保存为 `backend` 快捷方式；不会复制或移动文件。 |
| `/ws use` | `/ws use backend` | 切换到 `backend` 指向的目录；Codex 会重新让你选择 profile 和新建/恢复。 |
| `/ws remove` | `/ws remove backend` | 删除目录快捷方式，不删除磁盘文件。别名 `rm` 也可用。 |
| `/new` | `/new` | 中断当前任务，清空当前私聊、群或话题的会话，下一条消息从全新会话开始；若存在旧 Codex thread，会先用单独一条消息报告其完整 ID。 |
| `/clear` | `/clear` | `/new` 的同义命令。 |
| `/reset` | `/reset` | `/new` 的同义命令。 |
| `/resume` | `/resume 2` | 打开第 2 页历史会话；点选某项后恢复，再按卡片选择是否发送历史上下文。 |
| `/new chat` | `/new chat 发布检查` | Codex 下按当前路径创建或复用专属项目群，并创建新的 thread。 |
| `/profile` | `/profile` | Codex 私聊中选择 Bot 默认 CLI profile；项目群中选择该群 profile，并继续新建或恢复会话。 |
| `/attach` | `/attach` | 输出 `codex --remote ... resume ...` 命令；在本机终端运行后，终端和飞书共享同一个 thread。 |
| `/permissions` | `/permissions workspace-write` | 设置当前聊天/话题的 Codex 权限；不带参数会打开权限卡。也支持 `/permission`。 |
| `/goal` | `/goal 修复登录超时` | 没有 thread 时自动创建会话并启动首轮；已有 thread 时更新持久目标。`/goal` 查看，`/goal pause` 暂停，`/goal resume` 恢复，`/goal clear` 清除。 |

### 运行控制、诊断和应用凭据

| 命令 | 可复制的示例 | 执行后的效果 |
|---|---|---|
| `/interupt`（`/interrupt`） | `/interupt` | 等效 Codex CLI 的 Esc：打断当前 turn，保留排队消息并让它们进入下一轮；没有活动 turn 但有队列时立即执行队列。 |
| `/queue` | `/queue 检查测试` | 将一条 Codex 指令排到当前 turn 完成后的下一轮；运行卡不提供实体排队按钮。 |
| `/stop` | `/stop` | 立即停止当前 turn 并清空排队消息；Codex 没有活动 turn 时停止当前 thread 的后台终端。 |
| `/stop terminals` | `/stop terminals` | 停止当前 Codex thread 的全部后台终端；`/clean` 是同义命令。 |
| `/timeout` | `/timeout 15` | 为当前 scope 设置 15 分钟空闲探活；agent 连续无输出达到时限会被终止。 |
| `/timeout off` | `/timeout off` | 关闭当前 scope 的探活。 |
| `/timeout default` | `/timeout default` | 清除当前 scope 的覆盖，恢复全局 `/config` 设置。 |
| `/timeout comment:` | `/timeout comment:abc123 10` | 管理员为指定云文档评论 scope 设置 10 分钟探活。 |
| `/ps` | `/ps` | Claude 下列出本机 Bridge 进程；Codex 下列出当前 thread 的后台终端。 |
| `/ps bridge` | `/ps bridge` | Codex 下明确列出本机 Bridge 进程。 |
| `/exit` | `/exit 2` | 按 `/ps` 表格中的短 ID 或序号停止指定 Bridge 进程。 |
| `/reconnect` | `/reconnect` | 重新建立飞书 WebSocket 连接；适合网络恢复后使用。 |
| `/doctor` | `/doctor 群里没有回复` | 运行低敏诊断，并把现象交给 agent 分析；不会导出 Secret。 |
| `/account` | `/account` | 显示当前绑定的飞书应用信息。 |
| `/account change` | `/account change` | 打开更换 App ID / App Secret 的表单；校验成功后保存并重连当前 profile。 |
| `/doc` | `/doc` | 说明云文档评论已不需要工作区绑定；实际使用是在评论中 `@bot`。 |

### 访问控制

只有应用 owner 和管理员能修改访问名单。命令中的 `@某人` 必须指向目标用户，不是指向 bot。

| 命令 | 可复制的示例 | 执行后的效果 |
|---|---|---|
| `/invite user` | `/invite user @小王` | 把小王加入允许私聊使用 bot 的名单。 |
| `/invite admin` | `/invite admin @小王` | 把小王加入管理员名单；他可以改设置、使用管理命令并在任意群使用 bot。 |
| `/invite group` | 在目标群发送 `/invite group` | 把当前群加入响应名单，群内成员都可以使用 bot。 |
| `/invite all group` | `/invite all group` | 一次把 bot 已加入的全部群加入响应名单。 |
| `/remove user` | `/remove user @小王` | 从允许私聊名单移除小王。 |
| `/remove admin` | `/remove admin @小王` | 撤销小王的管理员身份。 |
| `/remove group` | 在目标群发送 `/remove group` | 把当前群移出响应名单。 |

### 会议智能体

会议能力默认关闭。管理员在 Web 控制台或 profile 配置中启用并重启后，才能使用下列命令。会议号只接受 9 位数字。

Web 控制台的会议设置还包括：被邀请时自动入会、字幕保留条数和稳定窗口、回答发送到会议/私聊/两者、会中触发前缀，以及会议结束后把纪要发给发起聊天或 owner。`/meeting ask` 的回答只发给提问者，不会把私聊问题广播到会议。

| 命令 | 可复制的示例 | 执行后的效果 |
|---|---|---|
| `/meeting` | `/meeting` | 显示正在跟踪的会议、字幕数量、参会人数和事件推送状态。 |
| `/meeting join` | `/meeting join 123456789` | 让 bot 以参会者身份入会并开始收集字幕。 |
| `/meeting ask` | `/meeting ask 刚才的结论是什么？` | 将最近会议上下文交给 agent，回答只发送给提问者。 |
| `/meeting notes` | `/meeting notes` | 基于字幕生成讨论内容、结论和待办；有多场会议时附上会议号。 |
| `/meeting transcript` | `/meeting transcript 123456789` | 显示 agent 实际收到的最近字幕，便于核对上下文。 |
| `/meeting stop` | `/meeting stop 123456789` | 中断该会议当前正在运行的任务。 |
| `/meeting leave` | `/meeting leave 123456789` | 让 bot 离开指定会议。 |

## Codex CLI 命令覆盖

Codex profile 使用常驻 `codex app-server`。运行卡只展示状态和折叠的工具记录，不再放置插入、排队或停止按钮。运行中直接 `@bot 内容` 会 steer 当前 turn：旧流式卡会冻结并标记“已在下方接续”，新流式卡以这条插入消息为锚点继续；`/queue <指令>` 会排到下一轮；`/interupt`（`/interrupt`）等效 Codex CLI 的 Esc，打断当前 turn 并保留队列；`/stop` 则立即停止并清空排队消息。同一 turn、同一请求内的多次 Codex 重试会聚合为一个默认折叠面板，标题持续显示当前 attempt、等待时间和累计次数，不会跨 turn 合并。`/goal <目标>` 通过 app-server 更新持久目标，不打断当前 turn，也不清理队列。普通 turn 只发送运行卡和最终回复，不会额外重复发送完整轨迹；恢复历史后可通过选择卡按需发送聚合的历史上下文。发送 `/codex commands` 可以在飞书里随时查看当前版本（兼容 Codex 0.152.x）的清单。

### app-server 命令

这些命令通过 app-server RPC 执行，示例和结果如下：

| 命令 | 示例 | 效果 |
|---|---|---|
| `/apps` | `/apps` | 列出当前可用 Apps。 |
| `/plugins` | `/plugins` | 列出当前工作目录可用插件。 |
| `/hooks` | `/hooks` | 列出当前工作目录配置的 hooks。 |
| `/rename` | `/rename 发布前检查` | 重命名当前 thread。`/title` 同义。 |
| `/title` | `/title 发布前检查` | 重命名当前 thread。 |
| `/archive` | `/archive` | 归档当前 thread。 |
| `/delete` | `/delete`，随后 `/delete confirm` | 先预览删除范围；显式确认后永久删除当前 thread 及子 thread。 |
| `/compact` | `/compact` | 请求 Codex 压缩当前 thread 的上下文。 |
| `/experimental` | `/experimental` | 查看实验功能状态；带支持的参数可切换状态。 |
| `/memories` | `/memories` | 查看或管理 Codex memories。 |
| `/skill` | `/skill research-pipeline 先分析目标` | 在当前 thread 调用指定 skill；没有 thread 时自动创建。 |
| `/skills` | `/skills` | 分页列出可用技能；每页 6 个并可展开查看说明。 |
| `/mcp` | `/mcp verbose` | 查看 MCP 服务状态；`verbose` 显示完整工具和授权信息。 |
| `/model` | `/model` | 查看或切换当前 Codex 模型。 |
| `/fast` | `/fast` | 查看或切换快速模式。 |
| `/plan` | `/plan` | 查看或切换 Codex 计划模式。 |
| `/goal` | `/goal 修复登录超时` | 创建或更新持久目标；`pause`、`resume`、`clear` 管理状态。 |
| `/personality` | `/personality` | 查看或切换 Codex 回复风格。 |
| `/clean` | `/clean` | 停止当前 thread 的全部后台终端。 |
| `/fork` | `/fork` | 从当前 thread 创建分支会话。 |
| `/review` | `/review 检查未提交改动` | 启动 Codex review；不写说明时默认检查未提交改动。 |
| `/usage` | `/usage` | 读取并显示 Codex 账号用量。 |
| `/debug-config` | `/debug-config` | 显示 Codex 当前生效配置，便于排查。 |
| `/logout` | `/logout` | 退出 Codex 登录状态。 |

### Bridge 原生和双重语义命令

| 命令 | 示例 | 效果 |
|---|---|---|
| `/permissions` | `/permissions read-only` | 持久化当前聊天/话题的权限，不能超过 profile 上限。 |
| `/permission` | `/permission danger-full-access` | `/permissions` 的兼容别名。 |
| `/clear` | `/clear` | 清空当前 Codex scope，会话从下一条消息重新开始。 |
| `/resume` | `/resume 1` | 浏览并恢复当前 profile 可用的历史 thread。 |
| `/new` | `/new` | 创建新的 Codex thread。 |
| `/status` | `/status` | 显示 Codex profile、thread、cwd、权限和运行状态。 |
| `/profile` | `/profile` | 在卡片中选择默认或命名 Codex CLI profile。 |
| `/ps` | `/ps` | 列出当前 thread 的后台终端；`/ps bridge` 查看 Bridge 进程。 |
| `/interupt`（`/interrupt`） | `/interupt` | 等效 Codex CLI 的 Esc：打断活动 turn 并保留排队消息；没有活动 turn 但有队列时立即执行队列。 |
| `/queue` | `/queue 检查测试` | 将一条 Codex 指令排到当前 turn 完成后的下一轮。 |
| `/stop` | `/stop` | 立即停止活动 turn 并清空排队消息；没有活动 turn 时停止后台终端。 |
| `/exit` | `/exit 1` | 停止指定 Bridge 进程。 |
| `/attach` | `/attach` | 输出附着当前 thread 的本机 Codex 命令。 |
| `/codex commands` | `/codex commands` | 列出所有 Codex 兼容命令及执行位置；`/codex help` 同义。 |
| `/codex skills page N` | `/codex skills page 2` | 直接打开第 2 页技能列表。 |

### 只能在附着 TUI 中执行的命令

这些命令依赖终端本地 UI 状态。直接在飞书发送时，Bridge 会告诉你先运行 `/attach`，不会假装已经执行成功。

| 命令 | 示例 | 效果 |
|---|---|---|
| `/ide` | `/ide` | 在附着的 Codex TUI 中打开 IDE 集成。 |
| `/keymap` | `/keymap` | 在附着 TUI 查看或切换按键映射。 |
| `/vim` | `/vim` | 在附着 TUI 切换 Vim 编辑模式。 |
| `/setup-default-sandbox` | `/setup-default-sandbox` | 在附着 TUI 配置默认 sandbox。 |
| `/sandbox-add-read-dir` | `/sandbox-add-read-dir` | 在附着 TUI 增加只读目录。 |
| `/agent` | `/agent` | 在附着 TUI 选择或查看 agent。 |
| `/subagents` | `/subagents` | 在附着 TUI 查看子 agent。 |
| `/copy` | `/copy` | 在附着 TUI 复制当前内容。 |
| `/diff` | `/diff` | 在附着 TUI 查看改动差异。 |
| `/approve` | `/approve` | 在附着 TUI 审批待处理操作。 |
| `/import` | `/import` | 在附着 TUI 导入内容。 |
| `/feedback` | `/feedback` | 在附着 TUI 打开反馈入口。 |
| `/init` | `/init` | 在附着 TUI 初始化当前项目。 |
| `/mention` | `/mention` | 在附着 TUI 使用提及功能。 |
| `/app` | `/app` | 在附着 TUI 打开 app 选择器。 |
| `/side` | `/side` | 在附着 TUI 打开侧栏。 |
| `/btw` | `/btw` | 在附着 TUI 发起旁路提问。 |
| `/raw` | `/raw` | 在附着 TUI 查看原始内容。 |
| `/quit` | `/quit` | 在附着 TUI 退出当前界面。 |
| `/statusline` | `/statusline` | 在附着 TUI 配置状态栏。 |
| `/theme` | `/theme` | 在附着 TUI 切换主题。 |
| `/pets` | `/pets` | 在附着 TUI 查看宠物设置。 |
| `/pet` | `/pet` | 在附着 TUI 与宠物互动。 |

## 回复展示、权限和身份

### `/config` 能调整什么

发送 `/config` 打开设置卡，提交后写入当前 profile：

- **运行模式**：个人版（默认）只允许 owner、管理员和名单用户；团队版允许任何人 `@bot`，但敏感管理命令仍限 owner/admin。
- **模型**：选择 agent 支持的模型，或跟随 CLI 默认值。
- **消息回复方式**：消息卡片会流式更新；纯文本在任务结束后一次发送。
- **工具调用显示**：决定最终回复是否展示工具块。
- **COT 过程消息**：关闭、简略或详细。开启后过程和最终答案会分成两条消息。
- **并发上限**：默认 10，范围 1-50，超出请求按 FIFO 排队。
- **run 探活**：默认关闭，范围 1-120 分钟；单个 scope 可用 `/timeout` 覆盖。
- **群里需要 @ bot**：默认开启；关闭后需要飞书应用具备 `im:message.group_msg` 权限。
- **lark-cli 身份策略**：默认只使用应用身份；切换为用户身份后，已授权的个人日历、邮箱、云盘等资源可被 agent 使用。

这里的 `lark-cli identity policy` 会作用于当前 profile。每个 profile 使用独立的 **profile-local lark-cli directory**：`~/.lark-channel/profiles/<profile>/lark-cli`。个人授权不会在 profile 之间共享。团队版会强制使用应用身份。

### Codex 权限模式

推荐配置字段是 `permissions.defaultAccess` 和 `permissions.maxAccess`，新 profile 默认都是 `full`：

```json
{
  "permissions": {
    "defaultAccess": "full",
    "maxAccess": "full"
  }
}
```

| Bridge access | Claude | Codex |
|---|---|---|
| `full` | `bypassPermissions` | `danger-full-access` |
| `workspace` | `acceptEdits` | `workspace-write` |
| `read-only` | `plan` | `read-only` |

Codex 的 `/permissions` 按聊天 / 话题保存实际权限，并受 `maxAccess` 限制。旧版 `sandbox` 字段（legacy `sandbox`）仍可读取；Bridge 保存 profile 时会迁移到 canonical `permissions`。

### 默认工作目录

profile 可以设置 `workspaces.default`。新建 profile 时传 `--workspace <path>`；省略时 Bridge 会创建 profile 托管目录：

```json
{
  "workspaces": {
    "default": "/Users/me/.lark-channel-workspaces/claude/default"
  }
}
```

所选路径必须存在且是目录，不能是 `/`、Home 根目录、系统目录或临时目录根。工作目录只是 agent 的当前目录，不等同于文件系统 sandbox。

## Web 控制台和后台服务

### 本机 Web 控制台

```bash
lark-channel-bridge run --web-ui
lark-channel-bridge ui --print
```

控制台只绑定 `127.0.0.1`，可查看和管理所有 profile、启动/停止 bot、编辑配置、完成用户授权、管理群，以及在会议页入会或离会。`ui --print` 只打印地址，不自动打开浏览器。

### 后台运行

确认 `run` 前台工作后，用 OS 服务常驻：

```bash
lark-channel-bridge start
lark-channel-bridge status
lark-channel-bridge restart
lark-channel-bridge stop
lark-channel-bridge unregister
```

这是按 profile 注册的 **per-profile service**：

- macOS：launchd 用户代理 `ai.lark-channel-bridge.bot.<profile>`。
- Linux：systemd 用户单元 `lark-channel-bridge.bot.<profile>.service`。
- Windows：Task Scheduler 任务 `LarkChannelBridge.Bot.<profile>`，启动器是 `.cmd`。

服务命令不能依赖临时 `npx` 路径，建议全局安装。daemon 日志在 `~/.lark-channel/profiles/<profile>/logs/daemon/`。

### 宿主 CLI 命令

| 命令 | 示例 | 效果 |
|---|---|---|
| `run` | `lark-channel-bridge run --agent codex --workspace ~/work` | 前台启动一个 profile；首次运行时执行扫码和初始化。 |
| `start` | `lark-channel-bridge start --profile codex` | 安装（如需要）并启动指定 profile 的 OS 服务。 |
| `stop` | `lark-channel-bridge stop --profile codex` | 停止服务并禁用自动启动，保留服务定义。 |
| `restart` | `lark-channel-bridge restart --profile codex` | 重启指定 profile 的 OS 服务。 |
| `status` | `lark-channel-bridge status --profile codex` | 显示服务 PID、最近退出信息和日志路径。 |
| `unregister` | `lark-channel-bridge unregister --profile codex` | 删除 OS 服务注册。 |
| `migrate` | `lark-channel-bridge migrate` | 将旧版配置和状态迁移到当前 profile 布局。 |
| `ps` | `lark-channel-bridge ps` | 列出本机正在运行的 Bridge 进程。 |
| `kill` | `lark-channel-bridge kill 2` | 向指定进程发送 SIGTERM；宽限期后仍未退出才升级终止。 |
| `ui` | `lark-channel-bridge ui --profile codex` | 打开本机 Web 控制台；加 `--print` 只打印 URL。 |
| `--help` | `lark-channel-bridge --help` | 显示 Commander 提供的 CLI 帮助。 |
| `--version` | `lark-channel-bridge --version` | 显示当前安装版本。 |

`run` 和 `start` 常用选项也都是可组合的：

| 选项 | 示例 | 效果 |
|---|---|---|
| `--profile <name>` | `lark-channel-bridge run --profile codex` | 运行指定 profile；省略时使用 active profile。 |
| `--agent claude\|codex` | `lark-channel-bridge run --agent claude` | 首次初始化时选择 agent 类型；已有 profile 的类型不能在运行时偷偷切换。 |
| `--workspace <path>` | `lark-channel-bridge run --workspace ~/work` | 首次创建 profile 时设置 `workspaces.default`。 |
| `--web-ui` | `lark-channel-bridge start --web-ui` | 以 supervisor + Web 控制台服务运行并托管所有 profile，而不是只运行一个 profile。 |
| `--config <path>` | `lark-channel-bridge run --config ./config.json` | 使用指定 root config 文件。 |
| `--app-id <id>` | `lark-channel-bridge run --app-id cli_xxx` | 使用已有飞书应用，跳过创建应用步骤。 |
| `--app-secret <secret>` | `lark-channel-bridge run --app-id cli_xxx --app-secret "$APP_SECRET"` | 非交互地提供 App Secret；共享机器优先交互输入。 |
| `--tenant feishu\|lark` | `lark-channel-bridge run --tenant lark` | 选择飞书中国版或 Lark 国际版租户，默认 `feishu`。 |
| `--skip-check-lark-cli` | `lark-channel-bridge start --skip-check-lark-cli` | 跳过 lark-cli 自动安装和绑定预检；仅在你已完成本机配置时使用。 |

`migrate` 支持 `--config`、`--profile` 和 `--agent`，效果是把旧版状态迁移到指定 profile。服务命令支持 `--profile` 和 `--web-ui`；`--web-ui` 明确指向 supervisor 服务。

### 加密 Secret 管理

Secret 存在本机加密 keystore（`~/.lark-channel/secrets.enc`），以下命令不会把 Secret 打印到终端：

| 命令 | 示例 | 效果 |
|---|---|---|
| `secrets set` | `lark-channel-bridge secrets set --app-id cli_xxx --profile codex` | 隐藏输入 App Secret 并加密保存。 |
| `secrets list` | `lark-channel-bridge secrets list --profile codex` | 只列出已保存的 App ID，不显示 Secret。 |
| `secrets get` | `printf '{"appId":"cli_xxx"}' \| lark-channel-bridge secrets get` | 按 lark-cli exec-provider 协议从 stdin 读取 JSON，并向 stdout 返回 JSON。 |
| `secrets remove` | `lark-channel-bridge secrets remove --app-id cli_xxx --profile codex` | 从加密 keystore 删除指定 App ID。 |

### Profile 管理

只有需要多套应用、同时运行 Claude/Codex 或脚本化部署时才需要 profile 管理：

```bash
lark-channel-bridge profile create claude --agent claude
lark-channel-bridge profile create codex --agent codex --workspace ~/work
lark-channel-bridge profile list
lark-channel-bridge profile use codex
```

| 命令 | 示例 | 效果 |
|---|---|---|
| `profile create` | `lark-channel-bridge profile create codex --agent codex` | 创建 profile，并通过二维码或现有应用凭据初始化。 |
| `profile list` | `lark-channel-bridge profile list` | 列出所有已配置 profile。 |
| `profile use` | `lark-channel-bridge profile use codex` | 将后续默认启动目标切换为 `codex`。 |
| `profile remove` | `lark-channel-bridge profile remove old` | 归档 profile 和本地状态；不会立即永久删除。即 `profile remove`。 |
| `profile remove --purge --yes` | `lark-channel-bridge profile remove old --purge --yes` | 跳过归档，永久删除该 profile 的本地状态。 |
| `profile export` | `lark-channel-bridge profile export codex --output ./codex.json` | 导出脱敏 profile JSON；文件已存在时需要 `--force`。即 `profile export`。 |
| `--include-secrets --yes` | `lark-channel-bridge profile export codex --include-secrets --yes` | 明确确认后导出 Secret 配置和 App Secret；请妥善保护输出文件。 |

删除最后一个 profile 会清空 root config；之后可以重新创建同名 profile。profile 类型创建错误时，先 `stop` 或 `unregister --profile <name>`，再删除并用正确的 `--agent` 重建。

## 数据目录和环境变量

| 路径 | 内容 |
|---|---|
| `~/.lark-channel/config.json` | root config，包含 profiles 和 active profile。 |
| `~/.lark-channel/active-profile` | 最近选择的 profile。 |
| `~/.lark-channel/profiles/<profile>/sessions.json` | 会话状态。 |
| `~/.lark-channel/profiles/<profile>/sessions.json.catalog.json` | agent-aware 会话索引。 |
| `~/.lark-channel/profiles/<profile>/workspaces.json` | 当前和命名工作目录绑定。 |
| `~/.lark-channel/profiles/<profile>/secrets.enc` | profile 本地加密 Secret。 |
| `~/.lark-channel/profiles/<profile>/lark-cli/` | 当前 profile 的 lark-cli 目录。 |
| `~/.lark-channel/profiles/<profile>/media/` | 附件缓存。 |
| `~/.lark-channel/profiles/<profile>/logs/` | 结构化运行日志。 |
| `~/.lark-channel/registry/processes.json` | 本机进程注册表。 |
| `~/.lark-channel/registry/locks/` | profile 和 app 锁。 |

```bash
# 将整棵本地状态目录迁移到指定位置
LARK_CHANNEL_HOME=/path/to/state lark-channel-bridge start

# 调整日志保留天数
LARK_CHANNEL_LOG_DAYS=14 lark-channel-bridge start
```

## 常见问题

**Bot 没有回复。** 先发 `/status`，确认当前 cwd 存在、`claude`/`codex` 已登录、profile 正在运行；群聊确认已 @bot 且群已通过 `/invite group` 开放。必要时发 `/new` 重建会话。

**卡片停在最后一帧。** 默认探活关闭。用 `/timeout 10` 为当前 scope 开启 10 分钟 watchdog，或在 `/config` 设置全局值；`/timeout off` 关闭，`/timeout default` 恢复全局值。

**Codex 恢复提示 thread 被占用。** 等另一个 Codex 进程结束后重试；如果确定要接管，在恢复卡中由管理员确认接管，Bridge 会终止占用进程再恢复。

**agent 看不到附件。** 检查附件大小和数量是否超过 profile 策略，并确认 `~/.lark-channel/profiles/<profile>/media/` 可写。再发一条带附件的新消息测试。

**群里关闭 @ 后仍收不到消息。** 飞书应用必须有 `im:message.group_msg` 权限；重新打开 `/config` 提交时，Bridge 会提示一键授权链接。

## 开发和验证

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
```

`pnpm test` 包含 unit、integration 和 process 级 adapter 测试；CI 覆盖 macOS、Ubuntu 和 Windows。提交前建议执行 `git diff --check`。

默认不会上传指标、日志或消息，也不依赖遥测服务。需要接入自有监控时，可显式设置 `LARK_CHANNEL_TELEMETRY_MODULE`；缺失或异常的适配器会自动降级为 noop，不会阻止 Bridge 启动。

## 许可证

[MIT](./LICENSE)
