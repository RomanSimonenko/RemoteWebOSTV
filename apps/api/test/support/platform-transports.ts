import { Lgtv2Adapter, createLgtv2Client } from '@remote-webos-tv/webos';
import { createSamsungAdapter, type SamsungSocket } from '@remote-webos-tv/tizen';
import type { TvServiceDependencies } from '../../src/tv/service.js';
import { barrier, ControlledScheduler } from './tv-harness.js';

interface LgTransport {
  readonly url: string;
  readonly pointerFrames: readonly string[];
  readonly activeSocketCount: number;
  readonly pairingPromptCount: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  waitForPointerFrameCount(count: number): Promise<void>;
  waitForActiveSocketCount(count: number): Promise<void>;
}
interface SamsungTransport extends SamsungSocket {
  readonly frames: string[];
  readonly terminateCount: number;
  readonly listenerCount: number;
  open(): void;
  message(payload: unknown): void;
  close(): void;
}

/** Real adapters, external network boundaries replaced with synthetic transports. */
export async function platformTransports(scheduler: ControlledScheduler) {
  // Package test utilities must stay outside API production output.
  const { MockWebOsTv } = await import(new URL('../../../../packages/webos/test/support/mock-webos-tv.js', import.meta.url).href);
  const { ControlledSocket, identitySample, connectSample } = await import(new URL('../../../../packages/tizen/test/support/mock-samsung.js', import.meta.url).href);
  const lg: LgTransport = new MockWebOsTv({ scenario: { kind: 'success' } });
  await lg.start();
  const sockets: SamsungTransport[] = [];
  const urls: string[] = [];
  let nextSocket = barrier<SamsungTransport>();
  const createAdapter: TvServiceDependencies['createAdapter'] = (host, keyStore, requestTimeoutMs, allowPairingPrompt, platform = 'webos') => {
    if (platform === 'tizen') return createSamsungAdapter({ host, requestTimeoutMs, handshakeTimeoutMs: requestTimeoutMs, allowPairingPrompt, scheduler,
      requestIdentity: async () => identitySample,
      createSocket(url) {
        const socket: SamsungTransport = new ControlledSocket();
        sockets.push(socket); urls.push(url); nextSocket.resolve(socket); return socket;
      },
    });
    return new Lgtv2Adapter({ host, keyStore, requestTimeoutMs, handshakeTimeoutMs: requestTimeoutMs, allowPairingPrompt, now: () => new Date(0) }, {
      createClient(options) {
        const port = Number(new URL(lg.url).port);
        return createLgtv2Client({ ...options, host: '127.0.0.1', ports: { secure: port, insecure: port }, verifyCert: false });
      },
      wake: async () => { throw new Error('Synthetic tests prohibit UDP broadcast'); },
    });
  };
  async function finishSamsung(accepted = true, token?: string) {
    const socket = await nextSocket.promise;
    nextSocket = barrier<SamsungTransport>();
    socket.open(); socket.message(accepted ? connectSample(token) : { event: 'ms.channel.unauthorized' });
    return socket;
  }
  return { lg, sockets, urls, createAdapter, finishSamsung, close: () => lg.stop() };
}
