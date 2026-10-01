import { tvButtonSchema, type TvButton } from '@remote-webos-tv/contracts';
import { describe, expect, test } from 'vitest';

import { toWebOsButton } from '../src/buttons.js';

const expectedMapping: Readonly<Record<TvButton, string>> = {
  UP: 'UP',
  DOWN: 'DOWN',
  LEFT: 'LEFT',
  RIGHT: 'RIGHT',
  ENTER: 'ENTER',
  HOME: 'HOME',
  BACK: 'BACK',
  EXIT: 'EXIT',
  MENU: 'MENU',
  VOLUME_UP: 'VOLUMEUP',
  VOLUME_DOWN: 'VOLUMEDOWN',
  MUTE: 'MUTE',
  CHANNEL_UP: 'CHANNELUP',
  CHANNEL_DOWN: 'CHANNELDOWN',
  '0': '0',
  '1': '1',
  '2': '2',
  '3': '3',
  '4': '4',
  '5': '5',
  '6': '6',
  '7': '7',
  '8': '8',
  '9': '9',
  RED: 'RED',
  GREEN: 'GREEN',
  YELLOW: 'YELLOW',
  BLUE: 'BLUE',
  PLAY: 'PLAY',
  PAUSE: 'PAUSE',
  STOP: 'STOP',
  REWIND: 'REWIND',
  FAST_FORWARD: 'FASTFORWARD',
};

describe('toWebOsButton', () => {
  test('maps every public button to the exact webOS pointer name', () => {
    expect(Object.keys(expectedMapping).sort()).toEqual(
      [...tvButtonSchema.options].sort(),
    );
    for (const button of tvButtonSchema.options) {
      expect(toWebOsButton(button)).toBe(expectedMapping[button]);
    }
  });

  test('rejects arbitrary runtime strings', () => {
    expect(() => toWebOsButton('POWER' as TvButton)).toThrowError(
      /unsupported tv button/i,
    );
  });
});
