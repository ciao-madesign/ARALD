/**
 * Thin client for Meta's WhatsApp Business Cloud API — `POST
 * /{phone-number-id}/messages` sending a plain text message.
 *
 * **Request/response shape reconstructed from training knowledge, not
 * verified against Meta's live documentation or API in this session** (no
 * internet access in this environment, `CLAUDE.md`) — flagged explicitly per
 * this project's standing rule on unverifiable claims. Anyone wiring this up
 * against the real API should double-check the current Meta Graph API
 * version/endpoint shape before relying on it. `fake-whatsapp-cloud-server.ts`
 * in this same directory models this exact shape for tests, so at least this
 * client and its test double are verified to agree with *each other*.
 */

export interface WhatsAppCloudConfig {
  /** e.g. `https://graph.facebook.com/v19.0` in production, a `FakeWhatsAppCloudServer` URL in tests/demo. */
  baseUrl: string;
  phoneNumberId: string;
  accessToken: string;
}

export interface WhatsAppSendResult {
  messageId: string;
}

/** WhatsApp's own per-message text limit is not independently confirmed here — this is a defensive, conservative cap on what this relay will ever attempt to send, not a claim about the real API's exact limit. */
export const MAX_WHATSAPP_TEXT_BYTES = 4096;

export async function sendWhatsAppText(config: WhatsAppCloudConfig, toNumber: string, text: string): Promise<WhatsAppSendResult> {
  const res = await fetch(`${config.baseUrl}/${config.phoneNumberId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.accessToken}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to: toNumber, type: "text", text: { body: text } }),
  });
  const body = (await res.json().catch(() => undefined)) as
    | { messages?: Array<{ id?: unknown }>; error?: { message?: unknown } }
    | undefined;
  if (!res.ok) {
    const message = typeof body?.error?.message === "string" ? body.error.message : `HTTP ${res.status}`;
    throw new Error(`WhatsApp Cloud API rejected the message: ${message}`);
  }
  const messageId = body?.messages?.[0]?.id;
  if (typeof messageId !== "string") throw new Error("WhatsApp Cloud API returned a malformed response");
  return { messageId };
}
