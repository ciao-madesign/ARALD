import { Identity } from "./identity.js";

/**
 * A provider's self-signed claim to offer a service (spec §35): not just
 * files, but capabilities like `service://translation`, `service://ocr`,
 * `service://ai`. Same signing pattern as `ContentMetadata` (content.ts)
 * and `IdentityAnnouncement` (encryption.ts) — `providerId` is who claims
 * to offer it, `signature` is that node's own proof, so a relay can
 * propagate the claim without being able to forge or alter it.
 *
 * Unlike content (immutable once published — a content id is the hash of
 * its bytes), a service's `availability` is inherently time-varying: a
 * node can go from offering a service to not offering it and back. So
 * `createdAt` **is** part of the signed payload here (deliberately unlike
 * `ContentMetadata`, where it's excluded specifically because content
 * never needs a freshness comparison) — it's what lets `ServiceDirectory`
 * reject a replayed older announcement (e.g. a stale "available: true"
 * replayed after the real provider went offline) in favor of whichever
 * signed announcement is actually newer for the same (serviceId,
 * providerId) pair.
 */
export interface ServiceAnnouncement {
  serviceId: string;
  version: string;
  capabilities: string[];
  providerId: string;
  resourceRequirements?: string;
  availability: boolean;
  createdAt: number;
  /** Ed25519 signature (hex), by providerId, over `serviceSigningPayload()`. */
  signature: string;
}

/** The fields a provider's signature actually commits to. */
export type SignableServiceFields = Pick<
  ServiceAnnouncement,
  "serviceId" | "version" | "capabilities" | "providerId" | "resourceRequirements" | "availability" | "createdAt"
>;

/** Canonical bytes a provider signs — explicit field order so the signed representation is unambiguous. */
export function serviceSigningPayload(fields: SignableServiceFields): Buffer {
  return Buffer.from(
    JSON.stringify({
      serviceId: fields.serviceId,
      version: fields.version,
      capabilities: fields.capabilities,
      providerId: fields.providerId,
      resourceRequirements: fields.resourceRequirements,
      availability: fields.availability,
      createdAt: fields.createdAt,
    }),
  );
}

/** True only if the announcement's signature actually verifies against its own claimed `providerId` — the trust boundary for any `ServiceAnnouncement` learned from the network. */
export function verifyServiceAnnouncement(announcement: ServiceAnnouncement): boolean {
  if (!announcement.providerId || !announcement.signature) return false;
  try {
    return Identity.verifyWithNodeId(
      announcement.providerId,
      serviceSigningPayload(announcement),
      Buffer.from(announcement.signature, "hex"),
    );
  } catch {
    // Malformed node id / signature hex, or a key that doesn't parse as Ed25519 — never trust it.
    return false;
  }
}

/**
 * Handles an invocation of a locally-registered service (`NomadNode.registerService()`).
 * `fromNodeId` is the caller's declared node id — like every other `source`
 * field in this prototype, it's unauthenticated by the transport itself
 * (see docs/security.md "binding crittografico"), so a handler that needs
 * to act on it as an authorization decision should treat it accordingly.
 * May return synchronously or a Promise; a thrown error (or a rejected
 * promise) is turned into a `SERVICE_RESPONSE` carrying `error` instead of
 * `result`.
 */
export type ServiceHandler = (payload: unknown, fromNodeId: string) => unknown | Promise<unknown>;
