# План реализации: проверка протокола webOS

> **Для исполняющего агента:** перед выполнением использовать `superpowers:subagent-driven-development` либо `superpowers:executing-plans`. Отмечать выполненные пункты чекбоксами.

**Цель:** до разработки всего продукта подтвердить сопряжение, сохранение авторизации, выбор транспорта, pointer-сокет, чтение состояния, приложения, входы, выключение, определение MAC и Wake-on-LAN на LG 43UP76906LE.

**Архитектура:** небольшой TypeScript workspace с принадлежащим продукту контрактом `WebOsAdapter`, реализацией на `lgtv2@2.0.0`, зашифрованным локальным хранилищем ключа, детерминированным mock-TV и диагностической CLI. Backend и UI не зависят от `lgtv2`; по результату стенда принимается явное решение: использовать библиотеку, сопровождать узкий fork или заменить протокольную реализацию.

**Стек:** Node.js 22.12+, TypeScript, pnpm workspace, `lgtv2@2.0.0`, Zod, Vitest, Node `crypto`, Node `dgram`.

**ТЗ:** `docs/superpowers/specs/2026-09-02-remote-webos-tv-mvp-design.md`

## Общие ограничения

Этот раздел копируется без изменений в каждую задачу исполнения.

- Следовать `AGENTS.md`: сначала получать наблюдаемые доказательства, затем менять поведение; перед заявлением об успехе выполнять свежую проверку.
- Работать от корня текущего репозитория и сохранять все посторонние и неотслеживаемые файлы пользователя.
- Не сохранять и не печатать реальные IP, MAC, `client-key`, cookie, пароли, локальные абсолютные пути или сырые WebSocket-кадры с такими данными.
- В тестах использовать только синтетические адреса из `192.0.2.0/24` и MAC с префиксом `02:00:00`.
- Зафиксировать `lgtv2` строго на версии `2.0.0`; не использовать диапазон версий, плавающую Git-ветку или правку `node_modules`.
- Только пакет `packages/webos` может импортировать `lgtv2`.
- Аппаратная проверка по умолчанию выполняет только безопасные операции чтения. Выключение и Wake-on-LAN запускаются отдельно с явным подтверждением.
- Не скрывать провал отдельной возможности общим успехом и не подавлять ошибки.
- Автоматические тесты тайм-аутов используют `AbortSignal`, управляемые часы или deferred-сигналы, но не реальные задержки.
- После каждого цикла red-green-refactor выполнять узкий тест, а в конце этапа — полную проверку.

---

## Задача 1. Создать workspace для протокольной проверки

**Файлы:**

- создать `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`;
- создать конфигурацию `packages/contracts` и `packages/webos`;
- создать конфигурацию `apps/protocol-probe`.

- [x] **Шаг 1. Зафиксировать исходное состояние**

```bash
git status --short
find . -maxdepth 3 -type f -not -path './.git/*' | sort
node --version
pnpm --version
```

Ожидается: Node не ниже 22.12, pnpm доступен. При отсутствии обязательного инструмента остановиться и сообщить точную причину.

- [x] **Шаг 2. Создать корневую конфигурацию**

`package.json`:

```json
{
  "name": "remote-webos-tv",
  "private": true,
  "packageManager": "pnpm@11.15.1",
  "engines": { "node": ">=22.12.0" },
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "@types/node": "24.3.0",
    "typescript": "5.9.2",
    "vitest": "3.2.4"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - packages/*
overrides:
  postcss: 8.5.26
allowBuilds:
  esbuild: true
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": false
  }
}
```

`.gitignore`:

```gitignore
node_modules/
dist/
coverage/
.local/
*.log
```

- [x] **Шаг 3. Создать package-манифесты**

Все пакеты — ESM и имеют команды `build`, `test`, `typecheck`. В `packages/webos/package.json` зафиксировать:

```json
{
  "dependencies": {
    "@remote-webos-tv/contracts": "workspace:*",
    "lgtv2": "2.0.0",
    "zod": "4.1.5"
  }
}
```

Приложение probe зависит только от двух workspace-пакетов и Zod.

- [x] **Шаг 4. Установить и проверить зависимости**

```bash
pnpm install --frozen-lockfile=false
pnpm why lgtv2
pnpm exec tsc --version
```

Ожидается: `lgtv2@2.0.0` принадлежит только `@remote-webos-tv/webos`, TypeScript имеет версию 5.9.2.

- [x] **Шаг 5. Проверить и зафиксировать основу**

```bash
pnpm typecheck
pnpm test
git diff --check
git add package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .gitignore packages apps
git commit -m "chore: bootstrap webos protocol validation workspace"
```

Ожидается: проверки проходят, commit содержит только основу workspace.

---

## Задача 2. Определить собственные контракты adapter и ошибок

**Файлы:**

- создать `packages/contracts/src/tv.ts`;
- изменить `packages/contracts/src/index.ts`;
- создать `packages/contracts/test/tv.test.ts`;
- создать `packages/webos/src/errors.ts`, `adapter.ts`, `index.ts`;
- создать `packages/webos/test/errors.test.ts`.

- [x] **Шаг 1. Написать падающие тесты контрактов**

Проверить корректные `TvIdentity`, `TvCapabilities`, `TvSnapshot`, а также отклонение пустой модели, неизвестного транспорта и состояния, громкости вне 0–100. Безопасная сериализация не содержит IP, MAC или ключа.

```ts
export type TvConnectionState =
  | 'unconfigured' | 'pairing' | 'connecting' | 'available'
  | 'unavailable' | 'reconnecting'
  | 'authorization_error' | 'compatibility_error';

export interface TvIdentity {
  readonly model: string;
  readonly platformVersion?: string;
  readonly firmwareVersion?: string;
}

export interface TvCapabilities {
  readonly ssap: boolean;
  readonly pointer: boolean;
  readonly powerOff: boolean;
  readonly wakeOnLan: boolean;
  readonly apps: boolean;
  readonly inputs: boolean;
  readonly textInput: boolean;
  readonly notifications: boolean;
}
```

```bash
pnpm --filter @remote-webos-tv/contracts test
```

Ожидается: FAIL, схемы ещё не существуют.

- [x] **Шаг 2. Реализовать схемы и границу adapter**

```ts
export interface PairingRequest {
  readonly host: string;
  readonly clientKey?: string;
  readonly signal: AbortSignal;
}

export interface PairingResult {
  readonly clientKey: string;
  readonly identity: TvIdentity;
  readonly capabilities: TvCapabilities;
  readonly transport: 'wss:3001' | 'ws:3000';
  readonly macAddresses: readonly string[];
}

export interface WebOsAdapter {
  pair(request: PairingRequest): Promise<PairingResult>;
  readSnapshot(signal: AbortSignal): Promise<TvSnapshot>;
  openPointerSocket(signal: AbortSignal): Promise<void>;
  listApps(signal: AbortSignal): Promise<readonly TvApp[]>;
  listInputs(signal: AbortSignal): Promise<readonly TvInput[]>;
  sendButton(button: TvButton, signal: AbortSignal): Promise<void>;
  disconnect(): Promise<void>;
}
```

Стабильные коды `WebOsError`:

```ts
export type WebOsErrorCode =
  | 'NETWORK_UNREACHABLE' | 'PAIRING_REJECTED' | 'PAIRING_TIMEOUT'
  | 'AUTHORIZATION_FAILED' | 'POINTER_FORBIDDEN'
  | 'UNSUPPORTED_CAPABILITY' | 'INVALID_TV_RESPONSE'
  | 'CONNECTION_LOST' | 'KEY_STORE_CORRUPT'
  | 'KEY_STORE_WRITE_FAILED' | 'UNKNOWN';
```

Внутри ошибка сохраняет `cause`, наружу отдаёт только разрешённый объект без адресов, ключей, payload и stack trace.

- [x] **Шаг 3. Проверить и зафиксировать контракты**

```bash
pnpm --filter @remote-webos-tv/contracts test
pnpm --filter @remote-webos-tv/webos test
pnpm --filter @remote-webos-tv/contracts typecheck
pnpm --filter @remote-webos-tv/webos typecheck
git add packages/contracts packages/webos
git commit -m "feat: define replaceable webos adapter contracts"
```

Ожидается: PASS.

---

## Задача 3. Реализовать зашифрованное хранилище ключа probe

**Файлы:**

- создать `packages/webos/src/key-store.ts`;
- изменить `packages/webos/src/index.ts`;
- создать `packages/webos/test/key-store.test.ts`.

- [ ] **Шаг 1. Написать падающие тесты**

На временном каталоге и синтетическом ключе проверить:

- создание 32-байтового мастер-ключа с режимом `0600`;
- отсутствие исходного ключа в `client-key.enc`;
- сохранение и чтение;
- явную ошибку `KEY_STORE_CORRUPT` для повреждённого файла без его удаления;
- `undefined` при отсутствии файла;
- сериализацию конкурентных записей;
- атомарную замену и очистку временного файла при ошибке.

```bash
pnpm --filter @remote-webos-tv/webos test -- key-store.test.ts
```

Ожидается: FAIL.

- [ ] **Шаг 2. Реализовать хранилище**

Использовать AES-256-GCM, случайный IV длиной 12 байт и версионированный формат:

```ts
interface EncryptedEnvelopeV1 {
  readonly version: 1;
  readonly algorithm: 'aes-256-gcm';
  readonly iv: string;
  readonly ciphertext: string;
  readonly authTag: string;
}

export interface ClientKeyStore {
  load(): Promise<string | undefined>;
  save(clientKey: string): Promise<void>;
  clear(): Promise<void>;
}
```

Пустой ключ отклонять. Запись выполнять во временный соседний файл, затем `fsync` и атомарное переименование. Содержимое не журналировать.

- [ ] **Шаг 3. Проверить и зафиксировать**

```bash
pnpm --filter @remote-webos-tv/webos test -- key-store.test.ts
pnpm --filter @remote-webos-tv/webos test
pnpm --filter @remote-webos-tv/webos typecheck
git diff --check
git add packages/webos/src packages/webos/test
git commit -m "feat: persist tv client key with authenticated encryption"
```

Ожидается: PASS.

---

## Задача 4. Создать детерминированный mock webOS TV

**Файлы:**

- создать `packages/webos/test/support/mock-webos-tv.ts`;
- создать `packages/webos/test/support/fixtures.ts`;
- создать `packages/webos/test/mock-webos-tv.test.ts`.

- [ ] **Шаг 1. Написать падающие тесты жизненного цикла**

Mock должен слушать loopback на порту ОС; хранить разобранные запросы без секретных кадров; поддерживать успешную, отклонённую и отложенную регистрацию; отвечать на запросы системы, ПО, громкости, приложений, входов и сети; выдавать pointer URL или `401`; разрывать соединение до/после выбранного ответа; закрывать сокеты при teardown.

```bash
pnpm --filter @remote-webos-tv/webos test -- mock-webos-tv.test.ts
```

Ожидается: FAIL.

- [ ] **Шаг 2. Реализовать минимальный mock**

```ts
export type MockScenario =
  | { readonly kind: 'success' }
  | { readonly kind: 'reject-pairing' }
  | { readonly kind: 'deferred-pairing'; readonly gate: Promise<void> }
  | { readonly kind: 'pointer-forbidden' }
  | { readonly kind: 'close-before-response'; readonly uri: string }
  | { readonly kind: 'close-after-response'; readonly uri: string };
```

При прямом импорте `ws` добавить точную dev-зависимость той же major-версии, что у `lgtv2`. Проверять JSON-конверт, сохранять ID и отклонять неожиданные URI.

- [ ] **Шаг 3. Трижды проверить детерминизм и зафиксировать**

```bash
pnpm --filter @remote-webos-tv/webos test -- mock-webos-tv.test.ts
pnpm --filter @remote-webos-tv/webos test -- mock-webos-tv.test.ts
pnpm --filter @remote-webos-tv/webos test -- mock-webos-tv.test.ts
pnpm --filter @remote-webos-tv/webos test
git add packages/webos/package.json pnpm-lock.yaml packages/webos/test
git commit -m "test: add deterministic webos tv protocol double"
```

Ожидается: каждый запуск проходит без открытых handle.

---

## Задача 5. Реализовать adapter для `lgtv2`

**Файлы:**

- создать `packages/webos/src/lgtv2-adapter.ts`, `lgtv2-types.ts`, `response-parsers.ts`;
- изменить `packages/webos/src/index.ts`;
- создать `packages/webos/test/response-parsers.test.ts` и `lgtv2-adapter.test.ts`.

- [ ] **Шаг 1. Проверить фактический контракт зависимости**

```bash
node -p "require('./node_modules/lgtv2/package.json').version"
sed -n '1,260p' node_modules/lgtv2/index.d.ts
sed -n '1,240p' node_modules/lgtv2/README.md
```

Ожидается: ровно `2.0.0`; типы содержат `host`, `clientKey`, `saveKey`, `reconnect`, `request`, `getSocket`, `disconnect`, MAC learning, транспорт и Wake-on-LAN. Если контракт другой, сначала исправить план.

- [ ] **Шаг 2. Написать падающие тесты parser**

На фактических обезличенных формах ответов проверить identity, volume/mute, списки приложений/входов, корректные и неверные MAC, транспорт и `INVALID_TV_RESPONSE` без исходного payload.

```bash
pnpm --filter @remote-webos-tv/webos test -- response-parsers.test.ts
```

Ожидается: FAIL.

- [ ] **Шаг 3. Реализовать parser через Zod**

Неизвестные поля ТВ разрешать, но каждое выходное значение adapter валидировать строго и переводить в типы `@remote-webos-tv/contracts`.

- [ ] **Шаг 4. Написать падающие тесты adapter**

Проверить WSS-first/WS-fallback; ключ только после `registered`; передачу ключа в `ClientKeyStore.save`; reconnect без второго подтверждения; cleanup при timeout/cancel; точное преобразование ошибок; snapshot/apps/inputs; отсутствие host/MAC/key/raw frame/path в публичных ошибках; идемпотентный `disconnect()`.

- [ ] **Шаг 5. Реализовать adapter**

```ts
export interface Lgtv2AdapterOptions {
  readonly host: string;
  readonly keyStore: ClientKeyStore;
  readonly requestTimeoutMs: number;
  readonly handshakeTimeoutMs: number;
  readonly now: () => Date;
}
```

Создавать `lgtv2` только здесь. Настроить `wss:3001` → `ws:3000`, `verifyCert: 'lg'`, `reconnect: 0`, явные timeouts и собственное хранилище. Не использовать стандартные key/MAC-файлы библиотеки.

- [ ] **Шаг 6. Проверить и зафиксировать**

```bash
pnpm --filter @remote-webos-tv/webos test -- response-parsers.test.ts lgtv2-adapter.test.ts
pnpm --filter @remote-webos-tv/webos test
pnpm --filter @remote-webos-tv/webos typecheck
git diff --check
rg -n "from ['\"]lgtv2['\"]|require\(['\"]lgtv2['\"]\)" . --glob '!node_modules/**' --glob '!packages/webos/src/lgtv2-adapter.ts'
git add packages/webos
git commit -m "feat: wrap lgtv2 behind webos adapter"
```

Ожидается: тесты проходят, поиск лишних импортов пуст.

---

## Задача 6. Реализовать безопасный probe и mapping кнопок

**Файлы:**

- создать `packages/webos/src/buttons.ts`, `probe.ts`;
- изменить `packages/webos/src/index.ts`;
- создать `packages/webos/test/buttons.test.ts`, `probe.test.ts`.

- [ ] **Шаг 1. Написать падающие тесты кнопок**

Потребовать исчерпывающее преобразование навигационных, системных, цифровых, цветных, media-, volume- и channel-кнопок. Произвольные строки отклоняются. Остальные действия оформляются отдельными типизированными методами.

- [ ] **Шаг 2. Определить операции probe**

```ts
export type SafeProbeOperation =
  | 'pair' | 'reconnect' | 'identity' | 'snapshot'
  | 'pointer' | 'apps' | 'inputs' | 'macs';

export type MutatingProbeOperation =
  | 'button' | 'set-volume' | 'launch-app' | 'switch-input'
  | 'text' | 'notification' | 'power-off' | 'wake';
```

Каждая проверка имеет статус `pass`, `fail`, `unsupported` или `not-run`, длительность, безопасный код и примечание.

- [ ] **Шаг 3. Написать падающие тесты оркестрации**

Проверить только safe-операции по умолчанию; явный запуск mutating; сохранение ошибки необязательной возможности; `not-run` после провала pairing; cleanup при отмене; запрет online-операций после power-off; wake только с валидным MAC.

- [ ] **Шаг 4. Реализовать, проверить и зафиксировать**

```bash
pnpm --filter @remote-webos-tv/webos test -- buttons.test.ts probe.test.ts
pnpm --filter @remote-webos-tv/webos test
pnpm --filter @remote-webos-tv/webos typecheck
git add packages/webos
git commit -m "feat: add safe webos capability probe"
```

Ожидается: PASS.

---

## Задача 7. Создать CLI `protocol-probe`

**Файлы:**

- создать `apps/protocol-probe/src/args.ts`, `report.ts`, `main.ts`;
- создать соответствующие тесты в `apps/protocol-probe/test/`.

- [ ] **Шаг 1. Написать падающие тесты CLI**

```text
protocol-probe pair --host <host> --data-dir <directory>
protocol-probe check --host <host> --data-dir <directory>
protocol-probe command --host <host> --data-dir <directory> --operation <name>
protocol-probe report --data-dir <directory>
```

Доказать обязательность аргументов; `[redacted-host]` вместо адреса; отсутствие MAC/ключа; exit code 2 для аргументов, 1 для протокольной ошибки, 0 для полного успеха; обязательный `--confirm-device-state-change` для power-off/wake; allowlist полей отчёта.

- [ ] **Шаг 2. Реализовать CLI и корректную остановку**

Host и data-dir принимать явно. Ключ загружать только из `EncryptedFileKeyStore`. Pairing ограничить 60 секундами. `SIGINT`/`SIGTERM` отменяют работу, закрывают сокеты и возвращают ненулевой код.

- [ ] **Шаг 3. Реализовать атомарный отчёт**

```ts
export interface CompatibilityReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly library: { readonly name: 'lgtv2'; readonly version: '2.0.0' };
  readonly tv: {
    readonly model: string;
    readonly platformVersion?: string;
    readonly firmwareVersion?: string;
  };
  readonly transport?: 'wss:3001' | 'ws:3000';
  readonly checks: readonly ProbeCheck[];
  readonly decision: 'pending' | 'use-lgtv2' | 'fork-lgtv2' | 'replace-lgtv2';
}
```

Локальный JSON хранить в `.local/protocol-probe/report.json`, Markdown строить только из валидированного JSON. В Git копировать лишь вручную проверенную обезличенную версию.

- [ ] **Шаг 4. Проверить и зафиксировать CLI**

```bash
pnpm --filter @remote-webos-tv/protocol-probe test
pnpm --filter @remote-webos-tv/protocol-probe typecheck
pnpm --filter @remote-webos-tv/protocol-probe build
pnpm --filter @remote-webos-tv/protocol-probe start -- --help
git add apps/protocol-probe
git commit -m "feat: add redacted webos compatibility probe cli"
```

Ожидается: проверки проходят, help описывает четыре команды и предупреждает о mutating-операциях.

---

## Задача 8. Проверить физический LG 43UP76906LE

**Файлы:**

- после ручной проверки создать `docs/compatibility/lg-43up76906le-webos-6.5.3.md`;
- после решения изменить ТЗ и дорожную карту.

- [ ] **Шаг 1. Подготовить ТВ**

Проверить, что ТВ включён, доступен из среды probe, разрешает LG Connect Apps/Mobile TV On/Wake-on-LAN, а физический пульт доступен. Реальный IP/MAC не записывать в документацию, скриншоты и Git.

- [ ] **Шаг 2. Выполнить pairing и получить identity**

```bash
pnpm --filter @remote-webos-tv/protocol-probe start -- pair --host 192.0.2.10 --data-dir .local/protocol-probe
```

Адрес-пример заменить только при локальном запуске. В течение 60 секунд подтвердить запрос на ТВ. Вывод должен показать `registered`, транспорт, model/platform/firmware и статусы без host, MAC и ключа.

- [ ] **Шаг 3. Проверить ключ после перезапуска приложения**

Полностью остановить процесс и выполнить `check` с тем же data-dir. Ожидается подключение без повторного запроса на телевизоре.

- [ ] **Шаг 4. Проверить ключ после выключения и включения ТВ**

Обычным пультом выключить и включить телевизор, дождаться сети и повторить `check`. Ожидается подключение без нового подтверждения.

- [ ] **Шаг 5. Выполнить безопасные проверки**

Проверить identity, snapshot, pointer, apps, inputs и наличие изученного MAC. Pointer `401` фиксировать как `POINTER_FORBIDDEN`, а не как полный провал pairing.

- [ ] **Шаг 6. С разрешения пользователя проверить команды**

Отдельно проверить button, notification, power-off и wake. Для последних двух CLI требует `--confirm-device-state-change`. Параметры не зашивать в код.

- [ ] **Шаг 7. Создать и проверить локальный отчёт**

```bash
pnpm --filter @remote-webos-tv/protocol-probe start -- report --data-dir .local/protocol-probe
rg -n "client-key|192\\.|10\\.|172\\.|([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}" .local/protocol-probe/report.*
```

Ожидается: секретов и LAN-адресов нет. Перед копированием отчёт читается целиком.

- [ ] **Шаг 8. Принять решение**

- `use-lgtv2`: проходят pairing, persisted reconnect, state, apps/inputs, pointer и хотя бы одна кнопка; остальные ограничения выражаются capabilities.
- `fork-lgtv2`: SSAP работает, но узкий дефект manifest/transport/cancellation/pointer блокирует обязательную функцию.
- `replace-lgtv2`: несовместимы registration/lifecycle, нельзя безопасно перехватить хранение секрета либо требуется широкая переделка.

При провале сохранённого reconnect или cleanup запрещено выбирать `use-lgtv2`.

- [ ] **Шаг 9. Опубликовать обезличенные доказательства**

В compatibility-документ записать фактические model/platform/firmware, версию библиотеки, транспорт, таблицу операций, результат обоих restart-сценариев, решение, дату и ограничения. Затем обновить раздел 6.1 ТЗ и дорожную карту.

- [ ] **Шаг 10. Зафиксировать проверенный отчёт**

```bash
git add docs/compatibility docs/superpowers/specs docs/superpowers/plans
git commit -m "docs: record lg webos protocol compatibility decision"
```

---

## Задача 9. Завершить этап и открыть следующий план

- [ ] **Шаг 1. Выполнить свежую полную проверку**

```bash
pnpm typecheck
pnpm test
pnpm build
git diff --check
git status --short
```

- [ ] **Шаг 2. Попытаться опровергнуть безопасность**

```bash
rg -n "client-key|synthetic-client-key|192\\.0\\.2\\.10|([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}" . --glob '!node_modules/**' --glob '!pnpm-lock.yaml'
rg -n "from ['\"]lgtv2['\"]|require\(['\"]lgtv2['\"]\)" . --glob '!node_modules/**'
```

Вручную просмотреть каждое совпадение. Допустимы документация, синтетические fixtures, имена полей и единственный импорт внутри adapter.

- [ ] **Шаг 3. Просмотреть полный diff и cleanup**

Проверить закрытие сокетов и временных файлов при success, failure, timeout, signal и cancel; внутренние причины и безопасные внешние ошибки; отсутствие mutating-действий по умолчанию; соответствие отчёта свежему физическому прогону.

- [ ] **Шаг 4. Написать детальный план этапа 1**

Следующий план создаётся только после аппаратного решения. В нём фиксируется выбранная реализация adapter, а реальные ограничения стенда превращаются в capability/error-тесты. До согласования не начинать Backend API, auth, SQLite или Web UI.

## Условия завершения этапа

- Свежие typecheck, tests и build проходят.
- Зашифрованное сохранение ключа доказано автоматическими тестами.
- Pairing и reconnect проверены на реальном LG 43UP76906LE.
- Результат выключения/включения ТВ записан.
- Pointer и основные SSAP-возможности записаны отдельно.
- Обезличенный отчёт проверен на секреты.
- Принято явное решение `use-lgtv2`, `fork-lgtv2` или `replace-lgtv2`.
