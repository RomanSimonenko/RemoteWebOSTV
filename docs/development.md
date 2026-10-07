# Разработка и запуск без Docker

Нужны Node.js 22.12+ и pnpm 11.15.1. Из корня репозитория:

```sh
pnpm install
pnpm build
export REMOTE_WEBOS_DATA_DIR="$(pwd)/.local/data"
export REMOTE_WEBOS_HOST=127.0.0.1
export REMOTE_WEBOS_PORT=8080
export REMOTE_WEBOS_PUBLIC_ORIGIN=http://127.0.0.1:8080
pnpm --filter @remote-webos-tv/api setup-token
pnpm --filter @remote-webos-tv/api start
```

Откройте адрес из `REMOTE_WEBOS_PUBLIC_ORIGIN`, введите одноразовый токен и создайте владельца. Токен действует 15 минут; новый заменяет предыдущий. После создания владельца токены больше не выдаются. Не публикуйте токен.

CLI и сервер должны использовать один абсолютный `REMOTE_WEBOS_DATA_DIR`. Каталог содержит SQLite, `auth-master.key` и `tv-master.key`: ограничьте доступ и сохраняйте весь комплект при резервном копировании. Не запускайте два сервера с одной SQLite.

## Конфигурация

Обязательные переменные показаны в примере запуска. `REMOTE_WEBOS_PUBLIC_ORIGIN` — точный origin браузера без пути и завершающего `/`; страница и API работают на одном origin.

Необязательные параметры:

- `REMOTE_WEBOS_SECURE_COOKIES` — `true` или `false`; по умолчанию `true` для HTTPS. Для HTTPS отключить Secure нельзя.
- `REMOTE_WEBOS_TRUSTED_PROXY` — IP/CIDR доверенных прокси через запятую. Без него заголовки переадресации не считаются доверенными.
- `REMOTE_WEBOS_RECOVERY_TIMEOUT_MS` — общий срок восстановления от 1000 до 300000 мс, по умолчанию 60000.

Для HTTPS настройте TLS на reverse proxy, внешний origin и только действительно доверенные адреса прокси. Без HTTPS используйте локальный или доверенный сегмент сети.

## Проверки

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm --filter @remote-webos-tv/web exec playwright install chromium
pnpm --filter @remote-webos-tv/web test:e2e
```

Сначала нужна свежая сборка: браузерные фикстуры импортируют собранные API/webOS. Для тестов нужны разрешённые локальные сокеты и Chromium. Используются временные данные и синтетический ТВ, не пользовательский аккаунт и не настоящий телевизор. Артефакты находятся в игнорируемом `.local/playwright`.

GitHub CI проверяет сборку, типы, модульные, интеграционные и браузерные сценарии. Автоматические проверки не доказывают физическую реакцию ТВ; результаты аппаратной проверки находятся в [отчёте совместимости](compatibility/lg-43up76906le-webos-6.5.3.md).
