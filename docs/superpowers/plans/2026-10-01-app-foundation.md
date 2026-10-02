# Основа приложения и безопасность — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Запустить браузерный мастер настройки владельца и вход с постоянным SQLite-хранилищем, серверными сессиями и защищённым API.

**Architecture:** Fastify владеет авторизацией и SQLite; React/Vite обращается к API того же origin. Существующий webOS Adapter остаётся отдельным модулем. Этот этап не подключает управление ТВ к HTTP: TV Service и пульт реализуются следующими планами.

**Tech Stack:** TypeScript, Node.js >=22.12.0, pnpm workspace, Fastify, React/Vite, SQLite, Zod, Vitest, Playwright. SQLite-драйвер — `better-sqlite3`; пароли — встроенный асинхронный `crypto.scrypt`. Перед добавлением зависимостей проверить поддерживаемые версии и совместимость Node по официальным источникам, зафиксировать конкретные версии в manifest/lockfile.

**Spec:** `docs/superpowers/specs/2026-09-02-remote-webos-tv-mvp-design.md`, разделы 5–7, 13–16. Аппаратное основание: `docs/compatibility/lg-43up76906le-webos-6.5.3.md`; выбран `lgtv2@2.0.0` за существующим adapter.

## Global Constraints

- Один владелец; отсутствуют публичная регистрация, роли и приглашения.
- Браузер никогда не получает client-key, master key, хеш пароля или серверный session token в JSON.
- Сессии — HttpOnly, SameSite=Strict, Path=/; Secure при явно настроенном HTTPS. Proxy доверяется только по явной конфигурации.
- Изменяющие запросы защищены CSRF; вход и setup ограничены по частоте.
- SQLite мигрирует последовательно и транзакционно; до миграций существующей базы создаётся восстановительная копия.
- Мастер-ключ хранится отдельно от SQLite с минимальными разрешениями. Существующий probe/key-store не ломать и не переносить пользовательские данные автоматически.
- Установка без владельца — unclaimed; ТВ и любые команды управления недоступны до авторизации.
- Секреты, IP/MAC и внутренние пути не попадают в обычные журналы, исходники и внешние ошибки.
- Реалистичный дизайн пульта, видео, Docker-поставка и backup UI вне этого этапа.

## Review Focus

- Две одновременные setup-попытки: ровно один владелец, токен расходуется в той же транзакции.
- Подмена Forwarded/X-Forwarded-* или Origin: не меняет доверие к proxy и не обходит CSRF.
- Сбой миграции/диска: сервер не начинает обслуживать повреждённое хранилище; предыдущие данные восстанавливаемы.
- Перезапуск и сдвиг часов: срок токенов/сессий явный; истёкшая сессия не восстанавливается.
- Ошибки и логи: пароль, cookie, setup/CSRF token, хеши и внутренние пути не раскрываются.

## Структура и общие интерфейсы

- `packages/contracts/src/auth.ts`: строгие Zod-схемы запросов и ответов; экспорт через существующий `index.ts`.
- `apps/api/src/config.ts`: `loadConfig(env): AppConfig`; dataDir, host, port, publicOrigin, secureCookies, trustedProxy задаются конфигурацией.
- `apps/api/src/storage/database.ts`, `migrations.ts`: подключение, резервная копия, транзакционные миграции; `openDatabase(config): AppDatabase`, `close()`.
- `apps/api/src/auth/{passwords,tokens,repository,service,routes}.ts`: криптография, запись данных, политика и HTTP-граница соответственно.
- `apps/api/src/app.ts`: `buildApp({config,database,clock,random}): FastifyInstance`; `index.ts` — только запуск/shutdown.
- `apps/api/src/cli.ts`: `setup-token`; CLI работает с той же базой и service, что API.
- `apps/web/src/{api,App}.tsx`, `pages/{Setup,Login,Home}.tsx`: клиент, маршрутизация состояния, формы и пустой авторизованный экран.
- Unit/integration tests рядом в `apps/api/test`, `packages/contracts/test`; браузерные — `apps/web/test/e2e`.

Clock имеет `now(): Date`; random имеет `bytes(length): Buffer`. В тестах вводятся управляемые значения, реальное ожидание не используется.

**Уточнение контракта GET (final review R2):** чтение не меняет владельца, состояние ТВ или действующую сессию и не продлевает TTL. Проверка авторизации может удалить уже истёкшую запись сессии как внутреннее обслуживание, чтобы обнаруженное истечение сохранялось при откате часов и перезапуске. Сессия, созданная в будущем относительно текущих часов, отклоняется. Это исключение относится только к обслуживанию истёкшей авторизации, включая `GET /api/auth/session`; остальные ограничения на GET сохраняются.

### Задача 1. Контракты и запускаемый API

**Files:** создать `packages/contracts/src/auth.ts`, `apps/api/package.json`, `tsconfig.json`, `src/config.ts`, `app.ts`, `index.ts`; тесты `auth.test.ts`, `config.test.ts`, `app.test.ts`.

**Interfaces:** `GET /api/setup/status` → `{state:'unclaimed'|'claimed'}`; общий error → `{code,message,requestId}`. Будущие auth routes подключаются только через `buildApp`.

- [x] Написать тесты: дополнительные поля отклоняются; отсутствующий publicOrigin/некорректный port запрещает старт; запрос с чужим Origin не получает разрешающий CORS; proxy-заголовки без configured trust игнорируются.
- [x] Запустить узкие тесты, подтвердить ожидаемое падение отсутствующих компонентов.
- [x] Создать API workspace; использовать Fastify requestId, безопасный error handler и body limit 16 KiB. Для всех API responses установить Cache-Control: no-store. Health endpoint не зависит от состояния ТВ.
- [x] Запустить package tests/typecheck и HTTP inject smoke test; закоммитить `feat: bootstrap validated application api`.

### Задача 2. SQLite и восстановимые миграции

**Files:** создать `apps/api/src/storage/database.ts`, `migrations.ts`, `test/database.test.ts`.

**Interfaces:** `AppDatabase` владеет соединением; `AuthRepository` следующей задачи использует его транзакции. Таблицы: migration_version, owner (единственная запись id=1), setup_token (одна активная запись), sessions (token_hash, owner_id, created_at, expires_at, csrf_hash).

- [x] Написать тесты новой базы, повторного открытия, rollback при injected migration failure, сохранения восстановительной копии и запрета второго owner. Ошибка миграции должна завершать старт, не скрываться.
- [x] Запустить тесты и подтвердить RED.
- [x] Реализовать миграции в транзакции; backup существующей базы делать SQLite backup API перед изменением версии. Не выполнять частичные schema upgrades. Файлы базы/копий owner-only, каталог 0700; запуск с невалидной схемой запрещён.
- [x] Проверить tests/typecheck и restart test; коммит `feat: add transactional application storage`.

### Задача 3. Пароли и установочный токен

**Files:** создать `auth/passwords.ts`, `tokens.ts`, `repository.ts`, `service.ts`, `cli.ts`, соответствующие тесты.

**Interfaces:** `issueSetupToken(): Promise<string>`; `claimOwner({token,username,password}): Promise<void>`. Repository хранит только SHA-256 токена, username и versioned password hash. Username 1–64 символа; пароль 12–128 символов, без silent trimming. Токен 32 random bytes, base64url, TTL 15 минут; новый заменяет старый, при claimed выпуск запрещён.

- [x] Написать тесты expired/replaced/missing token; два concurrent claim создают одного owner; ошибка транзакции не расходует токен; CLI не выпускает токен после claim.
- [x] Написать тесты scrypt round-trip, неверного пароля, malformed/oversized hash и уникального salt. Использовать scrypt N=32768,r=8,p=1, salt 16 bytes, key 64 bytes, maxmem 64 MiB; формат versioned, параметры проверяются до вычисления.
- [x] Подтвердить RED, реализовать async scrypt и service; токен выводит только explicit CLI stdout, ни logger, ни API выпуска его не предоставляют.
- [x] Запустить tests/typecheck, проверить базу на отсутствие plaintext secrets; коммит `feat: implement one time owner setup`.

### Задача 4. Сессии, CSRF и auth API

**Files:** создать `auth/sessions.ts`, `routes.ts`, `test/auth-routes.test.ts`; расширить `contracts/auth.ts` и `service.ts`.

**Interfaces:** `POST /api/setup` → 201 (без автоматического login), `POST /api/auth/login` → 200 с cookie, `GET /api/auth/session` → `{username,csrfToken}`, `POST /api/auth/logout` → 204; unauthenticated session → 401. Login принимает username/password; setup принимает token/username/password. Сессия — 32 random bytes, TTL 24 часа без sliding extension; в SQLite только hash. Cookie name `remote_webos_session`. CSRF token — HMAC-SHA256 от domain-separated `csrf:v1:` и raw session cookie с отдельным persistent 32-byte auth master key (owner-only, вне SQLite); hash сохраняется при создании session. GET session воспроизводит token без изменения базы; сравнение constant-time. Клиент держит token только в памяти. Auth master key не переиспользует ключ шифрования ТВ и не создаётся заново, если потерян при существующих sessions: запуск выдаёт явную storage error.

- [ ] Написать inject tests claim/login/restart/session/logout; отсутствие session → 401; отсутствие/неверный CSRF на logout → 403; logout отзывает session, а повторный logout с уже отозванной cookie → 401.
- [ ] Проверить Origin на setup/login и всех изменяющих запросах: точное совпадение publicOrigin, отсутствующий/чужой → 403. Logout дополнительно требует `X-CSRF-Token`. GET не меняет состояние.
- [ ] Подтвердить RED и реализовать routes/service. Login errors одинаковы для отсутствующего username и неверного пароля; новый login создаёт новый token, пользовательский token не принимается.
- [ ] Tests/typecheck; коммит `feat: add authenticated server sessions and csrf`.

### Задача 5. Rate limit и безопасная диагностика

**Files:** создать `apps/api/src/security/rate-limit.ts`, `logging.ts`, тесты; подключить в `app.ts`.

**Interfaces:** Встроенный Fastify logger использует единую redaction policy; rate limiter применяется до expensive hashing и setup mutation.

- [ ] Написать тесты: setup/login не более 5 попыток за 60 секунд на source IP; шестой запрос → 429 с Retry-After; другая source IP независима; trusted proxy chain обрабатывается только согласно AppConfig. Clock управляется тестом.
- [ ] Написать capture-log tests для password/token/cookie/authorization/CSRF, internal paths и nested error causes; API выдаёт safe code/message/requestId, журнал сохраняет безопасный owner code и причинную классификацию.
- [ ] Подтвердить RED; подключить поддерживаемый Fastify rate-limit plugin, ограничить память tracking, очистку поручить plugin. Не писать собственный универсальный лимитер.
- [ ] Package tests/typecheck; коммит `feat: protect auth attempts and redact diagnostics`.

### Задача 6. Браузерные setup/login

**Files:** создать `apps/web/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/api.ts`, `App.tsx`, `pages/Setup.tsx`, `Login.tsx`, `Home.tsx`, tests.

**Interfaces:** Client использует contracts Задачи 4 и `credentials:'same-origin'`; API base `/api`. В production Fastify раздаёт compiled web assets того же origin; dev Vite proxy → локальный API. CSRF хранится в памяти, cookies браузер обрабатывает сам.

- [ ] Написать component tests unclaimed→setup, claimed→login, authenticated→home, session expiry→login. Формы не помещают секреты в URL, storage или console; password inputs имеют подходящий autocomplete.
- [ ] Подтвердить RED; реализовать простые русскоязычные формы и авторизованный экран «Телевизор ещё не настроен». Не добавлять неработающие кнопки пульта. Loading/error отображаются доступным текстом, формы защищены от повторного submit.
- [ ] Добавить static serving с SPA fallback только для GET HTML навигации, `/api/*` никогда не возвращает index.html.
- [ ] Tests/typecheck/build; коммит `feat: add browser owner setup and login`.

### Задача 7. Интеграция, shutdown и приёмка

**Files:** создать `apps/web/test/e2e/auth.spec.ts`, `playwright.config.ts`, API lifecycle tests; обновить README.

**Interfaces:** CLI setup-token и HTTP process используют один dataDir; shutdown SIGINT/SIGTERM закрывает HTTP и SQLite, не теряя завершённых транзакций.

- [ ] Написать headless browser test: CLI token→setup→login→home→reload→logout; второй claim запрещён; чужой Origin/CSRF отклоняются; секреты отсутствуют в localStorage/sessionStorage.
- [ ] Написать детерминированный shutdown test и restart test существующей установки/сессии; закрытая база не используется после shutdown.
- [ ] Реализовать cleanup и документацию конфигурации, локального запуска, token CLI, HTTPS/proxy settings и срока сессии. Описать, что команды ТВ появляются на следующем этапе.
- [ ] Запустить `pnpm typecheck`, `pnpm test`, `pnpm build` и Playwright; review всего diff, checkpoint commit `test: verify application authentication lifecycle`.

## Граница завершения и самопроверка плана

Разделы 5–7 и основа хранения/миграций разделов 13–16 покрыты задачами 1–7. TV Service, discovery, пульт, зашифрованные backup/restore, Docker и release CI остаются в этапах 2–4 roadmap. Существующий файловый encrypted key store продолжает обслуживать protocol probe; SQLite-персистенция client-key требует отдельного integration-плана этапа 2, с переиспользованием криптографического owner, без автоматического переноса ключа стенда.

Приёмка этого плана: browser setup/login работают; неавторизованный клиент не читает конфигурацию и не выполняет mutation; один owner и токен consumption атомарны; sessions переживают restart до TTL; свежие unit/integration/browser tests проходят. Все пять Review Focus имеют тесты в соответствующих задачах. Этот план не утверждает готовность пульта или всего MVP.
