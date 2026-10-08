import type {
  TvApp, TvButton, TvCapabilities, TvIdentity, TvInput, TvSnapshot, TvTransport,
} from '@remote-webos-tv/contracts';

export * from './errors.js';

export interface PairingRequest {
  readonly host: string;
  readonly credential?: string;
  readonly signal: AbortSignal;
}

export interface PairingResult {
  readonly credential: string;
  readonly identity: TvIdentity;
  readonly capabilities: TvCapabilities;
  readonly transport: TvTransport;
  readonly macAddresses: readonly string[];
}

export interface PlatformVersionDiagnostic {
  readonly operation: 'hello';
  readonly code: 'timeout' | 'invalid_response' | 'version_unavailable' | 'request_rejected' | 'send_failed';
}

export type PlatformVersionResult =
  | { readonly version: string; readonly diagnostic?: never }
  | { readonly version?: never; readonly diagnostic: PlatformVersionDiagnostic };

export interface TvAdapter {
  pair(request: PairingRequest): Promise<PairingResult>;
  readSnapshot(signal: AbortSignal): Promise<TvSnapshot>;
  prepareRemote(signal: AbortSignal): Promise<void>;
  sendButton(button: TvButton, signal: AbortSignal): Promise<void>;
  disconnect(): Promise<void>;
  /** Optional metadata acquisition; at most one wire attempt per connection. */
  readPlatformVersion?(signal: AbortSignal): Promise<PlatformVersionResult>;
  launchApp?(id: string, signal: AbortSignal): Promise<void>;
  listApps?(signal: AbortSignal): Promise<readonly TvApp[]>;
  listInputs?(signal: AbortSignal): Promise<readonly TvInput[]>;
  powerOff?(signal: AbortSignal): Promise<void>;
  wake?(macAddresses: readonly string[], signal: AbortSignal): Promise<void>;
}
