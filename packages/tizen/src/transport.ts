import { get } from 'node:http';
import WebSocket from 'ws';
import { WebOsError } from '@remote-webos-tv/tv-adapter';
import type { SamsungSocket } from './samsung-adapter.js';

// Input limits belong to the untrusted transport, not to arbitrary token policy.
const maximumResponseBytes = 1024 * 1024;

export function requestSamsungIdentity(url: string, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = get(url, { signal }, (response) => {
      if (response.statusCode !== 200) {
        response.destroy();
        reject(new WebOsError('INVALID_TV_RESPONSE', 'Samsung identity returned an unexpected HTTP status'));
        return;
      }
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      response.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length;
        if (receivedBytes > maximumResponseBytes) {
          request.destroy(new WebOsError('INVALID_TV_RESPONSE', 'Samsung identity exceeded response size limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); }
        catch { reject(new WebOsError('INVALID_TV_RESPONSE', 'Samsung identity returned invalid JSON')); }
      });
    });
    request.on('error', reject);
  });
}

export function createSamsungSocket(url: string, options: { readonly rejectUnauthorized: false }): SamsungSocket {
  const socket = new WebSocket(url, { ...options, maxPayload: maximumResponseBytes, followRedirects: false });
  const opened = new Set<() => void>();
  const closed = new Set<() => void>();
  const errors = new Set<(cause: Error) => void>();
  const messages = new Set<(text: string) => void>();
  const onOpen = () => { for (const listener of opened) listener(); };
  const onError = (cause: Error) => { for (const listener of [...errors]) listener(cause); };
  const onMessage = (data: WebSocket.RawData) => { for (const listener of messages) listener(data.toString()); };
  const onClose = () => {
    for (const listener of [...closed]) listener();
    opened.clear(); closed.clear(); errors.clear(); messages.clear();
    socket.removeListener('open', onOpen); socket.removeListener('close', onClose);
    socket.removeListener('error', onError); socket.removeListener('message', onMessage);
  };
  socket.on('open', onOpen); socket.on('message', onMessage); socket.on('close', onClose);
  // Keep the native error receiver until close completes: cancelled handshakes
  // can emit an asynchronous terminal error after adapter subscribers release.
  socket.on('error', onError);
  return {
    get readyState() { return socket.readyState; },
    onOpen(listener) { opened.add(listener); return () => opened.delete(listener); },
    onClose(listener) { closed.add(listener); return () => closed.delete(listener); },
    onError(listener) { errors.add(listener); return () => errors.delete(listener); },
    onMessage(listener) { messages.add(listener); return () => messages.delete(listener); },
    send: (text, callback) => socket.send(text, callback),
    terminate: () => socket.terminate(),
  };
}
