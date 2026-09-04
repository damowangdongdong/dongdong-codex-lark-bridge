import type { AgentGoal, AgentPlanStep } from '../agent/types';
import type { FooterStatus, RunState } from './run-state';

export function renderRunStateMarkdown(state: RunState, nowMs = Date.now()): string {
  const sections: string[] = [];
  if (state.goal) sections.push(renderGoal(state.goal, state.terminal === 'running', nowMs));
  if (state.plan && (state.plan.steps.length > 0 || state.plan.explanation)) {
    sections.push(renderPlan(state.plan.explanation, state.plan.steps));
  }

  const lifecycle = lifecycleLine(state);
  if (lifecycle) sections.push(lifecycle);
  return sections.join('\n\n');
}

export function formatGoalSummary(goal: AgentGoal): string {
  return renderGoal(goal, false, goal.observedAtMs);
}

function renderGoal(goal: AgentGoal, running: boolean, nowMs: number): string {
  const elapsed = goal.timeUsedSeconds
    + (running && goal.status === 'active'
      ? Math.max(0, Math.floor((nowMs - goal.observedAtMs) / 1000))
      : 0);
  const title = goal.status === 'active'
    ? '🎯 **Pursuing goal'
    : goal.status === 'complete'
      ? '✅ **Goal achieved'
      : goal.status === 'paused'
        ? '⏸️ **Goal paused'
        : '⚠️ **Goal unmet';
  const budget = goal.tokenBudget === null
    ? ''
    : ` · ${formatCount(goal.tokensUsed)} / ${formatCount(goal.tokenBudget)} tokens`;
  return `${title} (${formatDuration(elapsed)})**${budget}\n${goal.objective}`;
}

function renderPlan(explanation: string | undefined, steps: AgentPlanStep[]): string {
  const lines = steps.map((step) => {
    const marker = step.status === 'completed' ? '☑' : step.status === 'inProgress' ? '▣' : '☐';
    const text = step.status === 'inProgress' ? `**${step.step}**` : step.step;
    return `${marker} ${text}`;
  });
  return [
    '📋 **Progress**',
    ...(explanation ? [`_${explanation}_`] : []),
    ...lines,
  ].join('\n');
}

function lifecycleLine(state: RunState): string | undefined {
  if (state.terminal === 'continued') return '_↘ 已在下方接续_';
  if (state.terminal === 'interrupted') return '_⏹ 已被中断_';
  if (state.terminal === 'idle_timeout') {
    return `_⏱ ${state.idleTimeoutMinutes ?? 0} 分钟无响应,已自动终止_`;
  }
  if (state.terminal === 'error' && state.errorMsg) return `⚠️ agent 失败：${state.errorMsg}`;
  if (state.terminal === 'running' && state.footer) return footerLine(state.footer);
  return undefined;
}

function footerLine(status: Exclude<FooterStatus, null>): string {
  if (status === 'thinking') return '_🧠 正在思考…_';
  if (status === 'tool_running') return '_🧰 正在调用工具…_';
  return '_✍️ 正在输出…_';
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(Math.max(0, Math.floor(value)));
}
