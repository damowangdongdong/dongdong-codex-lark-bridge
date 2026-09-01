import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import { createRuntimeAgent } from '../../../src/cli/commands/start';
import { resolveProfileRuntime } from '../../../src/runtime/profile-runtime';

const { loadRootConfig } = await import('../../../src/config/profile-store');

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('Codex startup compatibility with legacy binary metadata', () => {
  it('loads a legacy Codex profile that only has binaryPath, past agent availability', async () => {
    const h = await createLegacyCodexConfig({ codexMetadata: {} });
    const runtime = await resolveProfileRuntime({ config: h.configPath, profile: 'codex', allowBootstrap: false });
    const agent = createRuntimeAgent(runtime.profileConfig, { ...runtime.appPaths, configPath: runtime.configPath });
    expect(agent.id).toBe('codex');
    expect(await agent.isAvailable()).toBe(true);
  });

  it('loads and refreshes stale legacy Codex metadata, past agent availability', async () => {
    const h = await createLegacyCodexConfig({ codexMetadata: staleLegacyMetadata() });
    const runtime = await resolveProfileRuntime({ config: h.configPath, profile: 'codex', allowBootstrap: false });
    const agent = createRuntimeAgent(runtime.profileConfig, { ...runtime.appPaths, configPath: runtime.configPath });
    expect(agent.id).toBe('codex');
    expect(await agent.isAvailable()).toBe(true);
  });

  it('prepares the first Codex run from config even when legacy metadata points elsewhere', async () => {
    const h = await createLegacyCodexConfig({
      codexMetadata: staleLegacyMetadata(),
    });
    const root = await loadRootConfig(h.configPath);
    const profile = root?.profiles.codex;
    expect(profile).toBeDefined();

    const agent = createRuntimeAgent(profile!, {
      profile: 'codex',
      rootDir: h.root,
      profileDir: join(h.root, 'profiles', 'codex'),
      configPath: h.configPath,
    });

    try {
      await expect(
        agent.prepareRun?.({
          runId: 'run-1',
          prompt: 'hello',
          cwd: h.workspace,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await agent.close?.();
    }
  });
});

async function createLegacyCodexConfig(options: {
  codexMetadata: {
    realpath?: string;
    version?: string;
    sha256?: string;
    owner?: number;
    mode?: number;
  };
}) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-codex-legacy-config-'));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  const workspace = join(root, 'workspace');
  const binDir = join(root, 'bin');
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(binDir, { recursive: true }),
  ]);
  const codex = join(binDir, 'codex');
  const wsEntry = createRequire(import.meta.url).resolve('ws');
  await writeFile(
    codex,
    [
      `#!${process.execPath}`,
      "import { createServer } from 'node:http';",
      `import ws from ${JSON.stringify(wsEntry)};`,
      'const { WebSocketServer } = ws;',
      'const argv = process.argv.slice(2);',
      "if (argv[0] === '--version') { console.log('codex-cli 999.0.0'); process.exit(0); }",
      "const endpoint = argv[argv.indexOf('--listen') + 1];",
      'const listenUrl = new URL(endpoint);',
      'const server = createServer();',
      'const wss = new WebSocketServer({ server });',
      "wss.on('connection', (socket) => socket.on('message', (raw) => {",
      '  const message = JSON.parse(String(raw));',
      "  if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: { userAgent: 'fake', platformFamily: 'unix', platformOs: 'linux' } }));",
      '}));',
      'server.listen(Number(listenUrl.port), listenUrl.hostname);',
      "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(codex, 0o755);

  const secrets = {
    providers: {
      test: {
        source: 'env' as const,
        allowlist: ['BRIDGE_TEST_APP_SECRET'],
      },
    },
  };
  const profile = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: {
      app: {
        id: 'cli_test',
        secret: { source: 'env', provider: 'test', id: 'BRIDGE_TEST_APP_SECRET' },
        tenant: 'feishu',
      },
    },
    secrets,
    codex: {
      binaryPath: codex,
      ...options.codexMetadata,
    },
  });
  profile.workspaces.default = workspace;
  const rootConfig = createRootConfig('codex', profile, secrets);
  const configPath = join(root, 'config.json');
  await saveRootConfig(rootConfig, configPath);

  return { root, configPath, workspace, codex };
}

function staleLegacyMetadata() {
  return {
    realpath: '/opt/old-codex/bin/codex',
    version: 'codex-cli 0.130.0',
    sha256: '0'.repeat(64),
    owner: 0,
    mode: 0o700,
  };
}
