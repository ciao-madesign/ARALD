/**
 * Thin client for an arbitrary operator-configured HTTP webhook — the
 * generalization discussed with the user for the three remaining "consegna
 * esterna differita" examples (`docs/next-steps.md`): a post to a
 * channel/bot (Slack/Telegram), a location check-in toward a coordination
 * service, an upload of a report/photo. Unlike `whatsapp-client.ts`/
 * `smtp-client.ts`, there is no fixed real API this talks to — every
 * destination configures its own `webhookUrl` (and optional `authToken`),
 * exactly the way an operator would set up any of those three real services
 * once they know which one they're actually integrating.
 */

export interface WebhookDestinationTarget {
  webhookUrl: string;
  /** Sent as `Authorization: Bearer <authToken>` when present — a single fixed token configured once by the operator (docs/next-steps.md decision #3), same principle as `email-relay/`'s SMTP password. Omitted entirely when the target service needs no auth. */
  authToken?: string;
}

/** Mutually exclusive by convention (never both set) — see `server.ts`'s `decodeUtf8IfValid()` for why: the mesh side (`mobile/www/app.js`) sends raw bytes with no filename/MIME metadata, so this relay's only signal for "text or file" is whether those bytes are valid UTF-8. */
export interface WebhookRequestBody {
  text?: string;
  dataBase64?: string;
}

export async function postToWebhook(target: WebhookDestinationTarget, body: WebhookRequestBody, timeoutMs = 10_000): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(target.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(target.authToken ? { Authorization: `Bearer ${target.authToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`webhook endpoint rejected the request: HTTP ${res.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
