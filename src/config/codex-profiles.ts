import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parse } from 'smol-toml';

export interface DiscoverCodexProfilesOptions {
  cwd: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  profileStateDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface LoadCodexProfileConfigOptions extends DiscoverCodexProfilesOptions {
  profile: string;
}

/** Discover named `[profiles.<name>]` tables from the Codex user and project config. */
export async function discoverCodexProfiles(
  options: DiscoverCodexProfilesOptions,
): Promise<string[]> {
  const env = options.env ?? process.env;
  const userHome = resolveCodexHome(options, env);
  const files = [...new Set([
    join(userHome, 'config.toml'),
    join(options.cwd, '.codex', 'config.toml'),
  ])];
  const profiles = new Set<string>();
  for (const file of files) {
    const text = await readConfigIfPresent(file);
    if (text !== undefined) collectProfileNames(text, profiles);
  }
  for (const name of await listProfileLayerFiles(userHome)) profiles.add(name);
  return [...profiles].sort((a, b) => a.localeCompare(b));
}

async function listProfileLayerFiles(codexHome: string): Promise<string[]> {
  try {
    const entries = await readdir(codexHome, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.config.toml'))
      .map((entry) => entry.name.slice(0, -'.config.toml'.length))
      .filter(Boolean);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export function parseCodexProfileNames(text: string): string[] {
  const profiles = new Set<string>();
  collectProfileNames(text, profiles);
  return [...profiles].sort((a, b) => a.localeCompare(b));
}

/** Load the selected profile layer for app-server's per-thread `config` override. */
export async function loadCodexProfileConfig(
  options: LoadCodexProfileConfigOptions,
): Promise<Record<string, unknown>> {
  const codexHome = resolveCodexHome(options, options.env ?? process.env);
  if (basename(options.profile) !== options.profile || options.profile === '.' || options.profile === '..') {
    throw new Error(`invalid Codex profile name: ${options.profile}`);
  }

  const profileFile = join(codexHome, `${options.profile}.config.toml`);
  const profileText = await readConfigIfPresent(profileFile);
  if (profileText !== undefined) return parseProfileConfig(profileText, profileFile);

  for (const file of [
    join(codexHome, 'config.toml'),
    join(options.cwd, '.codex', 'config.toml'),
  ]) {
    const text = await readConfigIfPresent(file);
    if (text === undefined) continue;
    const config = parseProfileConfig(text, file);
    const profiles = asRecord(config.profiles);
    const selected = asRecord(profiles?.[options.profile]);
    if (selected) return selected;
  }

  throw new Error(`Codex profile \"${options.profile}\" was not found in ${codexHome}`);
}

function collectProfileNames(text: string, output: Set<string>): void {
  const table = /^\s*\[\s*profiles\s*\.\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(?:\.|\])/gm;
  for (const match of text.matchAll(table)) {
    const name = match[1] !== undefined
      ? decodeDoubleQuotedKey(match[1])
      : (match[2] ?? match[3] ?? '').trim();
    if (name) output.add(name);
  }
}

function decodeDoubleQuotedKey(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

async function readConfigIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export function resolveCodexHome(
  options: DiscoverCodexProfilesOptions,
  env: NodeJS.ProcessEnv,
): string {
  return options.codexHome
    ?? (options.inheritCodexHome === false && options.profileStateDir
      ? join(options.profileStateDir, 'codex-home')
      : env.CODEX_HOME || join(homedir(), '.codex'));
}

function parseProfileConfig(text: string, path: string): Record<string, unknown> {
  try {
    return parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`failed to parse Codex profile config ${path}`, { cause: err });
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
