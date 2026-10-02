# API configuration

Set these environment variables before starting `@remote-webos-tv/api`:

- `REMOTE_WEBOS_DATA_DIR`: absolute path to the persistent data directory.
- `REMOTE_WEBOS_HOST`: explicit interface address or hostname to bind.
- `REMOTE_WEBOS_PORT`: integer TCP port from 1 to 65535.
- `REMOTE_WEBOS_PUBLIC_ORIGIN`: exact browser origin, for example `https://remote.example.test` (no trailing slash, credentials, path, query or fragment).
- `REMOTE_WEBOS_SECURE_COOKIES`: optional `true` or `false`; defaults to `true` for HTTPS origins.
- `REMOTE_WEBOS_TRUSTED_PROXY`: optional comma-separated proxy IP addresses or CIDR ranges; absent means no forwarded headers are trusted.

The API exposes `GET /api/setup/status` and `GET /api/health`. Setup status reads the owner from the configured SQLite data directory.

To issue a one-time owner setup token, set only `REMOTE_WEBOS_DATA_DIR` to the same absolute persistent directory used by the API, then run:

```sh
pnpm --filter @remote-webos-tv/api build
pnpm --filter @remote-webos-tv/api setup-token
```

The second command prints the token to its terminal once. Issuing another token invalidates the first; tokens expire after 15 minutes. Once an owner is configured, the command refuses to issue another token. The setup HTTP endpoint and browser form are available now. See the root README for the complete local workflow, HTTPS proxy settings, and session lifetime.
