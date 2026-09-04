export interface Lgtv2ClientOptions {
  readonly host: string;
  readonly clientKey: string;
  readonly saveKey: (
    key: string,
    callback: (error?: Error | null) => void,
  ) => void;
  readonly timeout: number;
  readonly handshakeTimeout: number;
  readonly reconnect: 0;
  readonly verifyCert: 'lg' | false;
  readonly learnMac: false;
  readonly macFile: string;
  readonly secure?: boolean;
  readonly ports?: {
    readonly secure?: number;
    readonly insecure?: number;
  };
  readonly url?: string;
}

export interface Lgtv2SpecializedSocket {
  /** Runtime-owned WebSocket exposed by lgtv2@2.0.0's wrapper. */
  readonly ws?: { readonly readyState: number };
  send(type: string, payload?: Record<string, string | number>): void;
  close(): void;
}

export interface Lgtv2ClientEvents {
  readonly connecting: readonly [url: string];
  readonly prompt: readonly [];
  readonly connect: readonly [];
  readonly close: readonly [info: { readonly code: number; readonly reason: string }];
  readonly error: readonly [error: Error];
}

export interface Lgtv2Client {
  readonly connected: boolean;
  readonly urls: readonly string[];
  on<Event extends keyof Lgtv2ClientEvents>(
    event: Event,
    listener: (...args: Lgtv2ClientEvents[Event]) => void,
  ): this;
  request<T = unknown>(uri: string, payload?: Record<string, unknown>): Promise<T>;
  getSocket(uri: string): Promise<Lgtv2SpecializedSocket>;
  wake(mac: string | readonly string[]): Promise<void>;
  disconnect(): Promise<void>;
}

export type Lgtv2ClientFactory = (
  options: Lgtv2ClientOptions,
) => Lgtv2Client;
