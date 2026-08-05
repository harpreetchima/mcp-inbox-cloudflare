# Operations

## Health and logs

The public health check returns service identity but no mailbox data:

```bash
curl --fail https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/health
```

Stream structured Worker logs during diagnosis:

```bash
npx wrangler tail agents-mail
```

Expected event names include `email_accepted`, `ingest_failed`, `invalid_ingest_job`, `email_ingress_failed`, and `mcp_error`. Logs intentionally omit email bodies and bearer tokens.

## Inspect normalized state

Use D1 only for operational inspection; agents should use MCP:

```bash
npx wrangler d1 execute DB --remote --command \
  "SELECT id, subject, status, claimed_by, received_at, parse_error FROM messages ORDER BY received_at DESC LIMIT 20"
```

`error` rows preserve the parsing failure reason. Queue messages retry three times before the configured dead-letter Queue.

On Workers Free, both Queues retain messages for only 24 hours. Investigate the dead-letter Queue within that window. Raw MIME in R2 remains the durable recovery source; automatic replay from R2 is not implemented in this version.

## Credential rotation

Rotate one agent at a time:

1. Generate a new long random token locally.
2. Run `npx wrangler secret put MCP_CODEX_TOKEN` or `MCP_HERMES_TOKEN`.
3. Update only that client's protected environment variable.
4. Restart the client and confirm it can list MCP tools.
5. Confirm a request with the old token receives HTTP `401`.

Never put a raw token in `wrangler.jsonc`, source control, shell history, logs, or a URL.

## Common failures

- **Mail bounces before the Worker runs:** verify Email Routing is `ready`, all three Cloudflare MX records resolve publicly, and the exact address rule is enabled.
- **Raw message exists but no D1 row:** inspect Queue and dead-letter Queue state plus `ingest_failed` logs.
- **Message row is `error`:** inspect `parse_error`; raw MIME remains in R2 until retention removes it.
- **MCP returns `401`:** verify the client sees the named environment variable and restart it after environment changes.
- **MCP returns a configuration `500`:** both Worker secrets must exist and must differ.
- **A claimed item appears stuck:** the lease is 30 minutes; it becomes claimable again after expiration.
- **Reply reports `OUTBOUND_DISABLED`:** expected in the default deployment. It prepared a threaded reply but sent nothing.

## Retention and deletion

The recommended R2 lifecycle expires `raw/` objects after 180 days. D1 normalized rows are retained indefinitely in this version. Deleting mail is therefore an explicit operator action and is not exposed as an MCP tool.

## Deployment checks

Before each deployment:

```bash
npm ci
npx wrangler whoami
npm run check
npm audit --audit-level=high
npm run startup-check
git diff --check
```

Confirm that `whoami` shows the intended account. Review Cloudflare binding changes carefully: a renamed D1, R2, or Queue binding can provision or attach a new empty resource instead of the existing production resource.
