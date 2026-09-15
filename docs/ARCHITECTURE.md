# Architecture

One Cloudflare Worker handles incoming email, queued parsing jobs, and authenticated HTTP requests. The surrounding Cloudflare services store the original message and its parsed record.

## Scope

This project serves a shared inbox for addresses on one domain to software agents through Model Context Protocol (MCP), a standard interface for tools and data. It preserves each original message, extracts a small set of useful fields, and tracks which agent claimed the work.

The project has no webmail screen, mailbox administration screen, spam classifier, outbound campaign service, or automatic recovery command.

## Message path

| Component | Job |
| --- | --- |
| Email Routing | Sends each explicitly configured address to the Worker. Routing rules define the active addresses. |
| Worker email handler | Checks that the envelope recipient—the address used for delivery—belongs to the exact `MAILBOX_DOMAIN`, then writes the original message to R2. |
| R2 | Stores a `.eml` file under `raw/YYYY-MM-DD/<uuid>.eml`. The file keeps the message headers, content parts, and attachments; public bucket access should stay off. |
| Queue | The inbound handler sends a parsing job before it returns. A separate Queue consumer handles the job. Processing exceptions receive up to three retries. |
| Worker queue handler | Decodes the email with PostalMime, the project's parsing library, and writes selected fields to D1. |
| D1 | Stores message fields, thread fields, work status, claim owner, and claim times. |
| `/mcp` endpoint | Authenticates each request and exposes five mailbox tools over Streamable HTTP. |

```text
email -> Worker -> R2 -> Queue -> Worker -> D1 -> /mcp -> agent
```

## Address routing and filtering

Configure `MAILBOX_DOMAIN` once. Add addresses with exact Email Routing rules targeting this Worker; no application allowlist or redeployment is needed. Keep catch-all and automatic subaddressing off. Enabling either broadens the addresses Cloudflare routes to the Worker. The Worker accepts any recipient routed to it on the configured domain, and rejects other domains, including subdomains.

`list_messages` and `claim_next_message` accept an optional full `address`. Matching uses `envelope_to` with SQLite `COLLATE NOCASE`; the original address casing remains stored. It does not use the message's `To` header, so Bcc delivery and headers naming a different address are handled correctly. Without a filter, the tools include all addresses. A valid address with no matching records yields an empty result.

Message summaries expose `envelopeTo`. Both authenticated identities can read every address, including by message ID. Filters select work, not permissions. Disabling a routing rule stops new delivery through that rule but does not hide or delete stored mail.

## Message state and claim ownership

```text
new -> claimed -> completed

parse failure -> error
```

`claim_next_message` runs one `UPDATE ... RETURNING` statement in D1. It selects the oldest `new` message or a `claimed` message whose 30-minute claim has expired, restricted to the requested address when supplied. The address condition applies to both new and expired claims. An expired row keeps the `claimed` status until the next claim overwrites its owner and times. The first owner may still complete it before another agent takes the claim.

The bearer credential identifies the actor as `codex` or `hermes`. A name supplied by a client cannot change claim ownership.

## Stored data and limits

| Store | Contents | Limit |
| --- | --- | --- |
| D1 | Envelope addresses, sender, reply address, subject, message IDs, thread ID, dates, plain text, HTTP(S) links, parse result, and claim state. | Body text is cut at 500,000 characters. Link extraction stops at 200. |
| R2 | Complete original message in `.eml` form, including attachments. | The MCP tools do not expose raw objects. |

Messages larger than 5 MiB stay in R2 and receive an `error` row; the queue handler does not load them into memory. Cloudflare rejects inbound mail above its 25 MiB platform limit before the Worker runs. For messages at or below 5 MiB, the Worker computes a SHA-256 content fingerprint from the raw bytes. The database suppresses a second normalized row only when the fingerprint and delivery address match, ignoring address capitalization. Identical content delivered to different addresses produces independently claimable records. Delivery servers may add headers such as `Received`, which changes the raw bytes and fingerprint. Oversized messages have no fingerprint, so repeated delivery may produce more than one `error` row. See [Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/).

Migration `0002_multi_address.sql` replaces the original global fingerprint constraint with a unique address-and-fingerprint index. It rebuilds the table while copying all existing fields unchanged, then recreates the original indexes and adds indexes for address filtering. R2 keys, message IDs, claim state, and thread fields survive the upgrade.

## Threaded replies

The parser stores `Message-ID`, `In-Reply-To`, and `References`. `reply_to_message` addresses the stored `Reply-To`, then `From`, then envelope sender. It uses the stored delivery recipient as the reply's `from` address and constructs `In-Reply-To` and `References` headers from the source message.

The current MCP server prepares that reply and returns `OUTBOUND_DISABLED`; it never passes an email sender to the tool. Turning on delivery requires a code change that supplies a sender, a `send_email` binding, `OUTBOUND_EMAIL_ENABLED=true`, and Cloudflare's paid path for mail to arbitrary recipients. Changing the flag or binding alone does not send mail.

## Authentication and untrusted input

The Worker stores two bearer-token secrets. It hashes the supplied token and both configured tokens, then uses a comparison whose runtime does not depend on the first differing byte. Missing or identical configured secrets return a configuration error without mailbox data.

The public `/health` route reports only the service name and process response. It does not test D1, R2, the Queue, Email Routing, or either credential. `/mcp` requires authentication. The application exposes no R2 object route or public D1 route. Keep R2 public access off. The project exposes no browser inbox.

Email bodies, headers, and links may contain hostile instructions. Successful MCP results that carry message data repeat a warning to treat those fields as data.

## Known gaps and chosen limits

| Condition | Result | Current response |
| --- | --- | --- |
| R2 write succeeds and Queue submission fails | A raw object has no parsing job. | The 180-day lifecycle rule in the setup guide removes it after the operator installs that rule. There is no automatic replay. |
| Byte-identical raw content arrives more than once at the same address | Each delivery writes a raw object. | The address-and-content hash index suppresses a second normalized row for content at or below 5 MiB. If installed, the lifecycle rule later removes extra raw objects. |
| Normalized records age | D1 rows continue to accumulate. | D1 has no automatic deletion policy. Add one after choosing a retention requirement. |

[R2 event notifications](https://developers.cloudflare.com/r2/buckets/event-notifications/) can send a Queue event after an object changes. They could remove the gap between the file write and Queue submission, but they would add another deployment path and more test work. The present design keeps that tradeoff visible.
