import { describe, expect, test } from 'vitest';

import { WebOsError } from '../src/errors.js';
import {
  parseApps,
  parseIdentity,
  parseInputs,
  parseMacAddresses,
  parseTransport,
  parseVolume,
} from '../src/response-parsers.js';
import { mockResponses, mockUris } from './support/fixtures.js';

describe('webOS response parsers', () => {
  test('builds identity from system and software responses while ignoring additions', () => {
    expect(
      parseIdentity(
        {
          ...mockResponses[mockUris.systemInfo],
          futureSystemField: { nested: true },
        },
        {
          ...mockResponses[mockUris.softwareInfo],
          futureSoftwareField: 'ignored',
        },
      ),
    ).toEqual({
      model: '43UP76906LE',
      platformVersion: '6.5.3',
      firmwareVersion: '03.40.85',
    });
  });

  test('parses both legacy and nested volume responses', () => {
    expect(parseVolume(mockResponses[mockUris.volume])).toEqual({
      volume: 17,
      muted: false,
    });
    expect(
      parseVolume({
        returnValue: true,
        volumeStatus: {
          volume: 41,
          muteStatus: true,
          soundOutput: 'external_arc',
        },
      }),
    ).toEqual({ volume: 41, muted: true });
  });

  test('maps launch points to the public app contract', () => {
    expect(parseApps(mockResponses[mockUris.apps])).toEqual([
      { id: 'com.webos.app.livetv', name: 'TV' },
      { id: 'youtube.leanback.v4', name: 'YouTube' },
    ]);
  });

  test('maps external devices to the public input contract', () => {
    expect(parseInputs(mockResponses[mockUris.inputs])).toEqual([
      { id: 'HDMI_1', label: 'HDMI 1', connected: true },
      { id: 'HDMI_2', label: 'HDMI 2', connected: false },
    ]);
  });

  test('normalizes, deduplicates and omits absent MAC addresses', () => {
    expect(parseMacAddresses(mockResponses[mockUris.network])).toEqual([
      '02:00:00:00:00:01',
      '02:00:00:00:00:02',
    ]);
    expect(
      parseMacAddresses({
        wiredInfo: { macAddress: '02-00-00-00-00-01' },
        wifiInfo: { macAddress: '02:00:00:00:00:01' },
      }),
    ).toEqual(['02:00:00:00:00:01']);
    expect(parseMacAddresses({ returnValue: true })).toEqual([]);
  });

  test('maps only the two supported webOS transports', () => {
    expect(parseTransport('wss://tv.invalid:3001')).toBe('wss:3001');
    expect(parseTransport('ws://tv.invalid:3000')).toBe('ws:3000');
  });

  test.each([
    ['identity', () => parseIdentity({ modelName: '' }, {})],
    ['legacy volume', () => parseVolume({ volume: 101, muted: false })],
    [
      'nested volume',
      () => parseVolume({ volumeStatus: { volume: -1, muteStatus: false } }),
    ],
    [
      'apps',
      () =>
        parseApps({
          launchPoints: [{ id: 'synthetic-secret', title: '' }],
        }),
    ],
    ['inputs', () => parseInputs({ devices: [{ id: 'HDMI_1' }] })],
    [
      'MAC addresses',
      () => parseMacAddresses({ wiredInfo: { macAddress: 'not-a-mac' } }),
    ],
    ['transport', () => parseTransport('wss://synthetic-secret.invalid:3000')],
  ])('rejects an invalid %s response without exposing its payload', (_name, parse) => {
    let captured: unknown;
    try {
      parse();
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(WebOsError);
    expect(captured).toMatchObject({ code: 'INVALID_TV_RESPONSE' });
    const error = captured as WebOsError;
    expect(error.message).not.toContain('synthetic-secret');
    expect(JSON.stringify(error.toSafeDiagnostic())).not.toContain(
      'synthetic-secret',
    );
  });
});
