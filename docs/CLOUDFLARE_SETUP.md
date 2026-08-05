# Cloudflare setup

These instructions create a new deployment in a Cloudflare account. Examples use `agents@example.com`; substitute an address on your own Cloudflare-managed domain.

## 1. Configure and verify locally

Edit `MAILBOX_ADDRESS` in `wrangler.jsonc`, then run:

```bash
npm install
npm run check
```

The checked-in R2 and D1 bindings omit account-specific identifiers so current Wrangler versions can provision them for a new account. Do not commit identifiers, access tokens, or production bearer tokens when sharing the repository.

## 2. Deploy resources and schema

Authenticate to the intended Cloudflare account and deploy:

```bash
npx wrangler login
npm run deploy
npx wrangler d1 migrations apply DB --remote
```

The configuration declares one D1 database, one private R2 binding, an ingest Queue, and a dead-letter Queue. Confirm the selected account before accepting provisioning prompts.

## 3. Set agent secrets

Generate two different random values locally. Enter each only at Wrangler's secret prompt:

```bash
npx wrangler secret put MCP_CODEX_TOKEN
npx wrangler secret put MCP_HERMES_TOKEN
```

Store the corresponding client credentials outside the repository with owner-only permissions.

## 4. Add raw-message retention

Find the R2 bucket name created for `RAW_EMAILS`, then add a 180-day rule for the `raw/` prefix:

```bash
npx wrangler r2 bucket lifecycle add YOUR_RAW_BUCKET \
  expire-raw-after-180-days raw/ \
  --expire-days 180
```

Cloudflare evaluates expiration asynchronously, so deletion can occur after an object crosses the configured age.

## 5. Enable inbound routing

In the Cloudflare dashboard for the domain:

1. Open **Email > Email Routing** and enable routing. Cloudflare adds and manages the required MX, SPF, and DKIM records.
2. Create one routing rule matching the exact mailbox, such as `agents@example.com`.
3. Select **Send to a Worker** and choose this Worker.
4. Leave the catch-all rule disabled.
5. Leave subaddress matching disabled unless addresses such as `agents+tag@example.com` should also be accepted.

The Worker performs the same exact-recipient check and rejects mail sent to a different envelope address.

## 6. Verify

Check the public health endpoint:

```bash
curl --fail https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/health
```

Configure a client using the README, restart it, and confirm the MCP server exposes:

- `list_messages`
- `get_message`
- `claim_next_message`
- `complete_message`
- `reply_to_message`

Finally, send a harmless generic notification from a normal mail provider to the configured address and confirm it appears through `list_messages`.

## Outbound replies

No outbound binding is declared, and `OUTBOUND_EMAIL_ENABLED` remains `false`. Enabling actual delivery is a separate change: upgrade to the required Workers plan, configure a permitted sending address and `send_email` binding, pass that binding into the MCP server, and only then turn on the flag. Review Cloudflare's current [Email Workers sending documentation](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/) first.
