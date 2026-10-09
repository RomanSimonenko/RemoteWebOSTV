import { createServer, type Server } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, expect, test } from 'vitest';
import { createSamsungSocket, requestSamsungIdentity } from '../src/transport.js';
import { createSamsungAdapter } from '../src/samsung-adapter.js';
import { connectSample, deferred, identitySample } from './support/mock-samsung.js';
import { syntheticCertificate, syntheticPrivateKey } from './support/synthetic-tls.js';

const servers: Server[] = [];
const websocketServers: WebSocketServer[] = [];
afterEach(async () => {
  for (const wss of websocketServers.splice(0)) {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

test('HTTP identity transport uses actual JSON boundary', async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => { requests.push(req.url!); res.end(JSON.stringify(identitySample)); });
  const port = await listen(server);
  await expect(requestSamsungIdentity(`http://127.0.0.1:${port}/api/v2/`, new AbortController().signal)).resolves.toEqual(identitySample);
  expect(requests).toEqual(['/api/v2/']);
});

test('successive Samsung HTTP reads do not reuse a connection rejected by the TV', async () => {
  const used = new WeakSet<object>();
  const server = createServer((req, res) => {
    if (used.has(req.socket)) { req.socket.destroy(); return; }
    used.add(req.socket);
    res.end(JSON.stringify(identitySample));
  });
  const port = await listen(server);
  const url = `http://127.0.0.1:${port}/api/v2/`;
  for (let index = 0; index < 3; index++) {
    await expect(requestSamsungIdentity(url, new AbortController().signal)).resolves.toEqual(identitySample);
  }
});

test('HTTP redirect is rejected without contacting its target', async () => {
  let redirected = 0;
  const target = createServer((_req, res) => { redirected++; res.end('{}'); });
  const targetPort = await listen(target);
  const server = createServer((_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/secret` }); res.end(); });
  const port = await listen(server);
  await expect(requestSamsungIdentity(`http://127.0.0.1:${port}/api/v2/`, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_TV_RESPONSE' });
  expect(redirected).toBe(0);
});

test('HTTP malformed JSON never becomes a payload-bearing error', async () => {
  const server = createServer((_req, res) => res.end('synthetic-sensitive-marker'));
  const port = await listen(server);
  const error = await requestSamsungIdentity(`http://127.0.0.1:${port}/api/v2/`, new AbortController().signal).catch((cause: unknown) => cause);
  expect(error).toMatchObject({ code: 'INVALID_TV_RESPONSE' });
  expect((error as Error).message).not.toContain('synthetic-sensitive-marker');
  expect((error as Error).cause).toBeUndefined();
});

test('HTTP cancellation releases real pending request', async () => {
  const started = deferred<void>(); const closed = deferred<void>();
  const server = createServer((req) => { req.on('close', () => closed.resolve()); started.resolve(); });
  const port = await listen(server); const controller = new AbortController();
  const request = requestSamsungIdentity(`http://127.0.0.1:${port}/api/v2/`, controller.signal);
  request.catch(() => undefined);
  await started.promise; controller.abort();
  await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  await closed.promise;
});

test('HTTP size bound closes oversized response', async () => {
  const server = createServer((_req, res) => res.end('x'.repeat(1024 * 1024 + 1)));
  const port = await listen(server);
  await expect(requestSamsungIdentity(`http://127.0.0.1:${port}/api/v2/`, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_TV_RESPONSE' });
});

test('local Samsung TLS exception works while a regular client still rejects the same certificate', async () => {
  const server = createSecureServer({ key: syntheticPrivateKey, cert: syntheticCertificate });
  const wss = new WebSocketServer({ server }); websocketServers.push(wss);
  const frames = deferred<string>(); const channel = deferred<string>();
  wss.on('connection', (client, request) => {
    channel.resolve(request.url!);
    client.on('message', (data) => frames.resolve(data.toString()));
    client.send('{"event":"synthetic.event"}');
  });
  const port = await listen(server);
  const url = `wss://127.0.0.1:${port}/api/v2/channels/samsung.remote.control?name=synthetic&token=synthetic-token`;
  const original = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  const normal = new WebSocket(url);
  const normalError = deferred<Error>(); const normalClose = deferred<void>();
  normal.on('error', (error) => normalError.resolve(error)); normal.on('close', () => normalClose.resolve());
  await expect(normalError.promise).resolves.toBeInstanceOf(Error); await normalClose.promise;
  const socket = createSamsungSocket(url, { rejectUnauthorized: false });
  const opened = deferred<void>(); const message = deferred<string>(); const closed = deferred<void>();
  socket.onOpen(() => opened.resolve()); socket.onMessage((data) => message.resolve(data)); socket.onClose(() => closed.resolve());
  const error = deferred<never>(); socket.onError(error.reject);
  await Promise.race([opened.promise, error.promise]);
  await expect(message.promise).resolves.toBe('{"event":"synthetic.event"}');
  await new Promise<void>((resolve, reject) => socket.send('synthetic-frame', (cause) => cause ? reject(cause) : resolve()));
  await expect(frames.promise).resolves.toBe('synthetic-frame');
  await expect(channel.promise).resolves.toBe('/api/v2/channels/samsung.remote.control?name=synthetic&token=synthetic-token');
  socket.terminate(); await closed.promise;
  expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(original);
});

test('real adapter drives HTTP identity, owned WSS connect and button frame through actual transports', async () => {
  const identityServer = createServer((_req, res) => res.end(JSON.stringify(identitySample)));
  const identityPort = await listen(identityServer);
  const secureServer = createSecureServer({ key: syntheticPrivateKey, cert: syntheticCertificate });
  const wss = new WebSocketServer({ server: secureServer }); websocketServers.push(wss);
  const received = deferred<string>(); const closed = deferred<void>();
  wss.on('connection', (client) => {
    client.on('message', (data) => received.resolve(data.toString()));
    client.on('close', () => closed.resolve());
    client.send(JSON.stringify(connectSample()));
  });
  const socketPort = await listen(secureServer);
  const adapter = createSamsungAdapter({
    host: 'tv.invalid', allowPairingPrompt: true, acceptHost: (host) => host === 'tv.invalid',
    handshakeTimeoutMs: 1000, requestTimeoutMs: 1000,
    requestIdentity: (_url, signal) => requestSamsungIdentity(`http://127.0.0.1:${identityPort}/api/v2/`, signal),
    createSocket: (url, options) => {
      const routed = new URL(url); routed.hostname = '127.0.0.1'; routed.port = String(socketPort);
      return createSamsungSocket(routed.toString(), options);
    },
  });
  try {
    const signal = new AbortController().signal;
    await expect(adapter.pair({ host: 'tv.invalid', signal })).resolves.toMatchObject({ credential: 'synthetic-token', transport: 'wss:8002' });
    await adapter.prepareRemote(signal); await adapter.sendButton('ENTER', signal);
    await expect(received.promise).resolves.toBe('{"method":"ms.remote.control","params":{"Cmd":"Click","DataOfCmd":"KEY_ENTER","Option":"false","TypeOfRemote":"SendRemoteKey"}}');
    await adapter.disconnect(); await closed.promise;
    await expect(adapter.readSnapshot(signal)).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
  } finally { await adapter.disconnect(); }
});
