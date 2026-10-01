import { tvButtonSchema, type TvButton } from '@remote-webos-tv/contracts';

import { WebOsError } from './errors.js';

const webOsButtonByPublicButton = {
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
} as const satisfies Readonly<Record<TvButton, string>>;

export function toWebOsButton(button: TvButton): string {
  const parsed = tvButtonSchema.safeParse(button);
  if (!parsed.success) {
    throw new WebOsError(
      'UNSUPPORTED_CAPABILITY',
      'Unsupported TV button received at runtime',
      { cause: parsed.error },
    );
  }
  return webOsButtonByPublicButton[parsed.data];
}
