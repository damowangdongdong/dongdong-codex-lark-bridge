import { readFile } from 'node:fs/promises';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import type { CodexSandboxMode } from '../config/permissions';

export type WorkspaceLaunchMode = 'new' | 'resume';

export interface WorkspaceSelection {
  cwd: string;
  /** A validated cwd awaiting confirmation in the Codex launch card. */
  pendingCwd?: string;
  /** `null` means run Codex without `--profile`; undefined is legacy/unselected. */
  codexProfile?: string | null;
  launchMode?: WorkspaceLaunchMode;
  /** True after a cwd switch, and while a requested resume still needs a thread choice. */
  launchPending?: boolean;
  /** Per-scope Codex permission selection. */
  codexSandbox?: CodexSandboxMode;
  codexModel?: string | null;
  codexPersonality?: 'friendly' | 'pragmatic' | 'none';
}

export interface ProjectChatBinding {
  chatId: string;
  name: string;
}

interface WorkspaceData {
  chats: Record<string, WorkspaceSelection>;
  named: Record<string, string>;
  projectChats: Record<string, ProjectChatBinding>;
  /** Bot-wide Codex CLI profile selected from the bot's direct chat. */
  defaultCodexProfile?: string | null;
}

export class WorkspaceStore {
  private data: WorkspaceData = { chats: {}, named: {}, projectChats: {} };
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string = paths.workspacesFile) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(text) as Partial<WorkspaceData>;
      this.data = {
        chats: parsed.chats ?? {},
        named: parsed.named ?? {},
        projectChats: parsed.projectChats ?? {},
        ...(parsed.defaultCodexProfile !== undefined
          ? { defaultCodexProfile: parsed.defaultCodexProfile }
          : {}),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  cwdFor(chatId: string): string | undefined {
    return this.data.chats[chatId]?.cwd;
  }

  selectionFor(chatId: string): WorkspaceSelection | undefined {
    const entry = this.data.chats[chatId];
    return entry ? { ...entry } : undefined;
  }

  setCwd(chatId: string, cwd: string): void {
    const previous = this.data.chats[chatId];
    this.data.chats[chatId] = {
      cwd,
      ...(previous?.codexProfile !== undefined
        ? { codexProfile: previous.codexProfile }
        : {}),
      ...(previous?.launchMode ? { launchMode: previous.launchMode } : {}),
      ...(previous?.launchPending ? { launchPending: true } : {}),
      ...(previous?.codexSandbox ? { codexSandbox: previous.codexSandbox } : {}),
      ...(previous?.codexModel !== undefined ? { codexModel: previous.codexModel } : {}),
      ...(previous?.codexPersonality ? { codexPersonality: previous.codexPersonality } : {}),
    };
    this.schedulePersist();
  }

  /** Seed a newly-created chat from the source scope while starting a fresh thread. */
  inheritForNewScope(sourceScope: string, targetScope: string, cwd: string): void {
    const source = this.data.chats[sourceScope];
    this.data.chats[targetScope] = {
      cwd,
      ...(source?.codexProfile !== undefined
        ? { codexProfile: source.codexProfile, launchMode: 'new' as const }
        : {}),
      ...(source?.codexSandbox ? { codexSandbox: source.codexSandbox } : {}),
      ...(source?.codexModel !== undefined ? { codexModel: source.codexModel } : {}),
      ...(source?.codexPersonality ? { codexPersonality: source.codexPersonality } : {}),
    };
    this.schedulePersist();
  }

  prepareCodexLaunch(chatId: string, cwd: string): void {
    const previous = this.data.chats[chatId];
    this.data.chats[chatId] = {
      cwd: previous?.cwd ?? cwd,
      pendingCwd: cwd,
      launchPending: true,
      ...(previous?.codexProfile !== undefined
        ? { codexProfile: previous.codexProfile }
        : {}),
      ...(previous?.launchMode ? { launchMode: previous.launchMode } : {}),
      ...(previous?.codexSandbox ? { codexSandbox: previous.codexSandbox } : {}),
      ...(previous?.codexModel !== undefined ? { codexModel: previous.codexModel } : {}),
      ...(previous?.codexPersonality ? { codexPersonality: previous.codexPersonality } : {}),
    };
    this.schedulePersist();
  }

  pendingCodexCwdFor(chatId: string): string | undefined {
    return this.data.chats[chatId]?.pendingCwd;
  }

  cancelCodexLaunch(chatId: string): void {
    const previous = this.data.chats[chatId];
    if (!previous) return;
    const { pendingCwd: _pendingCwd, launchPending: _launchPending, ...rest } = previous;
    this.data.chats[chatId] = rest;
    this.schedulePersist();
  }

  setCodexLaunch(
    chatId: string,
    profile: string | null,
    launchMode: WorkspaceLaunchMode,
  ): void {
    const previous = this.data.chats[chatId];
    if (!previous?.cwd) throw new Error(`workspace cwd is not set for scope: ${chatId}`);
    this.data.chats[chatId] = {
      cwd: previous.pendingCwd ?? previous.cwd,
      codexProfile: profile,
      launchMode,
      ...(launchMode === 'resume' ? { launchPending: true } : {}),
      ...(previous.codexSandbox ? { codexSandbox: previous.codexSandbox } : {}),
    };
    this.schedulePersist();
  }

  confirmCodexResume(chatId: string): void {
    const previous = this.data.chats[chatId];
    if (!previous) return;
    this.data.chats[chatId] = { ...previous, launchMode: 'resume', launchPending: false };
    this.schedulePersist();
  }

  codexProfileFor(chatId: string, fallback?: string): string | undefined {
    const value = this.data.chats[chatId]?.codexProfile;
    if (value === null) return undefined;
    if (typeof value === 'string' && value.trim()) return value;
    return this.defaultCodexProfile(fallback);
  }

  defaultCodexProfile(fallback?: string): string | undefined {
    const value = this.data.defaultCodexProfile;
    if (value === null) return undefined;
    return typeof value === 'string' && value.trim() ? value : fallback;
  }

  setDefaultCodexProfile(profile: string | null): void {
    this.data.defaultCodexProfile = profile;
    this.schedulePersist();
  }

  codexLaunchPendingFor(chatId: string): boolean {
    return this.data.chats[chatId]?.launchPending === true;
  }

  setCodexSandbox(chatId: string, sandbox: CodexSandboxMode): void {
    const previous = this.data.chats[chatId];
    if (!previous?.cwd) throw new Error(`workspace cwd is not set for scope: ${chatId}`);
    this.data.chats[chatId] = { ...previous, codexSandbox: sandbox };
    this.schedulePersist();
  }

  codexSandboxFor(chatId: string): CodexSandboxMode | undefined {
    return this.data.chats[chatId]?.codexSandbox;
  }

  setCodexModel(chatId: string, model: string | null): void {
    const previous = this.data.chats[chatId];
    if (!previous?.cwd) throw new Error(`workspace cwd is not set for scope: ${chatId}`);
    this.data.chats[chatId] = { ...previous, codexModel: model };
    this.schedulePersist();
  }

  codexModelFor(chatId: string, fallback?: string): string | undefined {
    const value = this.data.chats[chatId]?.codexModel;
    if (value === null) return undefined;
    return typeof value === 'string' && value.trim() ? value : fallback;
  }

  setCodexPersonality(chatId: string, personality: 'friendly' | 'pragmatic' | 'none'): void {
    const previous = this.data.chats[chatId];
    if (!previous?.cwd) throw new Error(`workspace cwd is not set for scope: ${chatId}`);
    this.data.chats[chatId] = { ...previous, codexPersonality: personality };
    this.schedulePersist();
  }

  codexPersonalityFor(chatId: string): 'friendly' | 'pragmatic' | 'none' | undefined {
    return this.data.chats[chatId]?.codexPersonality;
  }

  removeCwd(chatId: string): boolean {
    if (!(chatId in this.data.chats)) return false;
    delete this.data.chats[chatId];
    this.schedulePersist();
    return true;
  }

  projectChatFor(cwd: string): ProjectChatBinding | undefined {
    const binding = this.data.projectChats[cwd];
    return binding ? { ...binding } : undefined;
  }

  projectPathForChat(chatId: string): string | undefined {
    return Object.entries(this.data.projectChats)
      .find(([, binding]) => binding.chatId === chatId)?.[0];
  }

  setProjectChat(cwd: string, binding: ProjectChatBinding): void {
    this.data.projectChats[cwd] = { ...binding };
    this.schedulePersist();
  }

  removeProjectChat(cwd: string): boolean {
    if (!(cwd in this.data.projectChats)) return false;
    delete this.data.projectChats[cwd];
    this.schedulePersist();
    return true;
  }

  listCwds(prefix?: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.data.chats)) {
      if (prefix && !key.startsWith(prefix)) continue;
      out[key] = value.cwd;
    }
    return out;
  }

  listNamed(): Record<string, string> {
    return { ...this.data.named };
  }

  getNamed(name: string): string | undefined {
    return this.data.named[name];
  }

  saveNamed(name: string, cwd: string): void {
    this.data.named[name] = cwd;
    this.schedulePersist();
  }

  removeNamed(name: string): boolean {
    if (!(name in this.data.named)) return false;
    delete this.data.named[name];
    this.schedulePersist();
    return true;
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        await writeFileAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`, {
          mode: 0o600,
        });
      })
      .catch((err: unknown) => {
        log.fail('workspace', err, { step: 'persist' });
      });
  }
}
