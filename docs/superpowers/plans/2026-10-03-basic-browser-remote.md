# Базовый пульт в браузере — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Управлять сохранённым ТВ десятью кнопками из браузера, без автоматического повтора и ложного подтверждения результата.
**Architecture:** Общие строгие схемы → защищённый REST → существующий TV Service → текущий WebOsAdapter. TV Service владеет допуском команды и lifecycle, adapter знает стадию отправки, UI отвечает за одно нажатие и безопасную обработку позднего ответа.
**Tech Stack:** TypeScript, Zod, Fastify, React/Vite, Vitest, Playwright, существующий lgtv2.
**Spec:** `docs/superpowers/specs/2026-10-03-basic-browser-remote-design.md` (подтверждена владельцем 2026-10-03).

## Контрольная точка 2026-10-04

План подтверждён владельцем. Задачи 1–4 реализованы в ветке `codex/basic-browser-remote` и приняты независимыми task reviews. Коммиты: `332a747` (контракты), `a45f1bf` + `8c6bd10` (выполнение и исправление владения незавершённым pointer-соединением), `b3b347a` (API), `9e5185c` + `8dff5e3` (UI и исправление классификации повреждённых ответов), `98e0f1d` (имя статуса соединения и точные селекторы прежних Chromium-тестов). Полный прогон контроллера на `8dff5e3`: 633 теста, typecheck и build прошли. Прежние восемь Chromium-сценариев прошли на `98e0f1d`; они не заменяют новые сквозные сценарии пульта.

Автоматическая часть Task 5 реализована: пять новых Chromium-сценариев проверяют полный путь десяти кнопок, сохранённый ТВ, нативную клавиатуру, защиту API, offline и отсутствие повтора после потери ответа/reconnect. Финальное review всей ветки выполнено; scoped review его исправлений и согласованная ручная приёмка эффекта кнопок на ТВ ещё ожидаются. Владелец подтвердил возможность будущего сеанса, но включение ТВ и безопасный экран ещё не согласованы. Шаг не объявлен полностью готовым, ветка не слита. Постоянные локальные данные сохраняются. Запущенный до начала работы API ещё не переключён на новую версию.

В общем прогоне исправления Task 2 однажды упал существующий веб-тест истёкшей сессии (не найден alert); отдельный запуск и один повтор полного прогона прошли. Этот факт сохранён, unrelated patch не делался. При повторном проявлении требуется диагностика, не цикл повторов.

**Диагностика CLI — 2026-10-04:** два прежних общих прогона на `98e0f1d` дали 632/633 PASS: `apps/protocol-probe/test/entrypoint.test.ts` превысил 15-секундный бюджет; изолированный прогон прошёл за 8,8 секунды. Контролируемое перекрытие с API-тестами замедлило сборку CLI до 6353 мс против 2240 мс без перекрытия, но исторический порог 15 секунд не воспроизвело. Установлена граница: старый тест включал подготовку CLI, две сборки зависимостей и pnpm lifecycle в бюджет проверки entrypoint. Коммит `2a7338e` переносит свежую сборку CLI и зависимостей в canonical `pretest`, затем проверяет реальный Node entrypoint с ограничением дочернего процесса 10 секунд. Исходные help-assertions и 15-секундный бюджет теста сохранены. Прямой Vitest требует предварительно подготовленного текущего dist. Независимое review этого изменения принято; свежий общий прогон на `2a7338e` дал 633/633 PASS. Это не заявление о детерминированном воспроизведении исторического тайм-аута.

На Task 5 свежий `pnpm test` дал 633/633 PASS в 42 файлах; `pnpm typecheck` и `pnpm build` завершились с exit 0. Пять новых сценариев пульта прошли 5/5 (26,4 секунды), затем после свежей сборки полный `env -u NO_COLOR pnpm --filter @remote-webos-tv/web test:e2e` прошёл 13/13 (54,9 секунды). `git diff --check` завершился с exit 0. Отрицательный контроль с неверным ожидаемым wire-именем для «Вверх» завершился ожидаемым FAIL (`DOWN` вместо фактического `UP`); корректное ожидание восстановлено. Production-поведение и существующие fixture не менялись.

Потеря результата проверяется на границе HTTP: реальный POST проходит auth/API/SQLite/adapter, mock получает pointer-кадр, настоящий ответ удерживается gate и прерывается. Поддельного ответа API нет. Pointer send синхронный, ACK эффекта отсутствует: закрытие mock после получения кадра не может детерминированно превратить уже завершённый sent в adapter unknown. Классификация adapter not_sent/unknown отдельно покрыта интеграционными тестами; сквозной тест доказывает UI uncertainty и отсутствие replay после reconnect.

**Исправления финального review — 2026-10-04:** UUID v4 формируется через `crypto.getRandomValues`, доступный и на разрешённом HTTP LAN origin без `randomUUID`. Доказанный локальный отказ генератора до API показывает not-sent с нулём POST. Три новые детерминированные web-регрессии сначала дали 3 FAIL, затем 59/59 Remote tests PASS. Свежий единственный общий прогон дал 636/636 PASS в 42 файлах; typecheck, build и diff-check — exit 0; Chromium после сборки — 16/16 (55,4 секунды). Прежние 13 E2E сохранены; три новые синтетические browser-preparation проверки secure/insecure context и отказа entropy не подменяют полный путь. Исходное HTTP-воспроизведение на старой сборке дало 0 POST и ложный unknown; на исправленной — 1 POST и корректный unknown после намеренного abort ответа. Уточнён описанный ниже BUSY-first приоритет; production admission не изменён.

## Global Constraints

- Только UP/DOWN/LEFT/RIGHT/ENTER/BACK/HOME/VOLUME_UP/VOLUME_DOWN/MUTE; остальные значения существующего TvButton остаются для CLI, но не принимаются новым API.
- Общий монотонный бюджет команды 5 секунд; десять принятых команд в секунду на владельца.
- Одна исполняемая команда на ТВ, без очереди; lifecycle и команда взаимно исключены. Нет автоматического reconnect ради отправки.
- Нет удержания, WebSocket API, WOL, discovery или новых зависимостей/миграций.
- «Команда отправлена» не означает эффект на экране. После возможной отправки ошибка может означать неизвестный результат.
- Session/Origin/CSRF/no-store сохраняются; ключи, адрес стенда и credentials не попадают в публичные результаты.
- Идентификатор коррелирует запрос/ответ; exactly-once и автоматическая идемпотентность произвольных повторных запросов не обещаются.

## Review Focus

- Смена поколения соединения во время открытия pointer: старый запрос не отправляется на новый adapter (Task 2).
- Cancel/logout/timeout после возможной отправки: нет ложного «не отправлено» или автоматического повтора (Tasks 2, 4).
- Нативная активация кнопки плюс обработчик Enter: одно нажатие даёт ровно один запрос (Task 4).
- Конкурирующие вкладки и lifecycle: второй запрос явно отвергается, не выполняется позднее (Tasks 2, 3).
- Rate-limit и ошибочные запросы: отклонённые запросы не исполняются и не расходуют лимит принятых команд (Task 3).

## Файлы и решения интерфейса

Новые файлы: `packages/contracts/src/tv-command.ts`, `packages/contracts/test/tv-command.test.ts`, `apps/api/src/tv/commands.ts`, `apps/api/test/tv-commands.test.ts`, `apps/api/test/tv-command-routes.test.ts`, `apps/web/src/pages/Remote.tsx`, `apps/web/src/pages/Remote.test.tsx`, `apps/web/test/e2e/tv-remote.spec.ts`.

Изменяемые владельцы: contracts `src/index.ts`; webos `src/errors.ts`, `src/lgtv2-adapter.ts` и их тесты; API `src/tv/service.ts`, `src/tv/routes.ts`, `src/tv/rate-limit.ts`, `src/app.ts`, `src/runtime.ts`, lifecycle/runtime тесты и `test/support/tv-harness.ts`; web `src/api.ts`, `src/pages/Home.tsx`, `src/pages/TvSetup.tsx`, `src/style.css` и существующие тесты. Fixture: `apps/web/test/support/tv-fixture.ts` и `packages/webos/test/support/mock-webos-tv.ts` только если текущего управления mock недостаточно.

Новый защищённый `GET /api/tv/remote` отдаёт строгий `TvRemoteState`: `{ enabled: boolean, reason: 'UNAVAILABLE' | 'BUSY' | 'UNSUPPORTED' | null }`. Существующий GET /api/tv не меняется. `enabled` true только при available, pointer и свободном допуске; reason null только тогда. Приоритет отказов: busy → unavailable → unsupported. Владение незавершённой операцией, очисткой, командой или status probe даёт BUSY, в том числе во время reconnect при недоступном соединении.

`POST /api/tv/commands` принимает строгий `{ id: string, button: BasicTvButton }`; id — UUID v4, формируемый единственным browser-владельцем через криптографический `crypto.getRandomValues` на HTTPS и разрешённом HTTP LAN origin. Отказ локальной подготовки идентификатора до вызова API означает «Команда не отправлена», без POST; после dispatch сохраняется строгая классификация результата. Ответ после валидации команды содержит `{ id, outcome: 'sent' | 'rejected' | 'unknown', error?: { code, message } }`. Для sent error отсутствует, для rejected/unknown обязательна. Нет произвольных SSAP URI, параметров или private diagnostics.

## Task 1: Общие контракты команд

**Files:** новые contracts-файлы и `packages/contracts/src/index.ts`.
**Interfaces:** экспортировать `basicTvButtonSchema`, `tvCommandRequestSchema`, `tvCommandResultSchema`, `tvRemoteStateSchema` и соответствующие `BasicTvButton`, `TvCommandRequest`, `TvCommandResult`, `TvRemoteState`.

- [ ] Написать failing table-tests: все десять значений принимаются; EXIT/цифры/неизвестное значение отвергаются; UUID обязателен; лишние поля запрещены; sent с error и rejected без error отвергаются; enabled/reason согласованы.
- [ ] Выполнить `pnpm --filter @remote-webos-tv/contracts exec vitest run test/tv-command.test.ts`; подтвердить FAIL из-за отсутствующих экспортов/схем.
- [ ] Реализовать строгие Zod-схемы и discriminated union результата. Коды: TV_UNAVAILABLE, TV_BUSY, UNSUPPORTED_CAPABILITY, COMMAND_NOT_SENT, COMMAND_RESULT_UNKNOWN, RATE_LIMITED; HTTP/auth BAD_REQUEST/FORBIDDEN/UNAUTHORIZED остаются существующими контрактами.
- [ ] Повторить узкие тесты и package typecheck; ожидается PASS. Commit `feat: define basic remote command contracts`.

## Task 2: Стадия отправки и единый допуск TV Service

**Files:** webos errors/adapter/tests; API service, новый commands-модуль и test/tv-commands.test.ts, lifecycle/support tests.
**Interfaces:** сохранить `WebOsAdapter.sendButton(button: TvButton, signal: AbortSignal): Promise<void>`; добавить `TvButtonSendError extends WebOsError` с readonly `delivery: 'not_sent' | 'unknown'` и ErrorOptions cause. TV Service экспортирует `remoteState(): TvRemoteState`, `sendCommand(input: TvCommandRequest, signal: AbortSignal): Promise<TvCommandResult>`.

- [ ] Написать failing tests с deferred promises/fake scheduler: отказ offline и unsupported не вызывает sendButton; повторный конкурентный вызов busy; command↔pair/reconnect взаимоисключены; timeout ровно 5000ms; close/abort до отправки не отправляет; поздний pointer/new generation не отправляет; неоднозначная ошибка после send даёт unknown, без повтора.
- [ ] Выполнить `pnpm --filter @remote-webos-tv/api exec vitest run test/tv-commands.test.ts test/tv-lifecycle.test.ts` и webos adapter tests; подтвердить требуемый FAIL.
- [ ] В adapter проверить signal непосредственно перед pointer send. Ошибки подготовки маркировать not_sent; начиная с вызова send — консервативно unknown. Если promise не успел завершиться и отмена гоняется с send, не утверждать not_sent без доказательства. Сохранить CLI safe error/exit semantics и причинный контекст.
- [ ] В commands-модуле реализовать `executeTvCommand(input: TvCommandRequest, adapter: WebOsAdapter, signal: AbortSignal): Promise<TvCommandResult>` как нормализацию результата; в service держать единственный synchronous admission, controller, generation и monotonic timer. Установить допуск до любого await. Освобождать только после завершения owned работы; close ждёт cleanup. Не внедрять второй adapter и отдельный Connection Manager.
- [ ] Remote capability брать из актуального snapshot того же поколения; подготовку статуса не смешивать с отправкой. Не считать неизвестное/отсутствующее pointer разрешением. Unsupported pointer не обнуляет SSAP. Определить актуальность snapshot при lifecycle переходах в service tests.
- [ ] Повторить узкие tests, webos/API tests и typecheck; ожидается PASS, CLI regressions не изменены. Commit `feat: execute remote commands with lifecycle admission`.

## Task 3: Защищённые маршруты и лимит

**Files:** API routes/rate-limit/app/runtime, новый command-routes test, runtime/support tests.
**Interfaces:** GET remote и POST commands по контрактам выше. До исполнения сервис предоставляет synchronous `assertCanSendCommand(input: TvCommandRequest): TvCommandRequest`; сам sendCommand повторяет допуск после await границ. Лимит использует существующий plugin/store и принятую схему peek/charge, отдельный bucket от pairing.

- [ ] Написать failing inject-tests: без session 401; неверный Origin/CSRF 403; malformed 400; no-store на всех ответах; 10 последовательных принятых за 1000ms, 11-я 429 и Retry-After; rejected malformed/offline/busy не расходуют принятый лимит. Управлять временем существующими seams.
- [ ] Выполнить `pnpm --filter @remote-webos-tv/api exec vitest run test/tv-command-routes.test.ts`; подтвердить FAIL.
- [ ] Добавить маршруты с существующей auth policy. Короткая admission-секция сериализует проверку/peek/запуск/charge, но не очередь команд: после запуска выполнение не держит HTTP admission до конца, конкурентный запрос видит TV_BUSY.
- [ ] Ответы: sent 200, rejected offline/busy 409, unsupported 422, COMMAND_NOT_SENT 503, unknown 504, RATE_LIMITED 429. Для принятого корректного запроса ошибки включают исходный id; ошибки schema/auth сохраняют прежний envelope с requestId. GET remote 200. Общий request abort не маскирует неизвестную доставку.
- [ ] Добавить wiring runtime и явный abort от отзыва сессии/logout для owned команд этой сессии; проверить фактический путь logout→service, не только browser abort. Отзыв других сессий не отменяет чужой запрос. Shutdown также отменяет и дожидается работы.
- [ ] Узкие и все API tests/typecheck PASS. Commit `feat: expose protected basic remote API`.

## Task 4: Пульт, клавиатура и безопасные поздние ответы

**Files:** web API/Home/TvSetup/style, новый Remote component/test, существующие App и status tests при изменении wiring.
**Interfaces:** `api.remoteState(signal?: AbortSignal): Promise<TvRemoteState>`; `api.sendCommand(input: TvCommandRequest, csrfToken: string, signal?: AbortSignal): Promise<TvCommandResult>`; `Remote({ csrfToken, active, onSessionExpired }: { csrfToken: string; active: boolean; onSessionExpired: () => void })`.

- [ ] Написать failing RTL tests: все кнопки и mapping; pending блокирует повторный клик; Enter на кнопке ровно один request; focused remote стрелки/Enter/Escape/Home/+/-/M работают; repeat/modifiers/input/outside-focus игнорируются; sent/rejected/unknown имеют разные сообщения; transport loss unknown; 401 зовёт session-expired; logout/unmount и поздний ответ не меняют новую сессию.
- [ ] Выполнить `pnpm --filter @remote-webos-tv/web exec vitest run src/pages/Remote.test.tsx`; подтвердить FAIL.
- [ ] Реализовать компонент в Home рядом с сохранённым ТВ. Нативные button activation и keyboard mapping имеют одного владельца. Результат доступен через role=status/alert, reason доступен рядом с отключённым блоком. Точный текст sent/unknown взять из спеки.
- [ ] GET remote polling не чаще 2s, без перекрытия, остановка inactive/unmount, refresh после команд. Переиспользовать установленный hook pattern, не менять polling сопряжения без необходимости. 401 → login. Потеря HTTP-ответа после POST → unknown, без retry; abort при уходе из сессии → ignore late result.
- [ ] Web tests/typecheck/build PASS. Commit `feat: add basic browser remote controls`.

## Task 5: Сквозная проверка и аппаратная приёмка

**Files:** новый web/test/e2e/tv-remote.spec.ts, mock/fixture при необходимости; README, compatibility report, roadmap и этот план.
**Interfaces:** реальный built API/static UI/auth/SQLite/adapter против mock TV; никаких production mock-bypass env flags.

- [x] Написать failing Chromium сценарии: авторизованный сохранённый ТВ; каждое нажатие идёт до pointer mock ровно один раз с правильным именем; reload/login сохраняет доступ; keyboard не дублируется; offline и разрыв после send дают нужный UI без поздней отправки после reconnect. Инъекция разрывов через mock barriers, без sleep.
- [x] Выполнить `pnpm --filter @remote-webos-tv/web test:e2e`; подтвердить FAIL до реализации нужного fixture/flow, если предыдущие задачи ещё не покрывают путь. Не искусственно ломать готовую реализацию ради red: если сценарий сразу проходит, записать этот факт и отдельно проверить отрицательный контроль.
- [x] Реализовать только недостающие test fixture возможности. Завершить full-path security/cleanup проверки, освободить серверы/порты на failure/cancel. Fixture private values синтетические. Существующего fixture достаточно; teardown через finally сохранён и исполнялся на отрицательном контроле.
- [ ] Выполнить `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm --filter @remote-webos-tv/web test:e2e`, `git diff --check`; записать свежие результаты. Получить независимое review всей ветки, устранить блокирующие замечания и повторить затронутые проверки. Автоматическая часть и исправления выполнены; scoped review исправлений финального review остаётся открытым.
- [ ] Согласовать с владельцем включение ТВ и безопасный экран для проверки навигации. Проверить наблюдаемый эффект каждой из десяти кнопок; громкость менять небольшими шагами, mute вернуть в исходное состояние. Не исполнять реальные команды без согласованного ручного сеанса. Автотест не заменяет подтверждение эффекта владельцем.
- [x] Обновить compatibility/README/roadmap, разграничив mock и manual evidence, без IP/MAC/account/screenshots с частными данными. Непроверенные команды отметить; не объявлять аппаратную приёмку полной. Commit `test: verify browser remote command flow` (документировать ручную приёмку отдельным коммитом после её завершения).

## Исполнение и контрольные точки

Зависимости: Task 1 → Task 2 → Task 3 → Task 4 → Task 5. Сохраняем выбранный пользователем способ работы с субагентами Sol 6.1: свежий implementer и независимый reviewer по задаче, финальное whole-branch review. До старта владелец подтверждает этот план. На каждой контрольной точке — scoped commit, результаты проверок; перед исчерпанием лимита остановка на сохранённой точке. Внешний PR/push — в согласованном GitHub workflow; merge только по отдельному разрешению. Работающее приложение и постоянные данные не удалять.
