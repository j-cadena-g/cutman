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

export function magicLinkEmail(input: { appName?: string; url: string }): { subject: string; text: string } {
  const appName = input.appName ?? "Cutman";
  return {
    subject: `Sign in to ${appName}`,
    text: `Tap this link to sign in. It expires in 15 minutes.\n\n${input.url}\n\nIf you did not ask for this, ignore it.`,
  };
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
