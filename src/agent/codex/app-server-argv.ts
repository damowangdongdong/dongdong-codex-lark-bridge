export interface BuildCodexAppServerArgsInput {
  endpoint: string;
}

/** Build a persistent app-server command. Named profile config is applied per thread. */
export function buildCodexAppServerArgs(input: BuildCodexAppServerArgsInput): string[] {
  return [
    '-c',
    'shell_environment_policy.inherit="all"',
    '-c',
    'tools.update_plan.enabled=true',
    'app-server',
    '--listen',
    input.endpoint,
  ];
}
