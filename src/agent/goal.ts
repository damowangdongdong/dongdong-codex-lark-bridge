import type { AgentGoal, AgentGoalStatus } from './types';

export const CODEX_GOAL_CONTINUATION_CLIENT_ID = 'lark-channel-bridge:goal-continuation';

export function parseCodexGoal(value: unknown, observedAtMs = Date.now()): AgentGoal | undefined {
  const goal = recordValue(value);
  const objective = stringValue(goal?.objective);
  const status = stringValue(goal?.status);
  if (!objective || !isGoalStatus(status)) return undefined;
  return {
    objective,
    status,
    tokenBudget: nullableNumber(goal?.tokenBudget),
    tokensUsed: numberValue(goal?.tokensUsed) ?? 0,
    timeUsedSeconds: numberValue(goal?.timeUsedSeconds) ?? 0,
    createdAt: numberValue(goal?.createdAt) ?? 0,
    updatedAt: numberValue(goal?.updatedAt) ?? 0,
    observedAtMs,
  };
}

function isGoalStatus(value: string | undefined): value is AgentGoalStatus {
  return value === 'active'
    || value === 'paused'
    || value === 'blocked'
    || value === 'usageLimited'
    || value === 'budgetLimited'
    || value === 'complete';
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nullableNumber(value: unknown): number | null {
  return value === null ? null : numberValue(value) ?? null;
}
