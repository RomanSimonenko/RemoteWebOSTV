import {
  tvAppSchema,
  tvIdentitySchema,
  tvInputSchema,
  tvTransportSchema,
  type TvApp,
  type TvIdentity,
  type TvInput,
  type TvTransport,
} from '@remote-webos-tv/contracts';
import { z } from 'zod';

import { WebOsError } from './errors.js';

const nonEmptyTextSchema = z.string().trim().min(1);
const volumeValueSchema = z.number().int().min(0).max(100);

const systemInfoResponseSchema = z
  .object({ modelName: nonEmptyTextSchema })
  .passthrough();
const softwareInfoResponseSchema = z
  .object({
    sdk_version: nonEmptyTextSchema.optional(),
    major_ver: nonEmptyTextSchema.optional(),
    minor_ver: nonEmptyTextSchema.optional(),
  })
  .passthrough();
const volumeResponseSchema = z
  .object({
    volume: volumeValueSchema.optional(),
    muted: z.boolean().optional(),
    volumeStatus: z
      .object({
        volume: volumeValueSchema.optional(),
        muteStatus: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const appResponseSchema = z
  .object({
    launchPoints: z.array(
      z
        .object({ id: nonEmptyTextSchema, title: nonEmptyTextSchema })
        .passthrough(),
    ),
  })
  .passthrough();
const inputResponseSchema = z
  .object({
    devices: z.array(
      z
        .object({
          id: nonEmptyTextSchema,
          label: nonEmptyTextSchema,
          connected: z.boolean().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const networkInterfaceSchema = z
  .object({ macAddress: nonEmptyTextSchema.optional() })
  .passthrough();
const networkResponseSchema = z
  .object({
    wiredInfo: networkInterfaceSchema.optional(),
    wifiInfo: networkInterfaceSchema.optional(),
  })
  .passthrough();

export interface ParsedVolume {
  readonly volume?: number;
  readonly muted?: boolean;
}

export function parseIdentity(
  systemInfo: unknown,
  softwareInfo: unknown,
): TvIdentity {
  return parseTvResponse('identity', () => {
    const system = systemInfoResponseSchema.parse(systemInfo);
    const software = softwareInfoResponseSchema.parse(softwareInfo);
    const firmwareVersion = [software.major_ver, software.minor_ver]
      .filter((part): part is string => part !== undefined)
      .join('.');

    return tvIdentitySchema.parse({
      model: system.modelName,
      ...(software.sdk_version === undefined
        ? {}
        : { platformVersion: software.sdk_version }),
      ...(firmwareVersion.length === 0 ? {} : { firmwareVersion }),
    });
  });
}

export function parseVolume(payload: unknown): ParsedVolume {
  return parseTvResponse('volume', () => {
    const response = volumeResponseSchema.parse(payload);
    const volume = response.volume ?? response.volumeStatus?.volume;
    const muted = response.muted ?? response.volumeStatus?.muteStatus;
    if (volume === undefined && muted === undefined) {
      throw new Error('Volume response has neither volume nor mute state');
    }

    return {
      ...(volume === undefined ? {} : { volume }),
      ...(muted === undefined ? {} : { muted }),
    };
  });
}

export function parseApps(payload: unknown): readonly TvApp[] {
  return parseTvResponse('apps', () => {
    const response = appResponseSchema.parse(payload);
    return response.launchPoints.map((app) =>
      tvAppSchema.parse({ id: app.id, name: app.title }),
    );
  });
}

export function parseInputs(payload: unknown): readonly TvInput[] {
  return parseTvResponse('inputs', () => {
    const response = inputResponseSchema.parse(payload);
    return response.devices.map((input) =>
      tvInputSchema.parse({
        id: input.id,
        label: input.label,
        ...(input.connected === undefined
          ? {}
          : { connected: input.connected }),
      }),
    );
  });
}

export function parseMacAddresses(payload: unknown): readonly string[] {
  return parseTvResponse('network', () => {
    const response = networkResponseSchema.parse(payload);
    const candidates = [
      response.wiredInfo?.macAddress,
      response.wifiInfo?.macAddress,
    ].filter((candidate): candidate is string => candidate !== undefined);

    return [...new Set(candidates.map(normalizeMacAddress))];
  });
}

export function parseMacAddress(value: unknown): string {
  return parseTvResponse('MAC address', () =>
    normalizeMacAddress(nonEmptyTextSchema.parse(value)),
  );
}

export function parseTransport(url: string): TvTransport {
  return parseTvResponse('transport', () => {
    const parsed = new URL(url);
    const candidate = `${parsed.protocol.slice(0, -1)}:${parsed.port}`;
    return tvTransportSchema.parse(candidate);
  });
}

function normalizeMacAddress(value: string): string {
  if (!/^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(value)) {
    throw new Error('Invalid MAC address');
  }
  const compact = value.replaceAll(':', '').replaceAll('-', '').toUpperCase();
  return compact.match(/.{2}/g)?.join(':') ?? '';
}

function parseTvResponse<T>(context: string, parse: () => T): T {
  try {
    return parse();
  } catch (cause) {
    throw new WebOsError(
      'INVALID_TV_RESPONSE',
      `Invalid webOS ${context} response`,
      { cause },
    );
  }
}
