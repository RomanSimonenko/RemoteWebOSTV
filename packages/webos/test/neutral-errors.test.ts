import { expect, test } from 'vitest';
import * as neutral from '@remote-webos-tv/tv-adapter';
import { WebOsError, TvButtonSendError, TvPowerSendError, WebOsCleanupError } from '../src/errors.js';

test('neutral error exports preserve legacy LG constructor identity and delivery evidence', () => {
  expect(neutral).toHaveProperty('WebOsError', WebOsError);
  expect(neutral).toHaveProperty('TvButtonSendError', TvButtonSendError);
  expect(neutral).toHaveProperty('TvPowerSendError', TvPowerSendError);
  expect(neutral).toHaveProperty('WebOsCleanupError', WebOsCleanupError);
  const error = new TvButtonSendError('CONNECTION_LOST', 'not_sent', 'synthetic detail');
  expect(error).toBeInstanceOf(neutral.WebOsError);
  expect(error.delivery).toBe('not_sent');
  expect(error.toSafeDiagnostic()).toEqual({ code: 'CONNECTION_LOST', message: 'Соединение с телевизором потеряно.' });
});
