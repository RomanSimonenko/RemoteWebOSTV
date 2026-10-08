import type { TvApp, TvInput } from '@remote-webos-tv/contracts';
import type { PairingRequest as TvPairingRequest, PairingResult as TvPairingResult, TvAdapter } from '@remote-webos-tv/tv-adapter';
export type { PlatformVersionDiagnostic, PlatformVersionResult } from '@remote-webos-tv/tv-adapter';

export interface PairingRequest extends TvPairingRequest {
  /** Legacy LG-specific authorization name. Neutral callers use credential. */
  readonly clientKey?: string;
}

export interface PairingResult extends TvPairingResult {
  /** Legacy LG-specific result, retained for protocol-probe callers. */
  readonly clientKey: string;
}

export interface WebOsAdapter extends TvAdapter {
  pair(request: PairingRequest): Promise<PairingResult>;
  openPointerSocket(signal: AbortSignal): Promise<void>;
  listApps(signal: AbortSignal): Promise<readonly TvApp[]>;
  listInputs(signal: AbortSignal): Promise<readonly TvInput[]>;
  powerOff(signal: AbortSignal): Promise<void>;
  wake(macAddresses: readonly string[], signal: AbortSignal): Promise<void>;
}
