import type { TvConnectionState } from '@remote-webos-tv/contracts';

export const connectionLabels: Record<TvConnectionState, string> = {
  unconfigured: 'Введите IP-адрес телевизора', pairing: 'Сопряжение', connecting: 'Подключение',
  available: 'Подключён', unavailable: 'Нет соединения', reconnecting: 'Подключение',
  authorization_error: 'Ошибка авторизации', compatibility_error: 'Ошибка совместимости',
};
