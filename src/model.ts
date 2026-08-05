export type Actor = "codex" | "hermes";

export type MessageStatus = "new" | "claimed" | "completed" | "error";

export interface IngestJob {
  id: string;
  rawKey: string;
  rawSize: number;
  envelopeFrom: string;
  envelopeTo: string;
  receivedAt: string;
}

export interface StoredMessage {
  id: string;
  envelopeFrom: string;
  envelopeTo: string;
  fromName: string | null;
  fromAddress: string | null;
  replyTo: string | null;
  subject: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  threadId: string;
  sentAt: string | null;
  receivedAt: string;
  bodyText: string;
  links: string[];
  status: MessageStatus;
  claimedBy: Actor | null;
  claimedAt: string | null;
  claimExpiresAt: string | null;
  completedAt: string | null;
  parseError: string | null;
}
