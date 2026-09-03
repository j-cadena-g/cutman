export type SendEmailResult = { messageId?: string };

export type EmailBinding = {
  send: (message: {
    from: string;
    to: string | string[];
    subject: string;
    text?: string;
    html?: string;
  }) => Promise<SendEmailResult>;
};

export const EMAIL_FROM = "Cutman <hello@mail.cutman.io>";

export async function sendEmail(
  email: EmailBinding,
  message: { from: string; to: string | string[]; subject: string; text: string; html?: string },
): Promise<SendEmailResult> {
  if (!message.subject.trim() || !message.text.trim()) {
    throw new Error("Refusing to send a blank email");
  }
  return email.send({
    from: message.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html ?? `<pre>${escapeHtml(message.text)}</pre>`,
  });
}

export function recapEmail(input: { subject: string; body: string }): { subject: string; text: string } {
  return { subject: input.subject.trim(), text: input.body.trim() };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
