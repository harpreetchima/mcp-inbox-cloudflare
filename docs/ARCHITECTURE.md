# Architecture

## Scope

The service is a single-purpose inbox for software agents. It receives mail, preserves the original, normalizes a small useful subset, and exposes work through authenticated MCP tools. It does not provide a webmail UI, mailbox administration UI, spam-classification system, or outbound campaign service.

## Components

- **Email Routing** accepts an exact configured address and invokes the Worker.
- **Worker email handler** validates the envelope recipient and streams the original message to R2.
- **R2** stores private RFC 822 source messages under `raw/YYYY-MM-DD/<uuid>.eml`.
- **Queue** separates SMTP acceptance from parsing and retries transient failures.
- **Worker queue handler** parses messages with PostalMime and writes normalized fields to D1.
- **D1** stores message metadata, text, links, state, ownership, and threading identifiers.
- **Stateless MCP endpoint** authenticates each request and offers five mailbox tools.

## Message state

```text
new -> claimed -> completed
         |
         +-> new after the 30-minute lease expires and another agent claims it

parse failure -> error
```

Claiming is one `UPDATE ... RETURNING` statement in D1. The authenticated bearer token, not a client-provided name, determines whether the actor is `codex` or `hermes`.

## Stored fields

D1 contains envelope addresses, sender and reply address, subject, normalized message IDs, references, thread ID, timestamp, plain-text body, extracted HTTP(S) links, parse status, and claim state. Body text is capped at 500,000 characters and extracted links at 200.

R2 retains the complete raw message, including MIME structure and attachments. Raw objects are not exposed through MCP in this version. Messages larger than 5 MiB remain in R2 but receive an `error` row instead of being parsed into memory.

## Threading and replies

The parser stores `Message-ID`, `In-Reply-To`, and `References`. `reply_to_message` chooses the stored `Reply-To`, then `From`, then envelope sender, and builds `In-Reply-To` and `References` headers.

The default deployment has no `send_email` binding and sets `OUTBOUND_EMAIL_ENABLED=false`. The send function exists for a later paid deployment, but the current tool returns the prepared reply without transmitting it.

## Authentication and trust boundary

There are two independent bearer-token secrets. The Worker hashes the provided and configured values and uses timing-safe comparison. Missing or identical configured tokens fail closed.

The health endpoint is public. `/mcp` requires authentication. R2 is private, D1 is not publicly reachable, and the project exposes no browser inbox.

Email bodies, headers, and links are adversarial input. Tool descriptions and results explicitly label them as untrusted data.

## Deliberate tradeoffs

The inbound handler writes R2 and then enqueues a parsing task. If R2 succeeds but Queue submission fails, the raw object can be orphaned. R2 event notifications could close this dual-write gap, but add deployment and local-test complexity. The current design favors the smallest reproducible system; the production lifecycle rule eventually removes an orphan.

Duplicate deliveries may create more than one raw object, but the unique raw SHA-256 constraint prevents duplicate normalized D1 messages. The extra raw objects expire under the lifecycle policy.

Normalized D1 rows currently have no automatic retention policy. Add one only when a concrete retention requirement is known.
