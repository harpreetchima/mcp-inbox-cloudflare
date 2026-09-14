# Self-hosting on Cloudflare

A fresh clone needs five Cloudflare resources, two secret values that identify agents, and one email routing rule. After setup, Cloudflare receives and processes mail without a computer left online.

The examples use `agents@example.com`. Replace that address and domain with your own.

> **Protect current mail delivery:** Cloudflare Email Routing changes the MX records that direct inbound mail. If another provider receives mail for the domain, use a dedicated subdomain such as `agents@inbox.example.com` or use another domain.

## What this deployment creates

| Resource | Name used in this guide | Job |
| --- | --- | --- |
| Worker | `agents-mail` | Receives email and serves agent tools at `/mcp`. |
| D1 database | `agents-mail` | Stores parsed message fields and claim state. |
| R2 bucket | `agents-mail-raw` | Stores each original email as an `.eml` file with its headers and attachments. Keep public access off. |
| Queue | `agents-mail-ingest` | Schedules message parsing. |
| Dead-letter Queue | `agents-mail-ingest-dlq` | Holds jobs that exhaust retries after processing exceptions. |
| Email Routing rule | One per receiving address | Sends that address to the shared Worker. |

A binding is the name code uses for a Cloudflare resource. Keep the bindings `DB`, `RAW_EMAILS`, and `INGEST_QUEUE`. Resource names may differ, but the names in Wrangler configuration and maintenance commands must match.

The checked-in `wrangler.jsonc` starts with draft D1 and R2 bindings. The creation commands below add account identifiers and the R2 bucket name. `agents-mail-raw` is a name chosen by this guide, not a bucket already attached by the template.

## Requirements

You need:

- Node.js `^22.18.0` or `>=24.11.0`, plus npm. This is the supported range in `package.json`.
- A Cloudflare account.
- A domain in that account using Cloudflare as its authoritative DNS provider, meaning Cloudflare publishes the domain's DNS records.
- An active [R2 subscription](https://developers.cloudflare.com/r2/get-started/). Cloudflare may ask you to complete the R2 activation flow before bucket creation.
- Permission to create Workers, D1 databases, R2 buckets, Queues, Worker secrets, and Email Routing rules.

## Cost and size limits

Low message volume may stay inside Cloudflare's free quotas. This is an estimate, not a price guarantee. Message count, message size, retention, and platform price changes affect the bill. R2 charges for usage above its allowance.

Review current [Email Service](https://developers.cloudflare.com/email-service/platform/pricing/), [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/), and [Queues](https://developers.cloudflare.com/queues/platform/pricing/) prices before deployment.

Inbound mail does not require Workers Paid. Mail to arbitrary recipients uses a separate paid path, and this project does not wire that path into the MCP server.

Cloudflare Email Routing rejects inbound messages above 25 MiB. This project parses messages up to 5 MiB. A message above 5 MiB that reaches the Worker stays in R2 and gets a D1 `error` row. See [Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/).

## Command note for alternate Wrangler files

Wrangler is Cloudflare's command-line tool for deployment and resource management. The commands below use the default `wrangler.jsonc`. If your account mapping lives in another complete configuration file, pass it to every Wrangler command. Wrangler files are complete configurations rather than overlays.

Examples:

```bash
npm run deploy -- --config wrangler.production.jsonc
npx wrangler d1 migrations apply DB --remote --config wrangler.production.jsonc
npx wrangler tail agents-mail --config wrangler.production.jsonc
```

Keep one configuration path throughout setup and operations. Mixing the draft template with a production file can target an empty or unrelated resource.

## 1. Check the domain before changing DNS

An MX record names the servers that receive a domain's mail. The apex is the bare domain, such as `example.com`; a routing subdomain is a child such as `inbox.example.com`.

If the apex already receives mail through Google Workspace, Microsoft 365, Fastmail, another provider, or your own mail server, do not onboard that apex to Email Routing. Cloudflare cannot share the same apex MX setup with another inbound provider.

Inspect records in **Cloudflare Dashboard → DNS → Records**, or run:

```bash
dig MX example.com +short
dig TXT example.com +short
```

Do not remove records until you know what uses them. A domain should publish one SPF policy, a TXT record that names permitted sending services. If the current policy must remain, merge Cloudflare's entry into it instead of publishing a second `v=spf1` record. Read Cloudflare's [domain configuration](https://developers.cloudflare.com/email-service/configuration/domains/) page before accepting DNS changes.

## 2. Check the project and choose the mailbox domain

From the repository root:

```bash
node --version
npm ci
npx wrangler --version
```

The Node.js version must match `package.json`. Wrangler should report the version pinned in `package-lock.json`.

Set the exact receiving domain in the Wrangler configuration file you chose:

```jsonc
"vars": {
  "MAILBOX_DOMAIN": "example.com",
  "OUTBOUND_EMAIL_ENABLED": "false"
}
```

For addresses such as `agents@inbox.example.com`, use `inbox.example.com`. The domain check does not automatically include subdomains. Active addresses are managed through Email Routing rules in step 9.

Keep `OUTBOUND_EMAIL_ENABLED` set to `false`. The current MCP server has no sender wired into it, so changing this flag or adding a binding would not activate delivery by itself.

Check the project:

```bash
npm run typegen
npm run check
```

`npm run check` runs type checking, linting, local integration tests, and a deployment dry run against the tracked `wrangler.jsonc`. It does not validate another Wrangler file.

## 3. Authenticate to the intended account

```bash
npx wrangler login
npx wrangler whoami
```

Confirm that `whoami` lists the account that contains the domain. If it lists more than one account, copy the intended account ID into the complete configuration file you chose before creating resources:

```jsonc
"account_id": "YOUR_ACCOUNT_ID"
```

This setting pins later commands to that account. The resources and email domain must belong to the same account. Do not rely on an account variable set only in the setup shell.

Do not repeat `wrangler login` when `whoami` already reports the intended user and account.

## 4. Create D1, R2, and the Queues

Run these commands once for a fresh deployment:

```bash
npx wrangler d1 create agents-mail --binding DB
npx wrangler r2 bucket create agents-mail-raw --binding RAW_EMAILS
npx wrangler queues create agents-mail-ingest
npx wrangler queues create agents-mail-ingest-dlq
```

The `--binding` options update the chosen configuration file with the D1 identifier and R2 bucket name. These values are not passwords, but they connect this checkout to resources in one account. Do not copy identifiers from another deployment.

Confirm that the four resources exist:

```bash
npx wrangler d1 list
npx wrangler r2 bucket list
npx wrangler queues list
```

If you chose other resource names, update every matching value in the chosen configuration. Run the project check after the binding changes:

```bash
npm run check
```

For another complete Wrangler file, run its deployment dry run too:

```bash
npm run dry-run -- --config wrangler.production.jsonc
```

The output should name the intended Worker, bindings, and resources.

## 5. Apply the D1 schema

A migration is a versioned database change stored in `migrations/`. Apply all pending migrations to the remote database:

```bash
npx wrangler d1 migrations apply DB --remote
```

Review Wrangler's proposed migrations before confirming them. A fresh installation should report that both `0001_initial.sql` and `0002_multi_address.sql` ran successfully. An existing single-address installation should follow the [upgrade procedure](OPERATIONS.md#upgrade-from-a-single-address).

## 6. Deploy and check the Worker

```bash
npm run deploy
```

Replace that command with `npm run deploy -- --config wrangler.production.jsonc` when you use the alternate file. Run one form, not both.

On the first Workers deployment, Cloudflare may ask you to register a `workers.dev` account subdomain. Complete that prompt to receive a public HTTPS URL for `/health` and `/mcp`.

Wrangler prints a URL like this:

```text
https://agents-mail.YOUR-SUBDOMAIN.workers.dev
```

Save the URL. You can find it later under the Worker's **Domains** tab in **Cloudflare Dashboard → Workers & Pages → agents-mail**. Some dashboard versions place it under **Settings → Domains & Routes**.

Check the public health route:

```bash
curl --fail https://agents-mail.YOUR-SUBDOMAIN.workers.dev/health
```

Expected response:

```json
{"ok":true,"service":"agents-mail"}
```

This response proves that the Worker route answered. It does not test D1, R2, the Queue, Email Routing, or agent credentials.

## 7. Create two bearer credentials

The Worker recognizes two fixed identities: `codex` and `hermes`. It requires two different secret values, including when only one client is installed. A Hermes credential reserves an identity; it does not install Hermes.

Generate two independent 32-byte values with a password manager or run this command twice on a trusted computer:

```bash
openssl rand -hex 32
```

Store one value for Codex and one for Hermes. Enter them at Wrangler's hidden prompts:

```bash
npx wrangler secret put MCP_CODEX_TOKEN
npx wrangler secret put MCP_HERMES_TOKEN
```

List the secret names:

```bash
npx wrangler secret list
```

The list should contain:

- `MCP_CODEX_TOKEN`
- `MCP_HERMES_TOKEN`

Keep client copies in a password manager, operating-system secret store, or owner-readable environment file. Never put raw values in `wrangler.jsonc`, a URL, source control, or an MCP client's plain configuration field.

An unauthenticated request should return HTTP `401`:

```bash
curl --output /dev/null --silent --write-out '%{http_code}\n' \
  https://agents-mail.YOUR-SUBDOMAIN.workers.dev/mcp
```

This check proves the unauthenticated boundary. The authenticated `list_messages` check in step 11 tests the configured values and catches missing or identical secrets.

## 8. Set raw-message retention

An R2 lifecycle rule deletes objects after a chosen age. Install a rule for objects under `raw/`:

```bash
npx wrangler r2 bucket lifecycle add agents-mail-raw \
  expire-raw-after-180-days raw/ \
  --expire-days 180
```

Verify the rule:

```bash
npx wrangler r2 bucket lifecycle list agents-mail-raw
```

This rule is a manual setup step; it is not stored in `wrangler.jsonc`. Cloudflare evaluates expiration in the background, so an object may remain for a period after its 180th day. D1 rows have no automatic deletion policy.

## 9. Set up Email Routing

Use the dashboard for initial setup so you can review each DNS change before accepting it.

For an apex mailbox such as `agents@example.com`:

1. Open **Cloudflare Dashboard → Compute → Email Service → Email Routing**.
2. Select **Onboard Domain** and choose the domain.
3. Review the proposed MX and TXT records.
4. Cancel if the MX change would replace a mail provider you still use.
5. Complete onboarding and wait for Cloudflare to report the domain and DNS records as ready.

For a routing subdomain such as `agents@inbox.example.com`:

1. Select the apex domain in Email Routing.
2. Open **Settings → Subdomains** and add `inbox`.
3. Review records for that subdomain only.
4. Accept them and wait for the subdomain to report ready.

Cloudflare may require one verified destination address before any routing rule can be created. Follow the dashboard prompt. That address satisfies account setup; the mailbox rule below still targets the Worker. See [Email Routing rules and addresses](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/).

After either domain path reports ready:

1. Open the domain's **Routing Rules** tab and select **Create routing rule**.
2. Enter the mailbox's local part, such as `agents`, and select the intended domain or routing subdomain.
3. Set **Action** to **Send to a Worker** and choose `agents-mail`.
4. Save the rule and confirm it is active.
5. Keep **Catch-all** off.
6. Keep automatic subaddressing off so plus-tagged addresses require their own explicit rules.

The Worker checks the recipient's domain against `MAILBOX_DOMAIN`. It accepts any address routed to it on that domain. Exact rules define which addresses receive mail; turning on catch-all or subaddressing would broaden that set.

### Add an address

Once this version is deployed, adding an address on the same domain requires no application configuration change or redeployment:

1. Create an exact rule, such as `research@example.com`, in the domain's **Routing Rules** tab.
2. Select **Send to a Worker** and choose the existing `agents-mail` Worker.
3. Save and enable the rule.
4. Send a harmless test email and call `list_messages` with `{"address":"research@example.com"}`. Confirm the result's `envelopeTo` names the new address.

Use `claim_next_message` with the same `address` to reserve work for that address. Matching ignores capitalization; omitting the filter includes all addresses. All authenticated agents retain access to the shared inbox.

Disable the address's rule to stop new delivery through it. Stored messages remain available through the same filters.

You may inspect the configuration from a terminal:

```bash
npx wrangler email routing settings example.com
npx wrangler email routing dns get example.com
npx wrangler email routing rules list example.com
```

Query public DNS after Cloudflare reports ready:

```bash
dig MX example.com +short
# For a routing subdomain:
dig MX inbox.example.com +short
```

Compare the result with the records shown by Cloudflare. Do not send a test message when an old provider's MX record still appears on the chosen mailbox domain.

## 10. Test a real incoming message

Stream logs in one terminal:

```bash
npx wrangler tail agents-mail
```

From a normal mail provider, send a harmless message to the configured address. A generic subject such as `Test notification` and body such as `This is a setup test.` are enough.

Inspect D1 from another terminal:

```bash
npx wrangler d1 execute DB --remote --command \
  "SELECT id, envelope_to, subject, status, received_at FROM messages ORDER BY received_at DESC LIMIT 5"
```

A complete test has four pieces of evidence:

- **Cloudflare Dashboard → Compute → Email Service → Email Routing → your domain → Activity Log** records the message as `Handled`. See [Email logs](https://developers.cloudflare.com/email-service/observability/logs/).
- Worker logs show `email_accepted` and no `ingest_failed` event for that message.
- D1 contains one row, normally with status `new`.
- **Cloudflare Dashboard → R2 object storage → agents-mail-raw → Objects** contains a key under `raw/YYYY-MM-DD/`. See [R2 objects](https://developers.cloudflare.com/r2/objects/).

If the file reaches R2 but D1 has no row, inspect the ingest Queue, dead-letter Queue, and `ingest_failed` logs. [Operations](OPERATIONS.md) gives symptom-based checks.

Workers Free keeps Queue messages for 24 hours. Inspect failures inside that period. R2 holds the original message, but this version has no automatic replay command.

## 11. Connect an MCP client

The endpoint is:

```text
https://agents-mail.YOUR-SUBDOMAIN.workers.dev/mcp
```

It uses Streamable HTTP, an MCP transport over HTTPS, and requires `Authorization: Bearer YOUR_TOKEN`. Codex and Hermes are optional. Any compatible MCP client may use one of the two credentials.

Require one successful `list_messages` call before treating authentication as complete. HTTP `401` means the credential did not match. A configuration HTTP `500` means the Worker secrets are missing or identical.

### Codex

Make the Codex value available to the Codex process without placing it in `config.toml`:

```bash
read -rsp 'Codex mailbox token: ' AGENTS_MAIL_CODEX_TOKEN
echo
export AGENTS_MAIL_CODEX_TOKEN

codex mcp add agents_mail \
  --url https://agents-mail.YOUR-SUBDOMAIN.workers.dev/mcp \
  --bearer-token-env-var AGENTS_MAIL_CODEX_TOKEN

codex mcp get agents_mail --json
```

The exported value lasts for that shell and its child processes. For persistent use, load it from a password manager, operating-system secret store, or owner-readable environment file when Codex starts. Restart Codex after configuration changes, then call `list_messages` and confirm that the test message appears.

### Hermes

If Hermes is installed with its default profile, put the Hermes value in `~/.hermes/.env`:

```dotenv
AGENTS_MAIL_HERMES_TOKEN=replace-with-the-hermes-token
```

Restrict the file to its owner:

```bash
chmod 600 ~/.hermes/.env
```

Add this server to `~/.hermes/config.yaml`:

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

Restart Hermes or reload its MCP configuration, then call `list_messages`. A profile other than the default uses that profile's environment and configuration files. Skip this client section when Hermes is not installed; Cloudflare continues to receive and store mail.

The credential fixes claim ownership as `codex` or `hermes`. A client-supplied name cannot change it.

## Final check

- [ ] `MAILBOX_DOMAIN` contains the exact receiving domain.
- [ ] `OUTBOUND_EMAIL_ENABLED` remains `false`.
- [ ] Every Wrangler command used the intended complete configuration file.
- [ ] `wrangler whoami` shows the account that owns the domain; a multi-account configuration contains that `account_id`.
- [ ] D1, R2, the ingest Queue, and the dead-letter Queue exist.
- [ ] D1 migrations `0001_initial.sql` and `0002_multi_address.sql` ran on the remote database.
- [ ] `/health` returns `ok: true`.
- [ ] Both Worker secret names exist and their values differ.
- [ ] The manual R2 lifecycle rule exists.
- [ ] Email Routing reports ready for the mailbox domain.
- [ ] Each intended address has an exact rule sending to `agents-mail`.
- [ ] Catch-all and subaddressing are off.
- [ ] One generic test message appears in D1 and R2.
- [ ] An authenticated `list_messages` call filtered by `address` returns that message and its `envelopeTo`.

Mail processing now runs on Cloudflare. A computer is needed only for deployments, maintenance, and agent access.

## Publishing a reusable template — optional

Account identifiers in Wrangler configuration are not passwords, but they bind a checkout to one deployment.

For a personal or private deployment, committing those identifiers can make later deployments repeatable for trusted operators. For a public template, keep a complete account file such as `wrangler.production.jsonc` outside source control, back it up in protected storage, and pass `--config` on every Wrangler command. Do not leave the only production mapping on one computer.

## Official references

- [Route emails with Cloudflare Email Service](https://developers.cloudflare.com/email-service/get-started/route-emails/)
- [Email Routing rules and addresses](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)
- [Email Service domain and DNS configuration](https://developers.cloudflare.com/email-service/configuration/domains/)
- [Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/)
- [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/)
- [R2 lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
