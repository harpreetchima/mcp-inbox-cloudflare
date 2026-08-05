# Architecture

One Cloudflare Worker handles incoming email, queued parsing jobs, and authenticated HTTP requests. The surrounding Cloudflare services store the original message and its parsed record.

## Scope

This project serves one mailbox to software agents through Model Context Protocol (MCP), a standard interface for tools and data. It preserves each original message, extracts a small set of useful fields, and tracks which agent claimed the work.

The project has no webmail screen, mailbox administration screen, spam classifier, outbound campaign service, or automatic recovery command.

## Message path

| Component | Job |
| --- | --- |
| Email Routing | Sends one configured address to the Worker. |
| Worker email handler | Checks the envelope recipient—the address used for delivery—and writes the original message to R2. |
| R2 | Stores a `.eml` file under `raw/YYYY-MM-DD/<uuid>.eml`. The file keeps the message headers, content parts, and attachments; public bucket access should stay off. |
| Queue | The inbound handler sends a parsing job before it returns. A separate Queue consumer handles the job. Processing exceptions receive up to three retries. |
| Worker queue handler | Decodes the email with PostalMime, the project's parsing library, and writes selected fields to D1. |
| D1 | Stores message fields, thread fields, work status, claim owner, and claim times. |
| `/mcp` endpoint | Authenticates each request and exposes five mailbox tools over Streamable HTTP. |

```text
email -> Worker -> R2 -> Queue -> Worker -> D1 -> /mcp -> agent
```

## Message state and claim ownership

```text
new -> claimed -> completed

parse failure -> error
```

`claim_next_message` runs one `UPDATE ... RETURNING` statement in D1. It selects the oldest `new` message or a `claimed` message whose 30-minute claim has expired. An expired row keeps the `claimed` status until the next claim overwrites its owner and times. The first owner may still complete it before another agent takes the claim.

The bearer credential identifies the actor as `codex` or `hermes`. A name supplied by a client cannot change claim ownership.

## Stored data and limits

| Store | Contents | Limit |
| --- | --- | --- |
| D1 | Envelope addresses, sender, reply address, subject, message IDs, thread ID, dates, plain text, HTTP(S) links, parse result, and claim state. | Body text is cut at 500,000 characters. Link extraction stops at 200. |
| R2 | Complete original message in `.eml` form, including attachments. | The MCP tools do not expose raw objects. |

Messages larger than 5 MiB stay in R2 and receive an `error` row; the queue handler does not load them into memory. Cloudflare rejects inbound mail above its 25 MiB platform limit before the Worker runs. For messages at or below 5 MiB, the Worker computes a SHA-256 content fingerprint from the raw bytes. The database suppresses a second normalized row only when that fingerprint is identical. Delivery servers may add headers such as `Received`, which changes the raw bytes and fingerprint. Oversized messages have no fingerprint, so repeated delivery may produce more than one `error` row. See [Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/).

## Threaded replies

The parser stores `Message-ID`, `In-Reply-To`, and `References`. `reply_to_message` addresses the stored `Reply-To`, then `From`, then envelope sender. It constructs `In-Reply-To` and `References` headers from the source message.

The current MCP server prepares that reply and returns `OUTBOUND_DISABLED`; it never passes an email sender to the tool. Turning on delivery requires a code change that supplies a sender, a `send_email` binding, `OUTBOUND_EMAIL_ENABLED=true`, and Cloudflare's paid path for mail to arbitrary recipients. Changing the flag or binding alone does not send mail.

## Authentication and untrusted input

The Worker stores two bearer-token secrets. It hashes the supplied token and both configured tokens, then uses a comparison whose runtime does not depend on the first differing byte. Missing or identical configured secrets return a configuration error without mailbox data.

The public `/health` route reports only the service name and process response. It does not test D1, R2, the Queue, Email Routing, or either credential. `/mcp` requires authentication. The application exposes no R2 object route or public D1 route. Keep R2 public access off. The project exposes no browser inbox.

Email bodies, headers, and links may contain hostile instructions. Successful MCP results that carry message data repeat a warning to treat those fields as data.

## Known gaps and chosen limits

| Condition | Result | Current response |
| --- | --- | --- |
| R2 write succeeds and Queue submission fails | A raw object has no parsing job. | The 180-day lifecycle rule in the setup guide removes it after the operator installs that rule. There is no automatic replay. |
| Byte-identical raw content arrives more than once | Each delivery writes a raw object. | The content hash suppresses a second normalized row for content at or below 5 MiB. If installed, the lifecycle rule later removes extra raw objects. |
| Normalized records age | D1 rows continue to accumulate. | D1 has no automatic deletion policy. Add one after choosing a retention requirement. |

[R2 event notifications](https://developers.cloudflare.com/r2/buckets/event-notifications/) can send a Queue event after an object changes. They could remove the gap between the file write and Queue submission, but they would add another deployment path and more test work. The present design keeps that tradeoff visible.
