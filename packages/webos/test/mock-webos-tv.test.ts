import { once } from 'node:events';

import { afterEach, describe, expect, test } from 'vitest';
import WebSocket from 'ws';

import {
  MockWebOsTv,
  type MockScenario,
} from './support/mock-webos-tv.js';
import {
  mockClientKey,
  mockResponses,
  mockUris,
} from './support/fixtures.js';

interface ProtocolMessage {
  readonly id: string;
  readonly type: string;
  readonly payload?: Record<string, unknown>;
  readonly error?: string;
}

interface MessageQueue {
  readonly size: number;
  next(): Promise<ProtocolMessage>;
}

const startedMocks: MockWebOsTv[] = [];

afterEach(async () => {
  await Promise.all(startedMocks.splice(0).map((mock) => mock.stop()));
});

async function startMock(scenario: MockScenario): Promise<MockWebOsTv> {
  const mock = new MockWebOsTv({ scenario });
  startedMocks.push(mock);
  await mock.start();
  return mock;
}

async function connect(url: string): Promise<{
  readonly socket: WebSocket;
  readonly messages: MessageQueue;
}> {
  const socket = new WebSocket(url);
  const messages = createMessageQueue(socket);
  await once(socket, 'open');
  return { socket, messages };
}

function createMessageQueue(socket: WebSocket): MessageQueue {
  const queued: ProtocolMessage[] = [];
  const waiters: Array<(message: ProtocolMessage) => void> = [];

  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as ProtocolMessage;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(message);
    } else {
      queued.push(message);
    }
  });

  return {
    get size() {
      return queued.length;
    },
    next() {
      const message = queued.shift();
      if (message) {
        return Promise.resolve(message);
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

async function register(
  socket: WebSocket,
  messages: MessageQueue,
  id = 'register-1',
): Promise<ProtocolMessage> {
  socket.send(
    JSON.stringify({
      id,
      type: 'register',
      payload: {
        'client-key': 'incoming-synthetic-secret',
        manifest: { permissions: ['CONTROL_AUDIO'] },
      },
    }),
  );

  const first = await messages.next();
  if (first.type === 'registered' || first.type === 'error') {
    return first;
  }
  expect(first).toMatchObject({
    id,
    type: 'response',
    payload: { pairingType: 'PROMPT' },
  });
  return messages.next();
}

async function request(
  socket: WebSocket,
  messages: MessageQueue,
  id: string,
  uri: string,
): Promise<ProtocolMessage> {
  socket.send(JSON.stringify({ id, type: 'request', uri, payload: {} }));
  return messages.next();
}

describe('MockWebOsTv', () => {
  test('listens on loopback, registers and answers every supported SSAP request', async () => {
    const mock = await startMock({ kind: 'success' });
    expect(mock.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    const { socket, messages } = await connect(mock.url);

    await expect(register(socket, messages)).resolves.toEqual({
      id: 'register-1',
      type: 'registered',
      payload: { 'client-key': mockClientKey },
    });

    for (const [index, [uri, payload]] of Object.entries(
      mockResponses,
    ).entries()) {
      await expect(
        request(socket, messages, `request-${index}`, uri),
      ).resolves.toEqual({
        id: `request-${index}`,
        type: 'response',
        payload,
      });
    }

    const recorded = JSON.stringify(mock.requests);
    expect(recorded).not.toContain('incoming-synthetic-secret');
    expect(recorded).not.toContain('CONTROL_AUDIO');
    expect(mock.requests[0]).toEqual({
      id: 'register-1',
      type: 'register',
    });
    expect(mock.requests.slice(1).map(({ id, uri }) => ({ id, uri }))).toEqual(
      Object.keys(mockResponses).map((uri, index) => ({
        id: `request-${index}`,
        uri,
      })),
    );
  });

  test('rejects pairing with the original request id', async () => {
    const mock = await startMock({ kind: 'reject-pairing' });
    const { socket, messages } = await connect(mock.url);

    await expect(register(socket, messages, 'rejected-registration')).resolves.toEqual({
      id: 'rejected-registration',
      type: 'error',
      error: '403 cancelled',
      payload: {
        returnValue: false,
        errorCode: 403,
        errorText: 'Pairing rejected',
      },
    });
  });

  test('waits for the pairing gate after emitting the prompt', async () => {
    let releasePairing!: () => void;
    const gate = new Promise<void>((resolve) => {
      releasePairing = resolve;
    });
    const mock = await startMock({ kind: 'deferred-pairing', gate });
    const { socket, messages } = await connect(mock.url);

    socket.send(
      JSON.stringify({ id: 'deferred', type: 'register', payload: {} }),
    );
    await expect(messages.next()).resolves.toMatchObject({
      id: 'deferred',
      type: 'response',
      payload: { pairingType: 'PROMPT' },
    });
    expect(messages.size).toBe(0);

    releasePairing();
    await expect(messages.next()).resolves.toEqual({
      id: 'deferred',
      type: 'registered',
      payload: { 'client-key': mockClientKey },
    });
  });

  test('returns a working pointer URL and records specialized frames', async () => {
    const mock = await startMock({ kind: 'success' });
    const { socket, messages } = await connect(mock.url);
    await register(socket, messages);

    const pointerResponse = await request(
      socket,
      messages,
      'pointer-1',
      mockUris.pointer,
    );
    expect(pointerResponse).toEqual({
      id: 'pointer-1',
      type: 'response',
      payload: { socketPath: `${mock.url}/pointer` },
    });

    const pointer = await connect(`${mock.url}/pointer`);
    pointer.socket.send('type:button\nname:HOME\n\n');
    await mock.waitForPointerFrameCount(1);
    expect(mock.pointerFrames).toEqual(['type:button\nname:HOME\n\n']);
  });

  test('can forbid the pointer endpoint with a 401 response', async () => {
    const mock = await startMock({ kind: 'pointer-forbidden' });
    const { socket, messages } = await connect(mock.url);
    await register(socket, messages);

    await expect(
      request(socket, messages, 'pointer-forbidden', mockUris.pointer),
    ).resolves.toEqual({
      id: 'pointer-forbidden',
      type: 'error',
      error: '401 insufficient permissions',
      payload: {
        returnValue: false,
        errorCode: 401,
        errorText: 'Pointer access forbidden',
      },
    });
  });

  test.each([
    ['close-before-response', false],
    ['close-after-response', true],
  ] as const)(
    '%s closes at the configured response boundary',
    async (kind, shouldRespond) => {
      const uri = mockUris.volume;
      const mock = await startMock({ kind, uri });
      const { socket, messages } = await connect(mock.url);
      await register(socket, messages);
      const closed = once(socket, 'close');

      socket.send(
        JSON.stringify({ id: 'boundary', type: 'request', uri, payload: {} }),
      );
      if (shouldRespond) {
        await expect(messages.next()).resolves.toEqual({
          id: 'boundary',
          type: 'response',
          payload: mockResponses[uri],
        });
      }
      await closed;
      expect(messages.size).toBe(0);
    },
  );

  test('rejects invalid and unknown requests without losing their ids', async () => {
    const mock = await startMock({ kind: 'success' });
    const { socket, messages } = await connect(mock.url);
    await register(socket, messages);

    socket.send(JSON.stringify({ id: 'invalid-1', type: 'request' }));
    await expect(messages.next()).resolves.toMatchObject({
      id: 'invalid-1',
      type: 'error',
      error: '400 invalid request',
    });

    await expect(
      request(socket, messages, 'unknown-1', 'ssap://synthetic/unknown'),
    ).resolves.toMatchObject({
      id: 'unknown-1',
      type: 'error',
      error: '404 no such service or method',
    });
  });

  test('teardown closes main and pointer sockets', async () => {
    const mock = await startMock({ kind: 'success' });
    const main = await connect(mock.url);
    await register(main.socket, main.messages);
    await request(main.socket, main.messages, 'pointer-1', mockUris.pointer);
    const pointer = await connect(`${mock.url}/pointer`);
    const mainClosed = once(main.socket, 'close');
    const pointerClosed = once(pointer.socket, 'close');

    await mock.stop();

    await Promise.all([mainClosed, pointerClosed]);
    expect(mock.activeSocketCount).toBe(0);
  });
});
