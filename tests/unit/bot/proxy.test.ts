import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import { describe, expect, it } from 'vitest';
import { buildProxyAwareTransportOptions } from '../../../src/bot/proxy.js';

describe('buildProxyAwareTransportOptions', () => {
  it('uses one explicit proxy agent for REST and WebSocket', () => {
    const options = buildProxyAwareTransportOptions({
      https_proxy: 'http://127.0.0.1:7897',
    });

    expect(options.respectProxyEnv).toBe(false);
    expect(options.agent).toBeDefined();
    expect(options.httpInstance).toBe(defaultHttpInstance);
    expect(defaultHttpInstance.defaults.httpAgent).toBe(options.agent);
    expect(defaultHttpInstance.defaults.httpsAgent).toBe(options.agent);
    expect(defaultHttpInstance.defaults.proxy).toBe(false);
    expect(defaultHttpInstance.defaults.timeout).toBe(30_000);
  });

  it('keeps the channel default path when no proxy is configured', () => {
    const options = buildProxyAwareTransportOptions({});

    expect(options).toEqual({
      httpTimeoutMs: 30_000,
      respectProxyEnv: true,
    });
  });
});
