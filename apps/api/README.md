# API configuration

Set these environment variables before starting `@remote-webos-tv/api`:

- `REMOTE_WEBOS_DATA_DIR`: absolute path to the persistent data directory.
- `REMOTE_WEBOS_HOST`: explicit interface address or hostname to bind.
- `REMOTE_WEBOS_PORT`: integer TCP port from 1 to 65535.
- `REMOTE_WEBOS_PUBLIC_ORIGIN`: exact browser origin, for example `https://remote.example.test` (no trailing slash, credentials, path, query or fragment).
- `REMOTE_WEBOS_SECURE_COOKIES`: optional `true` or `false`; defaults to `true` for HTTPS origins.
- `REMOTE_WEBOS_TRUSTED_PROXY`: optional comma-separated proxy IP addresses or CIDR ranges; absent means no forwarded headers are trusted.

The API currently exposes `GET /api/setup/status` and `GET /api/health`. Owner persistence is added by the auth task; this bootstrap starts unclaimed until that provider is wired in.
