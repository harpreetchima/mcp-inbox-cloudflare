# MCP Inbox for Cloudflare

Email sent to one address becomes a private work queue that Codex, Hermes, or another software agent can read through Model Context Protocol (MCP). Cloudflare receives and stores each accepted message, then parses messages within the project's size limit.

You deploy this project in your own Cloudflare account. The inbox stays live without a local computer; an agent must run when you want it to act on mail. This is not a hosted service or webmail application.

## What you get

- Email Routing sends one exact address to the Worker.
- R2 stores each original email as an `.eml` file, including its headers and attachments; public bucket access should stay off.
- D1 records structured message fields and work status.
- A Cloudflare Queue schedules parsing after the original email has been stored.
- The MCP endpoint exposes five authenticated tools for reading and processing mail.
- The reply tool prepares text with standard email thread headers. The current version does not send it.

Cloudflare exposes service settings and logs in its dashboard. This project does not include a human inbox screen.

## How a message moves

```text
Internet email
    -> Email Routing: sends one exact address to the Worker
    -> R2: stores the original .eml file
    -> Queue: schedules parsing
    -> D1: stores message text, links, thread fields, and work status
    -> /mcp: serves authenticated requests from an agent
```

A Worker is Cloudflare code that runs on demand. R2 stores files, D1 stores structured records, and a Queue holds work until the Worker processes it.

## What agents can do

| MCP tool | Action |
| --- | --- |
| `list_messages` | List recent messages, with an optional status filter. |
| `get_message` | Read one message by its internal ID. |
| `claim_next_message` | Reserve the oldest available message for the authenticated agent. |
| `complete_message` | Mark a message complete when that agent holds its claim. |
| `reply_to_message` | Prepare a reply and add `In-Reply-To` or `References` when the source message supplies the needed IDs. |

### Claims

A claim lasts 30 minutes. Expiry makes the message eligible for another claim; it does not change the row on a timer. The first agent may still complete it until another agent takes the claim. The secret bearer token sent with the request identifies the agent; a client cannot choose its identity in the request.

### Treat email as untrusted data

Email comes from people and systems outside your Cloudflare account. Every tool that returns email content labels the body, headers, and links as untrusted data rather than agent instructions.

## Set up an inbox

You need Node.js `^22.18.0` or `>=24.11.0`, a Cloudflare account, an active R2 subscription, and a domain that uses Cloudflare DNS. `package.json` is the authority for the Node.js range.

Before changing mail records, check whether the domain receives mail through another provider. Cloudflare Email Routing changes the domain's MX records, which name the servers that receive its mail. Use a dedicated subdomain or another domain when the existing provider must keep receiving mail.

Start by checking the repository:

```bash
npm ci
npx wrangler login
npx wrangler whoami
npm run check
```

Then follow [Self-hosting on Cloudflare](docs/CLOUDFLARE_SETUP.md). It covers resource creation, credentials, mail routing, client configuration, and a real-message test.

## Connect an agent

The deployed endpoint uses Streamable HTTP, an MCP transport carried over ordinary HTTPS:

```text
https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/mcp
```

Each request needs one of the two bearer credentials stored as Worker secrets. Codex and Hermes are optional clients; this repository does not install them. Any compatible MCP client may use the endpoint.

The setup guide contains configuration examples for [Codex and Hermes](docs/CLOUDFLARE_SETUP.md#11-connect-an-mcp-client).

## Cost

Low message volume may remain inside Cloudflare's free quotas, but this is an estimate rather than a price guarantee. Message count, message size, retention, and changes to Cloudflare pricing affect the bill. R2 requires activation and charges for usage above its allowance.

Check Cloudflare's current [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/), and [Queues](https://developers.cloudflare.com/queues/platform/pricing/) prices before deployment.

Inbound mail does not require Workers Paid. Sending to arbitrary recipients uses a separate paid path; this project leaves it off. See [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/).

## Work on the project

```bash
npm run typecheck
npm run lint
npm test
npm run dry-run
npm run startup-check
```

The integration tests call the real Worker handlers against Wrangler's local implementations of D1, R2, Queues, and MCP. They do not contact production services.

Read [Architecture](docs/ARCHITECTURE.md) for design limits and [Operations](docs/OPERATIONS.md) for diagnosis, credential rotation, retention, and deployment checks.
