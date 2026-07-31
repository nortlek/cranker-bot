# Cranker Keeper Ops dashboard

The dashboard is built into the keeper's Railway image and served by the same
process. It reads durable keeper events through the server-side
`/api/dashboard` endpoint and retains a verified static snapshot while
telemetry is unavailable.

```bash
npm ci
npm run dev
npm run build
```

The production process listens on Railway's `PORT`. For a local production
bridge, set `DASHBOARD_PORT` before starting the keeper.
