# Ручное сопряжение ТВ — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Авторизованный владелец добавляет один ТВ вручную и видит сохранённую настройку после повторного входа и перезапуска.

**Architecture:** Fastify TV Service владеет единственным adapter и жизненным циклом операций. SQLite атомарно хранит адрес, identity и зашифрованный ключ; React получает только публичную проекцию через защищённый REST. Существующие auth и CLI-контракты сохраняются.

**Tech Stack:** существующие TypeScript, Fastify, React/Vite, SQLite/better-sqlite3, Zod, Vitest, Playwright и lgtv2@2.0.0; новые зависимости не требуются.

**Spec:** `docs/superpowers/specs/2026-10-03-tv-pairing-design.md` (утверждена 2026-10-03).

## Global Constraints

- Один владелец, один ТВ; локальный буквальный IPv4 RFC1918, без hostname, URL и пользовательского порта.
- Сопряжение имеет общий бюджет 60 секунд. UI polling не чаще раза в 2 секунды, без перекрытия запросов.
- Не более 5 принятых попыток за 60 секунд на владельца; 429 с Retry-After.
- Origin/CSRF, серверные сессии, no-store и безопасные ошибки сохраняются на всех новых маршрутах.
- Ключ, шифротекст и мастер-ключ не выходят в браузер; IP/MAC и raw payload не попадают в обычные логи.
- CLI key store не мигрируется автоматически; его формат и поведение сохраняются.
- Discovery, команды пульта, WOL UI, IPv6, фоновый reconnect/backoff, WebSocket API и Docker вне этого плана.
- Время, ID, adapter и границы гонок внедряются в тестах; реальные sleeps не доказывают конкурентность.
- Выполнение с субагентами — только gpt-6.1-sol: medium для обычных задач, high для хранения, lifecycle и review.

## Review Focus

- Adapter сохранил ключ, но последующая проверка упала: постоянная настройка не создаётся (задачи 2–3).
- Отмена/тайм-аут гоняются с финальной записью: поздний результат не меняет данные; завершённая запись не удаляется (задача 3).
- Несколько вкладок, закрытие страницы и истечение auth: одна серверная операция; обновление не продлевает срок; logout прекращает UI polling (задачи 3–5).
- Замена адреса или ключа не удалась: старые данные остаются; чужой ТВ не признаётся своим только по модели (задача 3).
- Миграция, отсутствующий мастер-ключ, shutdown и ошибка cleanup не теряют владельца/сессии и не маскируют причину (задачи 2, 4, 6).

## Общие типы и интерфейсы

`packages/contracts/src/tv-setup.ts` определяет строгие Zod-схемы и readonly типы:

- `TvAction = 'pair' | 'reconnect' | 'change_address' | 'repair'`.
- `TvOperation`: `id`, `action`, `status: 'running'|'succeeded'|'failed'|'cancelled'`, `startedAt`, `deadlineAt` (epoch ms), необязательная `error: {code,message}`. Последняя операция хранится в памяти до следующей операции; после рестарта прежняя операция не восстанавливается. При сохранённом ТВ `initialize` создаёт новую ограниченную операцию reconnect.
- `SavedTvView`: `host`, `identity: TvIdentity`; никаких секретных полей.
- `TvStatusResponse`: `tv: SavedTvView|null`, `connection: TvConnectionState`, `operation: TvOperation|null`, необязательная `error: {code,message}`.
- Запрос запуска: `{action: TvAction, host?: string}`; host обязателен только для pair/change_address и запрещён для reconnect/repair. Pair допустим только без настройки, остальные действия — только с настройкой.

TV Service предоставляет `assertCanStart(input): StartTvOperation` (проверяет доступность и нормализует вход перед учётом принятой попытки), `start(input): TvOperation` (принимает, но не ждёт сетевого завершения), `status(): Promise<TvStatusResponse>`, `cancel(id): TvOperation`, `initialize(): Promise<void>`, `close(): Promise<void>`. `initialize` запускает фоновую ограниченную попытку подключения, не блокируя HTTP на ожидании выключенного ТВ.

Runtime dependencies: `repository`, `cipher`, `createAdapter(host: string, stagingKeyStore: ClientKeyStore, requestTimeoutMs: number, allowPairingPrompt: boolean): WebOsAdapter`, `now(): number`, `newId(): string`, внедряемый scheduler `{now(): number, setTimeout(callback, delay): unknown, clearTimeout(handle): void}`. Scheduler использует monotonic длительность; epoch deadline предназначен UI. Откат wall-clock не продлевает реальный 60-секундный бюджет. Сохранённый ключ проверяется с `allowPairingPrompt=false`; pair/repair разрешают новое подтверждение. Опция adapter по умолчанию остаётся true для совместимости CLI.

## Task 1: Публичные контракты и адреса

**Files:** создать `packages/contracts/src/tv-setup.ts`, `packages/contracts/test/tv-setup.test.ts`; изменить `packages/contracts/src/index.ts`.

**Interfaces:** схемы `tvOperationSchema`, `tvStatusResponseSchema`, `startTvOperationSchema`; типы выше. Существующие `TvIdentity` и `TvConnectionState` переиспользуются.

- [x] Написать тесты `valid local IPv4`, `rejects URL hostname port and non-private targets`, `rejects malformed octets and extra fields`, `action requires its own host shape`, `public response rejects secret fields`. Примеры — синтетические, не адрес стенда; проверить 10/8, 172.16/12 и 192.168/16, границы диапазонов, loopback, unspecified, multicast, 255.255.255.255 и неканонические записи.
- [x] Запустить `pnpm --filter @remote-webos-tv/contracts test`, подтвердить RED из-за отсутствующих схем.
- [x] Реализовать строгие схемы; нормализация trim допускается, hostname/DNS не используются. Не пытаться вычислять subnet-directed broadcast без известной маски интерфейса.
- [x] Повторить package tests и typecheck; подтвердить GREEN.
- [x] Коммит `feat: define protected TV setup contracts`.

Приёмка задачи 1: `1de0535`; 110 contracts tests, полный прогон 332 tests и package typecheck прошли. Независимое task review приняло spec и quality без замечаний. Схемы не являются реализацией TV Service или пульта.

## Task 2: Криптография и атомарное хранилище

**Files:** создать `packages/webos/src/key-cipher.ts`, `packages/webos/test/key-cipher.test.ts`, `apps/api/src/tv/repository.ts`, `apps/api/test/tv-storage.test.ts`; изменить `packages/webos/src/key-store.ts`, `packages/webos/src/index.ts`, `apps/api/src/storage/{migrations,database}.ts`.

**Interfaces:** `ClientKeyCipher {encrypt(key: string): EncryptedEnvelopeV1; decrypt(envelope: EncryptedEnvelopeV1): string}`; `loadClientKeyCipher({directory,hasStoredKey,randomBytes?}): Promise<ClientKeyCipher>`. Общие envelope/schema/AES-GCM функции извлекаются из существующего key-store без изменения файлового формата. `createTvRepository(sqlite): TvRepository`, где `load(): StoredTv|null`, `replace(value: StoredTv): void`, `hasStoredKey(): boolean`; `StoredTv = {host,identity,encryptedClientKey}`.

- [x] Написать regression tests неизменного файлового формата CLI и общего cipher: round-trip, разные IV, tampered tag/ciphertext, неверный ключ, пустой plaintext, отсутствующий master при шифротексте, ошибка чтения/записи и private permissions.
- [x] Написать storage tests: миграция v1→v2 сохраняет owner/sessions и создаёт backup; один `tv_config` с `id=1`; атомарная замена, injected rollback и reopen; нет plaintext ключа; malformed identity/envelope и отсутствующая таблица v2 запрещают использование схемы.
- [x] Подтвердить RED узкими tests: `pnpm --filter @remote-webos-tv/webos exec vitest run test/key-cipher.test.ts`, `pnpm --filter @remote-webos-tv/api exec vitest run test/tv-storage.test.ts`.
- [x] Реализовать cipher и repository. Миграция v2 создаёт `tv_config(id INTEGER PRIMARY KEY CHECK(id=1), host TEXT NOT NULL, identity_json TEXT NOT NULL, encrypted_client_key_json TEXT NOT NULL)`. Расширить validation v2 в database; не обходить существующий backup/transaction lifecycle. Master для веб-ТВ — `tv-master.key` в dataDir, отдельно от auth master; plaintext появляется только в памяти.
- [x] Запустить package tests/typecheck, включая существующий key-store и database suites; подтвердить GREEN и неизменность CLI формата.
- [x] Коммит `feat: persist encrypted TV configuration atomically`.

Приёмка задачи 2: `fb88cee` и совместимостное исправление `34352d9`; общий прогон 364 tests и build прошли. Независимое review и scoped re-review приняты. Однократная инициализация cipher в runtime проверяется в задаче 4; параллельные независимые серверные старты могут потребовать повторного запуска при незавершённой первой записи мастер-ключа.

## Task 3: TV Service и жизненный цикл

**Files:** создать `apps/api/src/tv/{service,operation,staging-key-store}.ts`, `apps/api/test/{tv-service,tv-lifecycle}.test.ts`; использовать mock-TV из `packages/webos/test/support/mock-webos-tv.ts` через явно тестовый import, не включать fixture в production.

**Interfaces:** service и зависимости из общего блока; `createStagingKeyStore(initialKey?: string): ClientKeyStore` хранит ключ только в памяти. Репозиторий и cipher — из задачи 2.

- [x] Написать тесты успешного pair, registered без ключа, identity/readSnapshot failure после saveKey, отказа, network loss, тайм-аута 60000 ms и отмены. Проверить, что permanent replace вызывается только после полного успеха.
- [x] Написать детерминированные barrier tests: два start→одна попытка/409; cancel до/после commit; timeout против resolve; close против resolve; поздний reject/resolve не меняет следующую операцию. ID старой операции не отменяет новую.
- [x] Написать tests reconnect/restart без PROMPT, выключенного ТВ, revoked key без автоматического нового PROMPT; repair с пустым staging key; change_address с текущим ключом, rollback при ошибке. Старый adapter после неудачной замены закрывается, старая сохранённая настройка остаётся и может быть подключена снова.
- [x] Написать status tests: safe read подтверждает available; падение меняет runtime status; concurrent status разделяют один in-flight read, не пишут SQLite и не запускают pair. Logout не отключает backend; initialize не задерживает готовность HTTP. Проверка через реальные HTTP/logout относится к задачам 4–6.
- [x] Подтвердить RED: `pnpm --filter @remote-webos-tv/api exec vitest run test/tv-service.test.ts test/tv-lifecycle.test.ts`.
- [x] Реализовать состояния, staging и сериализацию. После async encrypt/проверок повторно проверить generation и abort; синхронный SQLite replace — точка commit, между финальной проверкой и commit нет await. После commit операция succeeded; cancel завершённой операции возвращает её неизменённой. Неопределённый чужой ID даёт 404.
- [x] Полное pair/read имеет один deadline; общий AbortSignal останавливает работу при исчерпании бюджета, requestTimeoutMs adapter не превышает 60000. Перед повторным start предыдущий cleanup завершён; ошибка cleanup сохраняется как безопасная причинная классификация. `close` идемпотентен и ждёт незавершённых работ.
- [x] Запустить узкие tests/typecheck и suite mock adapter; подтвердить GREEN.
- [x] Коммит `feat: manage cancellable TV pairing lifecycle`.

Приёмка задачи 3: `aff3112`, `0d719a7`, `ea75936`; 40 service/lifecycle tests, полный прогон 405 tests и typecheck всех пяти пакетов прошли. Независимое review и два scoped re-review закрыли замечания. Ошибка/тайм-аут публикуются без ожидания зависшего cleanup, но cleanup остаётся под управлением сервиса, блокирует новую попытку и ожидается при shutdown. Ранняя отмена не оставляет старое соединение доступным. Аппаратная приёмка веб-пути не выполнена.

## Task 4: Защищённый HTTP и runtime

**Files:** создать `apps/api/src/tv/{routes,rate-limit}.ts`, `apps/api/test/{tv-routes,tv-runtime}.test.ts`; изменить `apps/api/src/{app,runtime}.ts` и API manifest только для существующей workspace-зависимости webos.

**Interfaces:** `registerTvRoutes(app,{service,beforeTvAttempt})`; `AppDependencies.tv?: TvService`. Маршруты: `GET /api/tv`→200 TvStatusResponse; `POST /api/tv/operations`→202 TvOperation; `POST /api/tv/operations/:id/cancel`→200 TvOperation. TV Service conflicts→409, invalid action for configuration→409, unknown id→404; network failure принятой async операции отображается в её status, а не меняет уже отправленный 202.

- [x] Написать inject tests auth/Origin/CSRF для каждого mutation, extra fields→400, status без session→401, no-store, encoded route aliases и safe requestId errors. JSON и capture logs не содержат ключей/raw ошибок/IP.
- [x] Написать limiter tests 5 accepted attempts/60000 ms на единственного owner; шестая→429 с Retry-After; другой source IP не обходит owner limit. Использовать существующий @fastify/rate-limit с owner key и внедряемым clock; conflict/invalid request не расходует accepted budget. Cancel не блокируется лимитом запуска. Если plugin не поддерживает нужную точку учёта, остановиться и согласовать контракт, не вводить скрытый другой подсчёт.
- [x] Написать runtime tests startup migration/cipher failure, init выключенного ТВ, shutdown pending pair, сохранённая настройка после restart, cleanup failure: SQLite закрывается только после TV Service, все причины безопасно наблюдаемы.
- [x] Подтвердить RED соответствующими API tests.
- [x] Подключить routes после общих auth hooks, production factory Lgtv2Adapter со staging. Регистрировать единый onClose: сначала service.close, затем database.close; попытаться закрыть оба ресурса и сохранить обе причины при двойной ошибке. Ошибки init чистят частично созданные ресурсы.
- [x] Запустить все API tests/typecheck и `pnpm build`; подтвердить GREEN.
- [x] Коммит `feat: expose protected TV pairing API`.

Приёмка задачи 4: `b415cf5`; 12 новых API tests, полный прогон 417 tests, build/typecheck прошли. Независимое task review принято.

## Task 5: Веб-путь и повторный вход

**Files:** создать `apps/web/src/pages/TvSetup.tsx`, `apps/web/src/useTvStatus.ts`, `apps/web/src/pages/TvSetup.test.tsx`, `apps/web/src/useTvStatus.test.tsx`; изменить `apps/web/src/api.ts`, `apps/web/src/App.tsx`, `apps/web/src/pages/Home.tsx`, `apps/web/src/App.test.tsx`.

**Interfaces:** api методы `tvStatus(signal?: AbortSignal)`, `startTvOperation(input,csrfToken)`, `cancelTvOperation(id,csrfToken)` со схемами задачи 1. `TvSetup({csrfToken,onSessionExpired})`; hook `useTvStatus` владеет polling и abort, возвращает status/loading/error/refresh. Auth App остаётся владельцем logout и обработки 401.

- [x] Написать component tests формы IPv4, blocked double submit, running operation/deadline, cancel и specific failures; saved identity/IP при unavailable; repair/change_address/reconnect как действия без второго ТВ. Секреты не попадают в URL, storage, console.
- [x] Написать fake-time tests polling минимум 2000 ms без overlap, unmount/logout abort, 401→login, late response после logout игнорируется, error остаётся видимым и не подменяется прежним available. Обновление страницы восстанавливает серверную операцию и deadline.
- [x] Подтвердить RED: `pnpm --filter @remote-webos-tv/web test`.
- [x] Реализовать русские формы и статусы из spec; модель и адрес показывать только после session. Таймер — представление server deadline, не клиентский запуск нового TTL. Выйти можно во время pair; это прекращает UI запросы, не server operation.
- [x] Запустить web tests/typecheck/build; подтвердить GREEN и сохранность auth tests.
- [x] Коммит `feat: add persistent TV setup browser flow`.

Приёмка задачи 5: `1fb92a7`, `67e3b00`; 36 web tests, полный прогон 443 tests, build/typecheck прошли. Независимое review и scoped re-review приняты. Свежий GET после ответа mutation имеет приоритет даже при новой операции из другой вкладки; порядок определяется локальными версиями запросов, а не ID или wall-clock.

## Task 6: Приёмка и документация

**Files:** создать `apps/web/test/e2e/tv-pairing.spec.ts`, `apps/web/test/support/tv-fixture.ts`; изменить `README.md`, этот план и `docs/compatibility/lg-43up76906le-webos-6.5.3.md` только по новым аппаратным доказательствам.

**Interfaces:** test fixture запускает production build/API с synthetic dataDir и mock-TV; fixture adapter инъецируется программно, без публичного env-переключателя обхода безопасности. Startup errors выводят только безопасную классификацию. Restart сохраняет тот же test dataDir.

- [x] Написать Chromium E2E: setup/login→pair через mock prompt gate→saved TV→reload→logout/login→тот же ТВ; reload during pair не продлевает deadline; отказ/отмена; API restart; mock недоступен; change address failure и revoked key. Проверить отсутствие secret fields и browser storage secrets.
- [x] Подтвердить RED, затем собрать fixture и проверить GREEN: `pnpm build`, `pnpm --filter @remote-webos-tv/web test:e2e`.
- [x] Выполнить свежие `pnpm test`, `pnpm typecheck`, `pnpm build`, Chromium E2E, `git diff --check`. Для socket tests разрешить loopback в среде; EPERM песочницы не объявлять дефектом продукта и не маскировать skip.
- [ ] С согласия владельца прогнать на реальном ТВ: PROMPT, модель в UI, повторный вход и restart без нового PROMPT, выключенный ТВ остаётся настроенным. Без аппаратного прогона зафиксировать «автоматически проверено, аппаратная приёмка не завершена».
- [ ] Независимое review на Sol 6.1 high: безопасность, persistence, cancel/commit races, resource cleanup, реальные API/CLI contracts. Исправления проходят regression tests и повторный review.
- [x] Обновить README: сохранённый ТВ, диапазоны адресов, reconnect ограничения, постоянный dataDir и ограничения проверки. Коммит `test: verify persistent TV pairing lifecycle`; checkpoint перед исчерпанием лимита, без ложного закрытия незавершённых пунктов.

Автоматическая приёмка задачи 6: 447 unit/component/integration tests, typecheck и build всех пакетов; 8 Chromium E2E (7 новых TV-сценариев и сохранённый auth CLI-сценарий), `git diff --check` прошли. RED диагностики: четыре typed startup-кода терялись как `unavailable`; GREEN — 40 web tests. Mutation RED двух вкладок: временное прежнее сопоставление по ID оставляло «Отменить» видимой после завершения другой операции; возврат текущего правила восстановил GREEN. Fixture использует собранный API, SQLite/cipher/auth и настоящий Lgtv2Adapter с existing mock-TV; приватный адрес сопоставляется с динамическим loopback-портом только в тесте. API повторно открывается с тем же dataDir; это не аппаратное доказательство перезапуска процесса на реальном ТВ. Новых аппаратных доказательств нет, compatibility report не изменён. Автоматически проверено, аппаратная приёмка не завершена; финальное независимое review ожидается.

## Самопроверка и передача

Задачи 1–5 выполнены и прошли независимые task reviews. Публичные типы определены один раз; ключи не входят в status. Задача 6: автоматическая часть проверена с собранным API и протокольным mock-TV; аппаратная приёмка и финальное независимое review остаются открытыми.

Следующие шаги — аппаратная приёмка с согласия владельца и финальное независимое review на Sol 6.1 high. Автоматические результаты не закрывают аппаратный пункт. Команды пульта и фоновый reconnect остаются за рамками этого этапа.
