# MCP Inbox for Cloudflare

A small, agent-centric email inbox that runs entirely on Cloudflare. Incoming mail is stored and normalized, then exposed to authenticated agents through a stateless MCP endpoint.

No local daemon or always-on computer is required. Local files are only source code, tests, and deployment tooling.

## What it does

- Receives one exact address through Cloudflare Email Routing.
- Stores the original RFC 822 message privately in R2.
- Parses useful metadata, plain text, links, and threading headers into D1.
- Uses a Queue to keep parsing outside the inbound email request.
- Lets Codex and Hermes independently list, read, claim, and complete messages over MCP.
- Builds correctly threaded replies while leaving outbound delivery disabled by default.

This is deliberately not a webmail application. Cloudflare's dashboards expose infrastructure and logs, but there is no human inbox UI in this project.

## Data flow

```text
Internet email
    -> Cloudflare Email Routing (one exact address)
    -> Worker email handler
    -> private raw message in R2
    -> Cloudflare Queue
    -> Worker queue handler
    -> normalized message in D1
    -> authenticated /mcp endpoint
    -> agent
```

## MCP tools

| Tool | Result |
| --- | --- |
| `list_messages` | Lists recent normalized messages, optionally by status. |
| `get_message` | Reads one message by its internal UUID. |
| `claim_next_message` | Atomically leases the oldest available message to the authenticated agent. |
| `complete_message` | Completes a message leased by that same agent. |
| `reply_to_message` | Builds RFC threading headers; sending remains off unless explicitly wired and enabled. |

Email is untrusted external input. MCP results repeat that warning so agents do not treat email text or links as instructions.

## Quick start

Requirements: Node.js 22.18 or a supported newer release, a Cloudflare account, an active R2 subscription, and a domain using Cloudflare DNS. The exact Node range is in `package.json`.

```bash
npm ci
npx wrangler login
npx wrangler whoami
npm run check
```

Before making DNS changes, check whether the domain already receives mail through another provider. Cloudflare Email Routing changes the domain's MX records and cannot share the same apex MX configuration with an external inbound provider.

The complete resource-creation, deployment, DNS-safety, credential, Email Routing, and end-to-end verification sequence is in [Self-hosting on Cloudflare](docs/CLOUDFLARE_SETUP.md). Follow it from the beginning for a new account.

## Agent configuration

Codex:

```bash
read -rsp 'Codex mailbox token: ' AGENTS_MAIL_CODEX_TOKEN
echo
export AGENTS_MAIL_CODEX_TOKEN
codex mcp add agents_mail \
  --url https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/mcp \
  --bearer-token-env-var AGENTS_MAIL_CODEX_TOKEN
```

Hermes:

For Hermes's default profile, place the YAML in `~/.hermes/config.yaml` and provide `AGENTS_MAIL_HERMES_TOKEN` through an owner-readable `~/.hermes/.env` file.

```yaml
mcp_servers:
  agents_mail:
    url: "https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/mcp"
    headers:
      Authorization: "Bearer ${AGENTS_MAIL_HERMES_TOKEN}"
    tools:
      resources: false
      prompts: false
```

Codex and Hermes are optional clients; this repository does not install either one. Restart an installed agent after changing its environment or MCP configuration. Any compatible Streamable HTTP MCP client can use the endpoint with one of the two bearer credentials.

## Cost

At low message volume, this design is expected to fit within Cloudflare's free allowances: Email Routing is free, and Workers, D1, R2, and Queues each have free usage tiers. R2 is metered beyond its allowance rather than hard-capped at $0. Check the current [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/), and [Queues](https://developers.cloudflare.com/queues/platform/pricing/) pricing before deploying.

Outbound delivery is intentionally disabled. Cloudflare's arbitrary-recipient sending path requires a Workers Paid plan; see [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/).

## Development

```bash
npm run typecheck
npm run lint
npm test
npm run dry-run
npm run startup-check
```

The integration suite runs the real Worker handlers against Wrangler's local D1, R2, Queue, and MCP implementations. It does not introduce a mock boundary.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for constraints and tradeoffs and [docs/OPERATIONS.md](docs/OPERATIONS.md) for the runbook.
