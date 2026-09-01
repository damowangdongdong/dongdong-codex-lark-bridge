import { execFile } from 'node:child_process';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_TERMINATE_GRACE_MS = 2_000;

export function threadWriterLockPath(codexHome: string, threadId: string): string {
  return join(codexHome, 'thread-writer-locks', `${threadId}.lock`);
}

export async function findThreadWriterPids(
  codexHome: string,
  threadId: string,
): Promise<number[]> {
  const lockPath = threadWriterLockPath(codexHome, threadId);
  try {
    const { stdout } = await execFileAsync('lsof', ['-t', '--', lockPath], {
      encoding: 'utf8',
    });
    return [...new Set(
      stdout
        .split(/\s+/)
        .map((value) => Number.parseInt(value, 10))
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
    )];
  } catch (err) {
    if (execExitCode(err) === 1) return [];
    throw new Error(`无法检查 Codex thread writer：${errorMessage(err)}`, { cause: err });
  }
}

export async function isCodexProcess(pid: number, binary: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
    });
    const command = stdout.trim();
    if (!command) return false;
    const expected = basename(binary).toLowerCase();
    return command
      .split(/\s+/)
      .map((part) => basename(part.replace(/^['"]|['"]$/g, '')).toLowerCase())
      .some((part) =>
        part === expected
        || part === 'codex'
        || part === 'codex.exe'
        || part === 'codex.js'
        || part === 'codex.mjs',
      );
  } catch (err) {
    if (execExitCode(err) === 1) return false;
    throw new Error(`无法确认 thread writer 进程 ${pid}：${errorMessage(err)}`, { cause: err });
  }
}

export async function terminateProcess(
  pid: number,
  graceMs = DEFAULT_TERMINATE_GRACE_MS,
): Promise<void> {
  if (!processExists(pid)) return;
  process.kill(pid, 'SIGTERM');
  if (await waitForProcessExit(pid, graceMs)) return;
  process.kill(pid, 'SIGKILL');
  if (!await waitForProcessExit(pid, graceMs)) {
    throw new Error(`Codex writer 进程 ${pid} 未能终止`);
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !processExists(pid);
}

function execExitCode(err: unknown): number | undefined {
  return typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'number'
    ? err.code
    : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
