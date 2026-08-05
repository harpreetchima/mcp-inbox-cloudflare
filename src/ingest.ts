import PostalMime, { type Address, type Email, type Mailbox } from "postal-mime";
import { z } from "zod";
import type { IngestJob } from "./model";

const MAX_PARSE_BYTES = 5 * 1024 * 1024;
const MAX_BODY_CHARS = 500_000;
const MAX_LINKS = 200;

const ingestJobSchema = z.object({
  id: z.uuid(),
  rawKey: z.string().startsWith("raw/"),
  rawSize: z.number().int().nonnegative(),
  envelopeFrom: z.string(),
  envelopeTo: z.string(),
  receivedAt: z.iso.datetime()
});

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function firstMailbox(address: Address | undefined): Mailbox | null {
  if (!address) return null;
  if (typeof address.address === "string") return address;
  return address.group?.[0] ?? null;
}

function firstMailboxFromList(addresses: Address[] | undefined): Mailbox | null {
  for (const address of addresses ?? []) {
    const mailbox = firstMailbox(address);
    if (mailbox) return mailbox;
  }
  return null;
}

function normalizeMessageId(value: string | undefined): string | null {
  if (!value) return null;
  const bracketed = /<[^<>\s\r\n]+>/.exec(value)?.[0];
  if (bracketed) return bracketed;
  const bare = value.trim();
  return /^[^<>\s\r\n]+@[^<>\s\r\n]+$/.test(bare) ? `<${bare}>` : null;
}

function normalizeReferences(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.match(/<[^<>\s\r\n]+>/g) ?? [])];
}

function normalizeDate(value: string | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function extractLinks(text: string, html: string): string[] {
  const candidates = `${text}\n${html}`.match(/https?:\/\/[^\s"'<>]+/giu) ?? [];
  const links: string[] = [];
  for (const candidate of candidates) {
    const cleaned = candidate.replaceAll("&amp;", "&").replace(/[),.;!?]+$/u, "");
    try {
      const url = new URL(cleaned);
      if ((url.protocol === "http:" || url.protocol === "https:") && !links.includes(url.href)) {
        links.push(url.href);
      }
    } catch {
      // Ignore malformed strings that only resemble URLs.
    }
    if (links.length === MAX_LINKS) break;
  }
  return links;
}

function parseErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/<(?:br|\/(?:div|h[1-6]|li|p|tr))\b[^>]*>/giu, "\n")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&(?:nbsp|#160|#xA0);/giu, " ")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&amp;/giu, "&")
    .replace(/[ \t]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

async function insertParsedMessage(
  env: Env,
  job: IngestJob,
  email: Email,
  rawSha256: string
): Promise<void> {
  const from = firstMailbox(email.from);
  const replyTo = firstMailboxFromList(email.replyTo);
  const messageId = normalizeMessageId(email.messageId);
  const inReplyTo = normalizeMessageId(email.inReplyTo);
  const references = normalizeReferences(email.references);
  const bodyText = (email.text ?? htmlToText(email.html ?? "")).trim().slice(0, MAX_BODY_CHARS);
  const links = extractLinks(bodyText, email.html ?? "");
  const threadId = references[0] ?? inReplyTo ?? messageId ?? job.id;

  await env.DB.prepare(
    `INSERT OR IGNORE INTO messages (
       id, raw_key, raw_sha256, envelope_from, envelope_to, from_name,
       from_address, reply_to, subject, message_id, in_reply_to,
       references_json, thread_id, sent_at, received_at, body_text, links_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      job.id,
      job.rawKey,
      rawSha256,
      job.envelopeFrom,
      job.envelopeTo,
      from?.name || null,
      from?.address || null,
      replyTo?.address || null,
      email.subject ?? "",
      messageId,
      inReplyTo,
      JSON.stringify(references),
      threadId,
      normalizeDate(email.date),
      job.receivedAt,
      bodyText,
      JSON.stringify(links)
    )
    .run();
}

async function insertParseError(
  env: Env,
  job: IngestJob,
  error: string,
  rawSha256: string | null
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO messages (
       id, raw_key, raw_sha256, envelope_from, envelope_to, thread_id,
       received_at, status, parse_error
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'error', ?)`
  )
    .bind(
      job.id,
      job.rawKey,
      rawSha256,
      job.envelopeFrom,
      job.envelopeTo,
      job.id,
      job.receivedAt,
      error
    )
    .run();
}

export async function processIngest(job: IngestJob, env: Env): Promise<void> {
  if (job.rawSize > MAX_PARSE_BYTES) {
    await insertParseError(env, job, `Message exceeds the ${MAX_PARSE_BYTES}-byte parsing limit`, null);
    return;
  }

  const object = await env.RAW_EMAILS.get(job.rawKey);
  if (!object) throw new Error(`Raw message ${job.id} is missing`);
  const raw = await object.arrayBuffer();
  const rawSha256 = toHex(await crypto.subtle.digest("SHA-256", raw));

  let email: Email;
  try {
    email = await PostalMime.parse(raw);
  } catch (error) {
    await insertParseError(env, job, parseErrorMessage(error), rawSha256);
    return;
  }
  await insertParsedMessage(env, job, email, rawSha256);
}

export async function handleIncomingEmail(
  message: ForwardableEmailMessage,
  env: Env
): Promise<void> {
  if (message.to.toLowerCase() !== env.MAILBOX_ADDRESS.toLowerCase()) {
    message.setReject("Unknown mailbox");
    return;
  }

  const id = crypto.randomUUID();
  const receivedAt = new Date().toISOString();
  const date = receivedAt.slice(0, 10);
  const rawKey = `raw/${date}/${id}.eml`;
  const job: IngestJob = {
    id,
    rawKey,
    rawSize: message.rawSize,
    envelopeFrom: message.from,
    envelopeTo: message.to,
    receivedAt
  };

  const fixedLength = new FixedLengthStream(message.rawSize);
  await Promise.all([
    message.raw.pipeTo(fixedLength.writable),
    env.RAW_EMAILS.put(rawKey, fixedLength.readable, {
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: { receivedAt }
    })
  ]);
  await env.INGEST_QUEUE.send(job);
  console.log(JSON.stringify({ event: "email_accepted", id, rawSize: message.rawSize }));
}

export async function handleQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const parsed = ingestJobSchema.safeParse(message.body);
    if (!parsed.success) {
      console.error(JSON.stringify({ event: "invalid_ingest_job", queueMessageId: message.id }));
      message.ack();
      continue;
    }

    try {
      await processIngest(parsed.data, env);
      message.ack();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "ingest_failed",
          id: parsed.data.id,
          error: parseErrorMessage(error),
          attempt: message.attempts
        })
      );
      message.retry();
    }
  }
}
