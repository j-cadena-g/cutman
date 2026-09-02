import { describe, expect, it } from "vitest";
import { recapEmail, sendEmail, type EmailBinding } from "./index.ts";

describe("email sending", () => {
  it("refuses a blank recap", async () => {
    const email: EmailBinding = {
      async send() {
        throw new Error("should not send");
      },
    };
    await expect(
      sendEmail(email, { from: "brain@example.test", to: "manager@example.test", subject: "  ", text: "" }),
    ).rejects.toThrow(/blank/i);
  });

  it("sends a dressed recap through EMAIL.send", async () => {
    const sent: unknown[] = [];
    const email: EmailBinding = {
      async send(message) {
        sent.push(message);
        return { messageId: "m1" };
      },
    };
    const recap = recapEmail({ subject: "Week 3 belongs to James", body: "CeeDee changed hands." });
    await sendEmail(email, { from: "brain@example.test", to: "manager@example.test", ...recap });
    expect(sent).toHaveLength(1);
  });
});
