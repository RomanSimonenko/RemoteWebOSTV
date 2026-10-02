# Browser development

Start the API separately, then set `REMOTE_WEBOS_DEV_API_ORIGIN` to its HTTP
origin and run `pnpm --filter @remote-webos-tv/web dev`. Set
`REMOTE_WEBOS_PUBLIC_ORIGIN` for the API process to the exact origin shown by
Vite in the browser (including the scheme, host and port). Setup and login POST
requests carry that browser Origin through the Vite `/api` proxy. Vite uses its
standard local address and fails if its chosen port is occupied.

Production `pnpm build` builds this package before the API. The API serves
`apps/web/dist` from its own origin; the development proxy is not used there.
