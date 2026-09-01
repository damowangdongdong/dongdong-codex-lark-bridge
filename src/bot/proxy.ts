import type { LarkChannelOptions } from '@larksuite/channel';
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import { HttpsProxyAgent } from 'https-proxy-agent';

const HTTP_TIMEOUT_MS = 30_000;

type TransportOptions = Pick<
  LarkChannelOptions,
  'agent' | 'httpInstance' | 'httpTimeoutMs' | 'respectProxyEnv'
>;

/**
 * Build the REST and WebSocket transport settings for the Lark SDK.
 *
 * Axios already reads HTTP(S)_PROXY from the environment. When the channel
 * also installs an HttpsProxyAgent, Axios otherwise applies the same proxy a
 * second time and sends an absolute HTTPS URL through the first tunnel. Keep
 * one explicit agent for both transports and disable Axios' implicit proxy.
 */
export function buildProxyAwareTransportOptions(
  env: NodeJS.ProcessEnv = process.env,
): TransportOptions {
  const proxyUrl =
    env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;

  if (!proxyUrl) {
    return {
      httpTimeoutMs: HTTP_TIMEOUT_MS,
      respectProxyEnv: true,
    };
  }

  const agent = new HttpsProxyAgent(proxyUrl);
  defaultHttpInstance.defaults.timeout = HTTP_TIMEOUT_MS;
  defaultHttpInstance.defaults.httpAgent = agent;
  defaultHttpInstance.defaults.httpsAgent = agent;
  defaultHttpInstance.defaults.proxy = false;

  return {
    agent,
    httpInstance: defaultHttpInstance,
    respectProxyEnv: false,
  };
}
