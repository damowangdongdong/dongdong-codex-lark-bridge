import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/agent/codex/adapter.js';
import {
  findThreadWriterPids,
  isCodexProcess,
  threadWriterLockPath,
} from '../../src/agent/codex/thread-writer.js';

describe.skipIf(process.platform === 'win32')('Codex thread writer takeover', () => {
  const cleanupDirs: string[] = [];
  const cleanupProcesses: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of cleanupProcesses.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await Promise.all(
      cleanupDirs.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('finds and terminates the Codex process holding a thread writer lock', async () => {
    const fixture = await createWriterFixture('codex');
    cleanupDirs.push(fixture.dir);
    const child = startWriter(fixture.lockPath, fixture.executable);
    cleanupProcesses.push(child);
    await waitForWriter(fixture.codexHome, fixture.threadId, child.pid!);
    await expect(isCodexProcess(child.pid!, fixture.executable)).resolves.toBe(true);
    const adapter = new CodexAdapter({
      binary: fixture.executable,
      profileStateDir: fixture.dir,
      codexHome: fixture.codexHome,
    });

    await expect(adapter.takeoverThreadWriter(fixture.threadId)).resolves.toEqual({
      terminatedPids: [child.pid],
    });
    await expect(waitForExit(child)).resolves.toBeUndefined();
  });

  it('refuses to terminate a non-Codex process holding the lock', async () => {
    const fixture = await createWriterFixture('worker');
    cleanupDirs.push(fixture.dir);
    const child = startWriter(fixture.lockPath, fixture.executable);
    cleanupProcesses.push(child);
    await waitForWriter(fixture.codexHome, fixture.threadId, child.pid!);
    await expect(isCodexProcess(child.pid!, '/usr/local/bin/codex')).resolves.toBe(false);
    const adapter = new CodexAdapter({
      binary: '/usr/local/bin/codex',
      profileStateDir: fixture.dir,
      codexHome: fixture.codexHome,
    });

    await expect(adapter.takeoverThreadWriter(fixture.threadId)).rejects.toThrow(
      /不是 Codex，已拒绝终止/,
    );
    expect(processExists(child.pid!)).toBe(true);
  });
});

async function createWriterFixture(name: string): Promise<{
  dir: string;
  codexHome: string;
  threadId: string;
  lockPath: string;
  executable: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-thread-writer-test-'));
  const codexHome = join(dir, 'codex-home');
  const threadId = '01a05b51-4651-73a2-a13f-b0fc1d13c9a7';
  const lockPath = threadWriterLockPath(codexHome, threadId);
  const executable = join(dir, name);
  await mkdir(join(codexHome, 'thread-writer-locks'), { recursive: true });
  await writeFile(executable, `#!${process.execPath}\nsetInterval(() => {}, 1_000);\n`, 'utf8');
  await chmod(executable, 0o755);
  return { dir, codexHome, threadId, lockPath, executable };
}

function startWriter(lockPath: string, executable: string): ChildProcess {
  return spawn('flock', ['-F', lockPath, executable], {
    stdio: 'ignore',
  });
}

async function waitForWriter(codexHome: string, threadId: string, pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const pids = await findThreadWriterPids(codexHome, threadId);
    if (pids.includes(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('writer process did not acquire the lock');
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
