# Cranker Keeper Ops dashboard

The dashboard is built into the keeper's Railway image and served by the same
process. It reads durable keeper events through the server-side
`/api/dashboard` endpoint. Receipt-attributed P&L, per-lane totals, batch win
rate, relay delivery, the current signer lease, and recent execution health
are derived from PostgreSQL. If telemetry is unavailable, the UI labels its
bundled design data as an illustrative layout snapshot rather than presenting
it as live or verified production state.

```bash
npm ci
npm run dev
npm run build
```

The production process listens on Railway's `PORT`. For a local production
bridge, set `DASHBOARD_PORT` before starting the keeper.
