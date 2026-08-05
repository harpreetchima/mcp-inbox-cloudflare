# Self-hosting on Cloudflare

This guide takes a fresh clone from no Cloudflare resources to a working inbound mailbox. Examples use `agents@example.com`; replace the domain and address with your own.

After deployment, mail is received and processed entirely by Cloudflare. Your computer does not need to remain on, and neither Codex nor Hermes has to be installed on the deployment machine.

## What this setup creates

| Resource | Default name | Purpose |
| --- | --- | --- |
| Worker | `agents-mail` | Receives email and serves the MCP endpoint. |
| D1 database | `agents-mail` | Stores normalized message data and claim state. |
| R2 bucket | `agents-mail-raw` | Privately stores original `.eml` messages. |
| Queue | `agents-mail-ingest` | Runs parsing outside the inbound email request. |
| Dead-letter Queue | `agents-mail-ingest-dlq` | Holds jobs that exhaust their retries. |
| Email Routing rule | Your exact mailbox | Sends only that address to the Worker. |

The binding names `DB`, `RAW_EMAILS`, and `INGEST_QUEUE` are application interfaces and should not be renamed. Resource names may be changed if they already exist in your account, but the corresponding values in `wrangler.jsonc` and the commands below must stay consistent.

## Requirements and cost

You need:

- Node.js `^22.18.0` or `>=24.11.0`, plus npm. This matches the locked dependencies.
- A Cloudflare account.
- A domain in that account using Cloudflare authoritative DNS.
- An active [R2 subscription](https://developers.cloudflare.com/r2/get-started/). Cloudflare may ask you to complete an R2 checkout even though R2 includes free monthly usage.
- Permission to create Workers, D1 databases, R2 buckets, Queues, Worker secrets, and Email Routing rules.

For a low-volume inbox, this deployment is expected to remain inside the Workers Free allowances. Email Routing is available on the Free plan, and Workers, D1, R2, and Queues have free allowances. R2 is a usage-based subscription: Standard storage currently includes a monthly free allowance, then excess usage is billable rather than blocked. Review the current [Email Service](https://developers.cloudflare.com/email-service/platform/pricing/), [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/), and [Queues](https://developers.cloudflare.com/queues/platform/pricing/) pricing before deploying.

Workers Paid and Email Sending are **not** required for this inbound-only setup. Sending replies to arbitrary recipients is a separate paid capability and remains disabled in this project.

Workers Free has lower CPU limits than Workers Paid. Small notification emails are the intended workload; if Worker logs show `EXCEEDED_CPU` while parsing large or complex messages, reduce message size or move the Worker to the Paid plan.

## 1. Check the domain before changing email DNS

Email Routing installs Cloudflare MX records on the domain. Those records determine where all inbound mail for that domain is delivered.

If the domain already receives mail through Google Workspace, Microsoft 365, Fastmail, another provider, or a self-hosted mail server, stop before onboarding the apex domain. Cloudflare Email Routing cannot share the same apex MX configuration with an external inbound provider. Use a dedicated subdomain such as `agents@inbox.example.com`, or use a separate domain. A subdomain has its own onboarding flow; follow Cloudflare's [Email Routing subdomain instructions](https://developers.cloudflare.com/email-service/configuration/subdomains/) before creating the routing rule in step 9.

Inspect the current records in **Cloudflare Dashboard → DNS → Records**, or from a terminal:

```bash
dig MX example.com +short
dig TXT example.com +short
```

Do not remove or replace records until you understand their current use. A domain must also have only one SPF record; if an existing SPF policy must remain, merge Cloudflare's include into it rather than publishing a second `v=spf1` record. See Cloudflare's [domain configuration](https://developers.cloudflare.com/email-service/configuration/domains/) documentation.

## 2. Install and check the project

From the repository root:

```bash
node --version
npm ci
npx wrangler --version
```

Expected results:

- Node matches the supported range in `package.json`.
- Wrangler reports the version pinned by this repository.

Edit `MAILBOX_ADDRESS` in `wrangler.jsonc`:

```jsonc
"vars": {
  "MAILBOX_ADDRESS": "agents@example.com",
  "OUTBOUND_EMAIL_ENABLED": "false"
}
```

Use one exact mailbox. Keep `OUTBOUND_EMAIL_ENABLED` set to `false`, and do not add a `send_email` binding for this setup. Then validate the configured project:

```bash
npm run typegen
npm run check
```

Type generation, type checking, linting, integration tests, and the deployment dry run should all pass.

## 3. Authenticate to the intended account

```bash
npx wrangler login
npx wrangler whoami
```

Before continuing, confirm that `whoami` lists the account containing the domain you intend to use. If you belong to several Cloudflare accounts, copy the intended account ID shown by `whoami` and set `CLOUDFLARE_ACCOUNT_ID` for the setup shell, or add that `account_id` to your deployment configuration. All resources and the email domain must be created in the same account. Repeated login is not necessary when `whoami` already reports the correct authenticated user and account.

## 4. Create the Cloudflare resources

The following commands create a deterministic set of resources. Run them once for a fresh deployment:

```bash
npx wrangler d1 create agents-mail --binding DB
npx wrangler r2 bucket create agents-mail-raw --binding RAW_EMAILS
npx wrangler queues create agents-mail-ingest
npx wrangler queues create agents-mail-ingest-dlq
```

The `--binding` options cause Wrangler to add the new D1 identifier and R2 bucket name to your working copy of `wrangler.jsonc`. This is expected. These values are account-specific resource identifiers, not passwords, but they connect a checkout to one deployment. Never copy identifiers from somebody else's deployment.

For a personal or private deployment fork, committing those resource identifiers makes future deployments reproducible for other operators. If you maintain a reusable public template, keep an account-specific `wrangler.production.jsonc` outside public source control, back it up securely, and pass `--config wrangler.production.jsonc` to Wrangler deployment and maintenance commands. Do not leave the only production mapping on one computer.

Confirm that all four resources exist:

```bash
npx wrangler d1 list
npx wrangler r2 bucket list
npx wrangler queues list
```

You should see the database, bucket, ingest Queue, and dead-letter Queue named above. If you chose different names, update every matching name in `wrangler.jsonc` before proceeding.

Run the project check again after Wrangler updates the bindings:

```bash
npm run check
```

Wrangler also supports automatic D1, R2, and Queue provisioning when draft bindings are deployed. This repository does not rely on that behavior in this guide because explicit creation makes the resulting resource names and retention command unambiguous.

## 5. Apply the database schema

```bash
npx wrangler d1 migrations apply DB --remote
```

Review the migration shown by Wrangler and confirm it. The output should report that `0001_initial.sql` was applied successfully.

## 6. Deploy and record the Worker URL

```bash
npm run deploy
```

On a first Workers deployment, Cloudflare may ask you to register a `workers.dev` account subdomain. Accept that prompt so the MCP and health endpoints have a public HTTPS URL.

Wrangler prints a URL resembling:

```text
https://agents-mail.YOUR-SUBDOMAIN.workers.dev
```

Save the complete URL as your Worker URL. It can also be found later under the Worker's **Domains** tab in **Cloudflare Dashboard → Workers & Pages → agents-mail**; some dashboard layouts label this **Settings → Domains & Routes**.

The health endpoint should now respond, even before agent credentials are installed:

```bash
curl --fail https://agents-mail.YOUR-SUBDOMAIN.workers.dev/health
```

Expected JSON:

```json
{"ok":true,"service":"agents-mail"}
```

## 7. Create two agent credentials

The Worker recognizes two fixed identities, `codex` and `hermes`, so it requires two different secrets even if you currently use only one client. A Hermes credential does not mean Hermes is installed; it merely reserves that identity for a future client.

Generate two independent 32-byte values with a password manager or, on a trusted terminal, run this command twice:

```bash
openssl rand -hex 32
```

Save the first value as the Codex credential and the second as the Hermes credential. Do not reuse a value. Enter them only at Wrangler's hidden prompts:

```bash
npx wrangler secret put MCP_CODEX_TOKEN
npx wrangler secret put MCP_HERMES_TOKEN
```

Confirm that the secret **names**, but not their values, are present:

```bash
npx wrangler secret list
```

Expected names:

- `MCP_CODEX_TOKEN`
- `MCP_HERMES_TOKEN`

Keep the matching client-side values in a password manager, operating-system secret store, or a file readable only by that user. Never put them in `wrangler.jsonc`, a URL, source control, or an MCP client's plain configuration field.

With both secrets configured, an unauthenticated MCP request should fail closed with HTTP `401`:

```bash
curl --output /dev/null --silent --write-out '%{http_code}\n' \
  https://agents-mail.YOUR-SUBDOMAIN.workers.dev/mcp
```

This `401` verifies the unauthenticated boundary only. The authenticated `list_messages` check in step 11 must also succeed; that later check rejects missing, incorrect, or accidentally identical Worker secrets.

## 8. Configure raw-message retention

Add a lifecycle rule to delete raw messages under `raw/` after 180 days:

```bash
npx wrangler r2 bucket lifecycle add agents-mail-raw \
  expire-raw-after-180-days raw/ \
  --expire-days 180
```

Then verify it:

```bash
npx wrangler r2 bucket lifecycle list agents-mail-raw
```

Cloudflare evaluates lifecycle expiration asynchronously, so an object can remain for a while after crossing the configured age. Normalized D1 rows do not expire automatically in this version.

## 9. Enable Email Routing

Use the dashboard for initial onboarding so you can inspect every DNS change before accepting it.

For an apex mailbox such as `agents@example.com`:

1. Open **Cloudflare Dashboard → Compute → Email Service → Email Routing**.
2. Select **Onboard Domain**, choose your domain, and review the proposed MX, SPF, and DKIM records.
3. If the MX change would replace an existing inbound mail provider, cancel and return to step 1.
4. Finish onboarding and wait for the domain status and DNS records to show as ready. DNS usually propagates in 5–15 minutes but can take up to 24 hours.

For a subdomain mailbox such as `agents@inbox.example.com`, replace steps 2–4 above with this safer subdomain flow:

1. Select the apex domain entry in Email Routing.
2. Open **Settings → Subdomains** and add `inbox`.
3. Review and accept only the DNS records for that routing subdomain, then wait for it to become ready.

Then, for either path:

1. Open the configured domain's **Routing Rules** tab and select **Create routing rule**.
2. Enter only the local part of the mailbox, such as `agents`, and select the intended apex domain or routing subdomain.
3. Set **Action** to **Send to a Worker** and select `agents-mail`.
4. Save the rule and confirm it is active.
5. Leave the **Catch-all** rule disabled.
6. Under Email Routing **Settings**, leave subaddressing disabled unless `agents+tag@example.com` should intentionally match this mailbox.

A verified destination email address is not required when the rule sends directly to a Worker.

The current Wrangler email commands are open beta, but they are useful for read-only verification:

```bash
npx wrangler email routing settings example.com
npx wrangler email routing dns get example.com
npx wrangler email routing rules list example.com
```

The Worker performs its own exact-recipient check in addition to the Email Routing rule.

After DNS reports ready, query the mailbox domain again:

```bash
dig MX example.com +short
# For a subdomain mailbox instead:
dig MX inbox.example.com +short
```

The chosen mailbox domain should return only Cloudflare's three routing hosts: `route1.mx.cloudflare.net`, `route2.mx.cloudflare.net`, and `route3.mx.cloudflare.net`. Do not send a test message while a stale external-provider MX record remains.

## 10. Verify a real incoming message

First stream logs in one terminal:

```bash
npx wrangler tail agents-mail
```

From a normal mail provider, send a harmless message to the configured mailbox. Use a generic subject such as `Test notification` and a body such as `This is a setup test.`

Within a few seconds, inspect D1 from another terminal:

```bash
npx wrangler d1 execute DB --remote --command \
  "SELECT id, subject, status, received_at FROM messages ORDER BY received_at DESC LIMIT 5"
```

Success means:

- Email Routing shows the delivery in its activity or routing logs.
- Worker logs include `email_accepted` and do not include `ingest_failed`.
- D1 contains one row for the test message, normally with status `new`.
- Under **Cloudflare Dashboard → Storage & databases → R2 → agents-mail-raw → Objects**, the private bucket contains an object under `raw/YYYY-MM-DD/`.

If the message reaches R2 but not D1, inspect the ingest Queue, dead-letter Queue, and `ingest_failed` logs. See [OPERATIONS.md](OPERATIONS.md) for the full troubleshooting runbook.

On Workers Free, both the ingest Queue and dead-letter Queue retain messages for only 24 hours. Investigate failures within that window. Raw MIME in R2 is the durable recovery source; this version does not include an automatic replay command.

## 11. Connect an MCP client

The MCP endpoint is:

```text
https://agents-mail.YOUR-SUBDOMAIN.workers.dev/mcp
```

It uses Streamable HTTP and requires `Authorization: Bearer YOUR_TOKEN`. Codex and Hermes are optional clients; this repository does not install either one.

Whichever client you configure, require one successful `list_messages` call before considering authentication complete. A configuration HTTP `500` means the two Worker secrets are missing or identical; set two distinct values before continuing.

### Codex

Make the same value stored as `MCP_CODEX_TOKEN` available to the Codex process without placing the value in the Codex configuration. In Bash, this prompts without echoing the token or adding it to shell history:

```bash
read -rsp 'Codex mailbox token: ' AGENTS_MAIL_CODEX_TOKEN
echo
export AGENTS_MAIL_CODEX_TOKEN

codex mcp add agents_mail \
  --url https://agents-mail.YOUR-SUBDOMAIN.workers.dev/mcp \
  --bearer-token-env-var AGENTS_MAIL_CODEX_TOKEN

codex mcp get agents_mail --json
```

The `export` lasts only for that shell and its child processes. For persistent use, provide `AGENTS_MAIL_CODEX_TOKEN` through the secret mechanism used to launch Codex. Do not paste the raw token into `config.toml`.

Restart Codex, list the available MCP tools, then call `list_messages`. The test message should appear.

### Hermes

If Hermes is installed with its default profile, put the value stored as `MCP_HERMES_TOKEN` in `~/.hermes/.env`:

```dotenv
AGENTS_MAIL_HERMES_TOKEN=replace-with-the-hermes-token
```

Restrict that file to its owner, for example with `chmod 600 ~/.hermes/.env`. Add the following to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  agents_mail:
    url: "https://agents-mail.YOUR-SUBDOMAIN.workers.dev/mcp"
    headers:
      Authorization: "Bearer ${AGENTS_MAIL_HERMES_TOKEN}"
    tools:
      resources: false
      prompts: false
```

Restart Hermes or reload its MCP configuration, then call `list_messages`. A non-default profile uses that profile's corresponding environment and configuration files. If Hermes is not installed, skip this client step; the Cloudflare inbox continues to receive and store mail.

Any other Streamable HTTP MCP client can connect with one of the two bearer credentials. The credential determines the actor identity and claim ownership; a client-supplied name does not.

## Final setup checklist

- [ ] `MAILBOX_ADDRESS` contains one intended address.
- [ ] `OUTBOUND_EMAIL_ENABLED` remains `false`.
- [ ] `wrangler whoami` shows the account containing the domain.
- [ ] D1, R2, the ingest Queue, and the dead-letter Queue exist.
- [ ] D1 migration `0001_initial.sql` is applied.
- [ ] The Worker health endpoint returns `ok: true`.
- [ ] Both distinct Worker secret names are present.
- [ ] An authenticated `list_messages` call succeeds, proving the secrets are configured and distinct.
- [ ] The R2 `raw/` lifecycle rule is present.
- [ ] Email Routing DNS is ready.
- [ ] One exact-address rule sends to `agents-mail`.
- [ ] Catch-all and unintended subaddressing are disabled.
- [ ] A real generic test message appears in D1 and through MCP.

At that point, setup is complete. Future email processing happens on Cloudflare; local tooling is needed only for deployments and maintenance.

## Official references

- [Route emails with Cloudflare Email Service](https://developers.cloudflare.com/email-service/get-started/route-emails/)
- [Email Routing rules and addresses](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)
- [Email Service domain and DNS configuration](https://developers.cloudflare.com/email-service/configuration/domains/)
- [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/)
- [R2 lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
