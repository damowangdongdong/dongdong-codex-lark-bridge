export interface BuildCodexAppServerArgsInput {
  endpoint: string;
  profile?: string;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
}

/** Build a persistent app-server command. Global Codex flags stay before the subcommand. */
export function buildCodexAppServerArgs(input: BuildCodexAppServerArgsInput): string[] {
  if (input.profile && input.ignoreUserConfig) {
    throw new Error('a Codex --profile cannot be used with --ignore-user-config');
  }
  return [
    ...(input.profile ? ['--profile', input.profile] : []),
    ...(input.ignoreUserConfig ? ['--ignore-user-config'] : []),
    ...(input.ignoreRules === false ? [] : ['--ignore-rules']),
    '-c',
    'shell_environment_policy.inherit="all"',
    'app-server',
    '--listen',
    input.endpoint,
  ];
}
