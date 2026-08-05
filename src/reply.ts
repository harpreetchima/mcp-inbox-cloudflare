import type { StoredMessage } from "./model";

function replySubject(subject: string): string {
  if (/^\s*re:/iu.test(subject)) return subject;
  return `Re: ${subject || "(no subject)"}`;
}

export function buildThreadedReply(
  source: StoredMessage,
  from: string,
  text: string
): EmailMessageBuilder {
  const to = source.replyTo ?? source.fromAddress ?? source.envelopeFrom;
  const references = [...source.references];
  if (source.messageId && !references.includes(source.messageId)) {
    references.push(source.messageId);
  }
  const headers: Record<string, string> = {};
  if (source.messageId) headers["In-Reply-To"] = source.messageId;
  if (references.length > 0) headers.References = references.join(" ");

  return {
    from,
    to,
    subject: replySubject(source.subject),
    text,
    headers
  };
}

export async function sendThreadedReply(
  sender: SendEmail,
  reply: EmailMessageBuilder
): Promise<EmailSendResult> {
  return sender.send(reply);
}
