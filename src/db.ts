import { z } from "zod";
import type { Actor, MessageStatus, StoredMessage } from "./model";

const stringArraySchema = z.array(z.string());

interface MessageRow {
  id: string;
  envelope_from: string;
  envelope_to: string;
  from_name: string | null;
  from_address: string | null;
  reply_to: string | null;
  subject: string;
  message_id: string | null;
  in_reply_to: string | null;
  references_json: string;
  thread_id: string;
  sent_at: string | null;
  received_at: string;
  body_text: string;
  links_json: string;
  status: MessageStatus;
  claimed_by: Actor | null;
  claimed_at: string | null;
  claim_expires_at: string | null;
  completed_at: string | null;
  parse_error: string | null;
}

const columns = `
  id, envelope_from, envelope_to, from_name, from_address, reply_to,
  subject, message_id, in_reply_to, references_json, thread_id, sent_at,
  received_at, body_text, links_json, status, claimed_by, claimed_at,
  claim_expires_at, completed_at, parse_error
`;

function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  return stringArraySchema.parse(parsed);
}

function fromRow(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    envelopeFrom: row.envelope_from,
    envelopeTo: row.envelope_to,
    fromName: row.from_name,
    fromAddress: row.from_address,
    replyTo: row.reply_to,
    subject: row.subject,
    messageId: row.message_id,
    inReplyTo: row.in_reply_to,
    references: parseStringArray(row.references_json),
    threadId: row.thread_id,
    sentAt: row.sent_at,
    receivedAt: row.received_at,
    bodyText: row.body_text,
    links: parseStringArray(row.links_json),
    status: row.status,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    claimExpiresAt: row.claim_expires_at,
    completedAt: row.completed_at,
    parseError: row.parse_error
  };
}

export async function listMessages(
  db: D1Database,
  status: MessageStatus | undefined,
  limit: number,
  address?: string
): Promise<StoredMessage[]> {
  const filters: string[] = [];
  const values: Array<string | number> = [];
  if (status) {
    filters.push("status = ?");
    values.push(status);
  }
  if (address !== undefined) {
    filters.push("envelope_to = ? COLLATE NOCASE");
    values.push(address);
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const statement = db
    .prepare(`SELECT ${columns} FROM messages ${where} ORDER BY received_at DESC, id DESC LIMIT ?`)
    .bind(...values, limit);
  const result = await statement.all<MessageRow>();
  return result.results.map(fromRow);
}

export async function getMessage(
  db: D1Database,
  id: string
): Promise<StoredMessage | null> {
  const row = await db
    .prepare(`SELECT ${columns} FROM messages WHERE id = ?`)
    .bind(id)
    .first<MessageRow>();
  return row ? fromRow(row) : null;
}

export async function claimNextMessage(
  db: D1Database,
  actor: Actor,
  address?: string,
  now = new Date(),
  leaseSeconds = 30 * 60
): Promise<StoredMessage | null> {
  const nowIso = now.toISOString();
  const expiresIso = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
  const addressFilter = address === undefined ? "" : "AND envelope_to = ? COLLATE NOCASE";
  const values = [actor, nowIso, expiresIso, nowIso];
  if (address !== undefined) values.push(address);
  const row = await db
    .prepare(
      `UPDATE messages
       SET status = 'claimed', claimed_by = ?, claimed_at = ?, claim_expires_at = ?
       WHERE id = (
         SELECT id FROM messages
         WHERE (status = 'new'
            OR (status = 'claimed' AND claim_expires_at <= ?))
           ${addressFilter}
         ORDER BY received_at ASC, id ASC
         LIMIT 1
       )
       RETURNING ${columns}`
    )
    .bind(...values)
    .first<MessageRow>();
  return row ? fromRow(row) : null;
}

export async function completeMessage(
  db: D1Database,
  id: string,
  actor: Actor,
  now = new Date()
): Promise<StoredMessage | null> {
  const row = await db
    .prepare(
      `UPDATE messages
       SET status = 'completed', completed_at = ?, claim_expires_at = NULL
       WHERE id = ? AND status = 'claimed' AND claimed_by = ?
       RETURNING ${columns}`
    )
    .bind(now.toISOString(), id, actor)
    .first<MessageRow>();
  return row ? fromRow(row) : null;
}
