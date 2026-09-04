import { describe, expect, it } from 'vitest';
import { initialState, reduce } from '../../../src/card/run-state';

describe('run state terminal event schema', () => {
  it('maps done termination reasons onto visible terminal states', () => {
    expect(reduce(initialState, { type: 'done', terminationReason: 'normal' }).terminal).toBe(
      'done',
    );
    expect(
      reduce(initialState, { type: 'done', terminationReason: 'interrupted' }).terminal,
    ).toBe('interrupted');
    expect(reduce(initialState, { type: 'done', terminationReason: 'timeout' }).terminal).toBe(
      'idle_timeout',
    );
  });

  it('maps error termination reasons onto visible terminal states', () => {
    expect(
      reduce(initialState, {
        type: 'error',
        message: 'failed',
        terminationReason: 'failed',
      }).terminal,
    ).toBe('error');
    expect(
      reduce(initialState, {
        type: 'error',
        message: 'stopped',
        terminationReason: 'interrupted',
      }).terminal,
    ).toBe('interrupted');
    expect(
      reduce(initialState, {
        type: 'error',
        message: 'timeout',
        terminationReason: 'timeout',
      }).terminal,
    ).toBe('idle_timeout');
  });

  it('replaces plan snapshots and clears the active goal', () => {
    const withGoal = reduce(initialState, {
      type: 'goal_update',
      goal: {
        objective: 'Ship the bridge',
        status: 'active',
        tokenBudget: 10_000,
        tokensUsed: 250,
        timeUsedSeconds: 30,
        createdAt: 1,
        updatedAt: 2,
        observedAtMs: 3,
      },
    });
    const firstPlan = reduce(withGoal, {
      type: 'plan_update',
      steps: [
        { step: 'Inspect', status: 'completed' },
        { step: 'Patch', status: 'inProgress' },
      ],
    });
    const latestPlan = reduce(firstPlan, {
      type: 'plan_update',
      explanation: 'Latest snapshot',
      steps: [{ step: 'Test', status: 'inProgress' }],
    });

    expect(latestPlan.plan).toEqual({
      explanation: 'Latest snapshot',
      steps: [{ step: 'Test', status: 'inProgress' }],
    });
    expect(reduce(latestPlan, { type: 'goal_clear' }).goal).toBeUndefined();
  });
});
