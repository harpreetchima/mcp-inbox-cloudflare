# Agents Mail on Cloudflare

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

Requirements: Node.js 22 or newer, a Cloudflare account, and a domain using Cloudflare DNS.

```bash
npm install
npx wrangler login
npm run check
npm run deploy
npx wrangler d1 migrations apply DB --remote
npx wrangler secret put MCP_CODEX_TOKEN
npx wrangler secret put MCP_HERMES_TOKEN
```

Before deployment, replace `agents@example.com` in `wrangler.jsonc` with the one address you intend to receive. Use two different, high-entropy bearer tokens. Do not commit them to the repository.

Then enable Email Routing for the domain and create one exact-address route whose action is the deployed Worker. Keep catch-all routing disabled unless broad domain intake is intentional. The complete sequence is in [docs/CLOUDFLARE_SETUP.md](docs/CLOUDFLARE_SETUP.md).

## Agent configuration

Codex:

```bash
export AGENTS_MAIL_CODEX_TOKEN='replace-with-a-long-random-token'
codex mcp add agents_mail \
  --url https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/mcp \
  --bearer-token-env-var AGENTS_MAIL_CODEX_TOKEN
```

Hermes:

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

Restart the agent after changing its environment or MCP configuration.

## Cost

At low message volume, this design is expected to fit within Cloudflare's free allowances: Email Routing is free, and Workers, D1, R2, and Queues each have free usage tiers. Check the current [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/), and [Queues](https://developers.cloudflare.com/queues/platform/pricing/) pricing before deploying.

Outbound delivery is intentionally disabled. Cloudflare's arbitrary-recipient sending path requires a Workers Paid plan; see [Send emails from Workers](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/).

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
