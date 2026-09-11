import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";

/**
 * OTP delivery. One interface, several providers — chosen by `OTP_PROVIDER`,
 * the same mock-or-real pattern the Razorpay service uses, so local dev needs
 * zero external keys while production must name a real provider.
 *
 * Delivery never leaks the code into logs outside development.
 */
export interface OtpDeliveryResult {
  delivered: boolean;
  provider: string;
  /** Provider-side id, when the provider returns one (for support/debugging). */
  messageId?: string;
  /** Set when delivery failed; the caller decides whether that is fatal. */
  error?: string;
}

export interface OtpSender {
  readonly name: string;
  send(params: {
    identifier: string;
    channel: "phone" | "email";
    code: string;
    ttlSeconds: number;
  }): Promise<OtpDeliveryResult>;
}

/** Dev/test sender: logs the code, never calls out. */
class ConsoleSender implements OtpSender {
  readonly name = "console";
  async send(p: {
    identifier: string;
    channel: "phone" | "email";
    code: string;
  }): Promise<OtpDeliveryResult> {
    logger.info("DEV OTP issued", { identifier: p.identifier, code: p.code });
    return { delivered: true, provider: this.name };
  }
}

/** MSG91 — India-first SMS (cheapest for the pilot zone). */
class Msg91Sender implements OtpSender {
  readonly name = "msg91";
  async send(p: { identifier: string; code: string }): Promise<OtpDeliveryResult> {
    const { authKey, templateId, senderId } = env.otp.msg91;
    try {
      const resp = await fetch("https://control.msg91.com/api/v5/otp", {
        method: "POST",
        headers: { authkey: authKey, "content-type": "application/json" },
        body: JSON.stringify({
          template_id: templateId,
          sender: senderId,
          mobile: normalizeIndianMobile(p.identifier),
          otp: p.code,
        }),
      });
      const body = (await resp.json().catch(() => ({}))) as { type?: string; message?: string };
      if (!resp.ok || body.type === "error") {
        return { delivered: false, provider: this.name, error: body.message ?? `HTTP ${resp.status}` };
      }
      return { delivered: true, provider: this.name, messageId: body.message };
    } catch (e) {
      return { delivered: false, provider: this.name, error: (e as Error).message };
    }
  }
}

/** Twilio — SMS fallback / non-India numbers. */
class TwilioSender implements OtpSender {
  readonly name = "twilio";
  async send(p: { identifier: string; code: string; ttlSeconds: number }): Promise<OtpDeliveryResult> {
    const { accountSid, authToken, fromNumber } = env.otp.twilio;
    const minutes = Math.round(p.ttlSeconds / 60);
    try {
      const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
      const resp = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            authorization: `Basic ${auth}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            To: p.identifier.startsWith("+") ? p.identifier : `+91${p.identifier}`,
            From: fromNumber,
            Body: `${p.code} is your SEIKA login code. Valid ${minutes} min. Do not share it.`,
          }),
        }
      );
      const body = (await resp.json().catch(() => ({}))) as { sid?: string; message?: string };
      if (!resp.ok) {
        return { delivered: false, provider: this.name, error: body.message ?? `HTTP ${resp.status}` };
      }
      return { delivered: true, provider: this.name, messageId: body.sid };
    } catch (e) {
      return { delivered: false, provider: this.name, error: (e as Error).message };
    }
  }
}

/** Resend — email OTP (staff logins are usually email). */
class ResendSender implements OtpSender {
  readonly name = "resend";
  async send(p: { identifier: string; code: string; ttlSeconds: number }): Promise<OtpDeliveryResult> {
    const { apiKey, fromEmail } = env.otp.resend;
    const minutes = Math.round(p.ttlSeconds / 60);
    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: fromEmail,
          to: [p.identifier],
          subject: `${p.code} — your SEIKA login code`,
          text: `Your SEIKA login code is ${p.code}. It is valid for ${minutes} minutes. If you did not request it, ignore this email.`,
        }),
      });
      const body = (await resp.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!resp.ok) {
        return { delivered: false, provider: this.name, error: body.message ?? `HTTP ${resp.status}` };
      }
      return { delivered: true, provider: this.name, messageId: body.id };
    } catch (e) {
      return { delivered: false, provider: this.name, error: (e as Error).message };
    }
  }
}

/** Strips +91 / 0 prefixes — MSG91 wants a bare 10-digit Indian mobile. */
function normalizeIndianMobile(v: string): string {
  const digits = v.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

const senders: Record<string, OtpSender> = {
  console: new ConsoleSender(),
  msg91: new Msg91Sender(),
  twilio: new TwilioSender(),
  resend: new ResendSender(),
};

/**
 * Picks the sender for a channel. Email goes to Resend when it is configured
 * even if the SMS provider is the default, so staff email logins work without
 * a second switch.
 */
export function senderFor(channel: "phone" | "email"): OtpSender {
  if (channel === "email" && env.otp.resend.apiKey) return senders.resend;
  const configured = senders[env.otp.provider];
  return configured ?? senders.console;
}

/** Test seam: lets the suite assert on delivery without network calls. */
export function overrideSenderForTests(name: string, sender: OtpSender): void {
  senders[name] = sender;
}
