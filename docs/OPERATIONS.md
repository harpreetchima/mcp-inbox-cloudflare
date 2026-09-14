# Operations

Start with the visible symptom. The public health route proves only that the Worker answered; it does not prove that mail routing, storage, parsing, or authentication works.

Commands in this guide use `wrangler.jsonc`. If production uses another complete file, append `--config wrangler.production.jsonc` to every `npx wrangler` command. For npm scripts that invoke Wrangler, use forms such as `npm run deploy -- --config wrangler.production.jsonc`. Do not mix the draft template with a production configuration during one operation.

## Find the failure

| Symptom | Check |
| --- | --- |
| Mail bounces before the Worker runs | Confirm that Email Routing reports `ready`, the mailbox domain resolves to Cloudflare's MX records, and the exact-address rule is active. |
| The Worker rejects with `Unknown mailbox domain` | Compare the actual delivery domain with `MAILBOX_DOMAIN`; it must match exactly, including any routing subdomain. |
| An address filter returns no messages | Use the complete delivery address. Check its routing rule and ingest logs. Address filters use the envelope recipient, which may differ from the message's `To` header. |
| R2 contains the `.eml` file but D1 has no row | Inspect the ingest Queue, the dead-letter Queue that holds jobs after their retries, and `ingest_failed` logs. |
| A D1 row has status `error` | Read `parse_error`. The original message stays in R2 until its lifecycle rule removes it. |
| MCP returns HTTP `401` | Confirm that the client process has the named environment variable, then restart the client. |
| MCP returns a configuration HTTP `500` | Confirm that both Worker secrets exist and contain different values. |
| A message stays claimed | Wait for its 30-minute claim to expire. Its status stays `claimed`, but the next claim request may take it. |
| A reply returns `OUTBOUND_DISABLED` | This is the current design. The tool prepared a threaded reply and sent nothing. |

## Check health and logs

The health route returns a service name and no mailbox data:

```bash
curl --fail https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/health
```

Stream Worker logs during diagnosis:

```bash
npx wrangler tail agents-mail
```

Project event names include `email_accepted`, `ingest_failed`, `invalid_ingest_job`, `email_ingress_failed`, `auth_configuration_invalid`, `auth_tokens_not_distinct`, and `mcp_error`. The code does not pass body or bearer-token fields to its logging calls. Error messages are not redacted, so review new error sources before logging them.

## Inspect D1 and Queue failures

D1 holds the parsed message fields and work state. Agents should read mail through MCP; operators may inspect D1 during diagnosis:

```bash
npx wrangler d1 execute DB --remote --command \
  "SELECT id, envelope_to, subject, status, claimed_by, received_at, parse_error FROM messages ORDER BY received_at DESC LIMIT 20"
```

An `error` row keeps the reason in `parse_error`. If the parser cannot decode the email's body parts or attachments, the Worker writes that row and removes the job from the Queue. Another processing failure, such as a missing R2 object, retries up to three times before it moves to the dead-letter Queue. A job with an invalid body logs `invalid_ingest_job`, then is removed without retry.

The Workers Free plan keeps Queue messages for 24 hours. Inspect failed work inside that period; see [Queues pricing and limits](https://developers.cloudflare.com/queues/platform/pricing/). The original `.eml` file in R2 is the recovery source. This version has no command that replays it into the Queue.

## Upgrade from a single address

Use the complete configuration that maps to the existing deployment throughout this upgrade. The examples below assume `wrangler.production.jsonc`.

1. Export a backup to protected storage outside the repository and record the existing message counts by status and address. For example:

   ```bash
   npx wrangler d1 export DB --remote --config wrangler.production.jsonc --output /path/to/protected/agents-mail-before-multi-address.sql
   ```

2. In that configuration, replace `MAILBOX_ADDRESS` with `MAILBOX_DOMAIN`: `agents@example.com` becomes `example.com`; `agents@inbox.example.com` becomes `inbox.example.com`. Retain the existing resource bindings and credentials.
3. Run the repository checks and the production configuration's deployment dry run as described below.
4. Apply `0002_multi_address.sql` to the existing database:

   ```bash
   npx wrangler d1 migrations apply DB --remote --config wrangler.production.jsonc
   ```

   This migration rebuilds the messages table to replace global content-hash uniqueness with uniqueness per delivery address. It copies all fields unchanged, preserving IDs, raw-file references, and claim state. Check existing records after the migration, accounting for any new mail received during the upgrade. The old Worker can continue using the migrated table until the new version is deployed.

5. Deploy the updated Worker with the same complete configuration:

   ```bash
   npm run deploy -- --config wrangler.production.jsonc
   ```

6. Confirm that mail to the original address is received and returned both with and without an `address` filter. Then follow [Add an address](CLOUDFLARE_SETUP.md#add-an-address) and verify a second address. Reload MCP clients if they cache tool schemas.

Apply the migration before enabling additional addresses. After the upgrade, future addresses need only a Cloudflare rule. Routine additions do not require new databases, buckets, credentials, or Worker deployments.

If rolling back the Worker, restore its original `MAILBOX_ADDRESS` configuration and disable newly added routes that the old version cannot accept. Leave the migrated schema in place: it remains compatible with the old Worker. Restoring the old database backup would discard mail received since that backup and is a separate recovery operation.

## Rotate an agent credential

Rotate one identity at a time:

1. Generate a new long random value on a trusted computer.
2. Run `npx wrangler secret put MCP_CODEX_TOKEN` or `npx wrangler secret put MCP_HERMES_TOKEN`.
3. Replace only that client's protected environment value.
4. Restart the client and make one successful `list_messages` call.
5. Check that the old value now receives HTTP `401`.

The fifth check does not need a full MCP exchange. Authentication runs before the MCP handler:

```bash
read -rsp 'Old mailbox token: ' OLD_AGENT_TOKEN
echo
curl --output /dev/null --silent --write-out '%{http_code}\n' \
  --header "Authorization: Bearer ${OLD_AGENT_TOKEN}" \
  https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/mcp
unset OLD_AGENT_TOKEN
```

Never place a raw token in `wrangler.jsonc`, source control, shell history, logs, or a URL.

## Retention and deletion

If the operator completed setup step 8, an R2 lifecycle rule expires `raw/` objects after 180 days. D1 has no automatic deletion policy. Deleting normalized mail is an operator action; no MCP tool exposes deletion.

## Check a deployment

Run these commands before each deployment:

```bash
npm ci
npx wrangler whoami
npm run check
npm audit --audit-level=high
npm run startup-check
git diff --check
```

When production uses another Wrangler file, run its dry run and startup check too:

```bash
npm run dry-run -- --config wrangler.production.jsonc
npm run startup-check -- --config wrangler.production.jsonc
```

`whoami` confirms the authenticated user and account memberships. In a multi-account setup, confirm that the complete production file contains the intended `account_id`. Review the named bindings and resources in the production dry run. Renaming a D1, R2, or Queue binding may point the Worker at a new empty resource instead of the production resource.
