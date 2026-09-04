import type {
  AgentAdapter,
  AgentAdditionalContext,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../../src/agent/types.js';

export interface FakeAgentRun extends AgentRun {
  readonly opts: AgentRunOptions;
  readonly stopped: boolean;
  readonly waitForExitCalls: number;
  readonly steered: Array<{
    prompt: string;
    images: readonly string[];
    additionalContext?: AgentAdditionalContext;
  }>;
}

class FakeRun implements FakeAgentRun {
  readonly runId: string;
  readonly opts: AgentRunOptions;
  readonly events: AsyncIterable<AgentEvent>;
  readonly waitForExitResult: boolean;
  readonly steered: Array<{
    prompt: string;
    images: readonly string[];
    additionalContext?: AgentAdditionalContext;
  }> = [];
  #stopped = false;
  #waitForExitCalls = 0;

  constructor(
    opts: AgentRunOptions,
    events: readonly AgentEvent[],
    waitForExitResult: boolean,
  ) {
    this.runId = opts.runId;
    this.opts = opts;
    this.waitForExitResult = waitForExitResult;
    this.events = this.iterate(events);
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  get waitForExitCalls(): number {
    return this.#waitForExitCalls;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
  }

  async steer(
    prompt: string,
    images: readonly string[] = [],
    additionalContext?: AgentAdditionalContext,
  ): Promise<void> {
    this.steered.push({
      prompt,
      images,
      ...(additionalContext ? { additionalContext } : {}),
    });
  }

  async waitForExit(): Promise<boolean> {
    this.#waitForExitCalls++;
    return this.waitForExitResult;
  }

  private async *iterate(events: readonly AgentEvent[]): AsyncIterable<AgentEvent> {
    for (const event of events) {
      if (this.#stopped) return;
      yield event;
    }
  }
}

export type FakeAgentEvents =
  | readonly AgentEvent[]
  | readonly (readonly AgentEvent[])[];

export class FakeAgentAdapter implements AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly runs: FakeAgentRun[] = [];
  readonly runOptions: AgentRunOptions[] = [];
  botIdentity: AgentBotIdentity | undefined;
  readonly appServerRequests: Array<{ profile?: string; method: string; params?: unknown }> = [];
  readonly takeoverThreadWriterCalls: string[] = [];
  appServerEndpointValue = 'unix:///tmp/fake-codex.sock';
  private readonly appServerResponses = new Map<string, unknown>();
  private readonly appServerErrors = new Map<string, Error[]>();
  takeoverThreadWriterError: Error | undefined;
  #available: boolean;
  #eventRuns: AgentEvent[][];
  #waitForExitResults: boolean[];

  constructor(options: {
    id?: string;
    displayName?: string;
    available?: boolean;
    events?: FakeAgentEvents;
    waitForExit?: boolean | readonly boolean[];
  } = {}) {
    this.id = options.id ?? 'fake-agent';
    this.displayName = options.displayName ?? 'Fake Agent';
    this.#available = options.available ?? true;
    this.#eventRuns = normalizeEventRuns(options.events ?? []);
    this.#waitForExitResults = normalizeWaitForExitResults(options.waitForExit);
  }

  async isAvailable(): Promise<boolean> {
    return this.#available;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  run(opts: AgentRunOptions): AgentRun {
    this.runOptions.push(opts);
    const events = this.#eventRuns.shift() ?? [];
    const waitForExitResult = this.#waitForExitResults.shift() ?? true;
    const run = new FakeRun(opts, events, waitForExitResult);
    this.runs.push(run);
    return run;
  }

  enqueue(...events: AgentEvent[]): void {
    if (this.#eventRuns.length === 0) this.#eventRuns.push([]);
    this.#eventRuns[0]?.push(...events);
  }

  setEvents(events: FakeAgentEvents): void {
    this.#eventRuns = normalizeEventRuns(events);
  }

  setAvailable(available: boolean): void {
    this.#available = available;
  }

  setWaitForExit(result: boolean | readonly boolean[]): void {
    this.#waitForExitResults = normalizeWaitForExitResults(result);
  }

  async appServerRequest(profile: string | undefined, method: string, params?: unknown): Promise<unknown> {
    this.appServerRequests.push({ ...(profile ? { profile } : {}), method, ...(params === undefined ? {} : { params }) });
    const errors = this.appServerErrors.get(method);
    const error = errors?.shift();
    if (error) throw error;
    return this.appServerResponses.get(method) ?? {};
  }

  async appServerEndpoint(): Promise<string> {
    return this.appServerEndpointValue;
  }

  setAppServerResponse(method: string, response: unknown): void {
    this.appServerResponses.set(method, response);
  }

  setAppServerError(method: string, error: Error): void {
    const errors = this.appServerErrors.get(method) ?? [];
    errors.push(error);
    this.appServerErrors.set(method, errors);
  }

  async takeoverThreadWriter(threadId: string): Promise<{ terminatedPids: number[] }> {
    this.takeoverThreadWriterCalls.push(threadId);
    if (this.takeoverThreadWriterError) throw this.takeoverThreadWriterError;
    return { terminatedPids: [1234] };
  }
}

export function createFakeAgent(events: readonly AgentEvent[] = []): FakeAgentAdapter {
  return new FakeAgentAdapter({ events });
}

function normalizeEventRuns(events: FakeAgentEvents): AgentEvent[][] {
  if (events.length === 0) return [];
  return Array.isArray(events[0])
    ? (events as readonly (readonly AgentEvent[])[]).map((runEvents) => [...runEvents])
    : [[...(events as readonly AgentEvent[])]];
}

function normalizeWaitForExitResults(result: boolean | readonly boolean[] | undefined): boolean[] {
  if (result === undefined) return [];
  if (typeof result === 'boolean') return [result];
  return [...result];
}
