import type {
  TvApp,
  TvButton,
  TvCapabilities,
  TvIdentity,
  TvInput,
  TvSnapshot,
  TvTransport,
} from '@remote-webos-tv/contracts';

export interface PairingRequest {
  readonly host: string;
  readonly clientKey?: string;
  readonly signal: AbortSignal;
}

export interface PairingResult {
  readonly clientKey: string;
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

export interface WebOsAdapter {
  /** Optional metadata acquisition; at most one wire attempt per connection. */
  readPlatformVersion?(signal: AbortSignal): Promise<PlatformVersionResult>;
  pair(request: PairingRequest): Promise<PairingResult>;
  readSnapshot(signal: AbortSignal): Promise<TvSnapshot>;
  openPointerSocket(signal: AbortSignal): Promise<void>;
  listApps(signal: AbortSignal): Promise<readonly TvApp[]>;
  listInputs(signal: AbortSignal): Promise<readonly TvInput[]>;
  sendButton(button: TvButton, signal: AbortSignal): Promise<void>;
  powerOff(signal: AbortSignal): Promise<void>;
  wake(macAddresses: readonly string[], signal: AbortSignal): Promise<void>;
  disconnect(): Promise<void>;
}
