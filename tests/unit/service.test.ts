import { describe, expect, it } from "vitest";
import { serviceSigningPayload, verifyServiceAnnouncement, type ServiceAnnouncement } from "../../node/src/service.js";
import { Identity } from "../../node/src/identity.js";

function signedAnnouncement(
  identity: Identity,
  overrides: Partial<Pick<ServiceAnnouncement, "serviceId" | "providerId" | "availability" | "createdAt">> = {},
): ServiceAnnouncement {
  const serviceId = overrides.serviceId ?? "service://translation";
  const version = "1.0.0";
  const capabilities = ["it-en", "en-it"];
  const providerId = overrides.providerId ?? identity.nodeId;
  const resourceRequirements = undefined;
  const availability = overrides.availability ?? true;
  const createdAt = overrides.createdAt ?? Date.now();
  const signature = identity
    .sign(serviceSigningPayload({ serviceId, version, capabilities, providerId, resourceRequirements, availability, createdAt }))
    .toString("hex");
  return { serviceId, version, capabilities, providerId, resourceRequirements, availability, createdAt, signature };
}

describe("ServiceAnnouncement signing (spec §35, §55-style)", () => {
  it("accepts an announcement correctly signed by its claimed provider", () => {
    const provider = Identity.generate();
    expect(verifyServiceAnnouncement(signedAnnouncement(provider))).toBe(true);
  });

  it("rejects an announcement with no signature at all", () => {
    const announcement = signedAnnouncement(Identity.generate());
    expect(verifyServiceAnnouncement({ ...announcement, signature: "" })).toBe(false);
  });

  it("rejects an announcement impersonating a provider it wasn't actually signed by", () => {
    const victim = Identity.generate();
    const attacker = Identity.generate();
    const forged = signedAnnouncement(attacker, { providerId: victim.nodeId });
    expect(verifyServiceAnnouncement(forged)).toBe(false);
  });

  it("rejects a genuinely-signed announcement whose availability was flipped after signing", () => {
    const provider = Identity.generate();
    const genuine = signedAnnouncement(provider, { availability: true });
    // A relay keeps the signature untouched but flips availability — must not verify, otherwise
    // the signature would only prove "this provider signed something", not "this provider signed
    // exactly this availability claim" (mirrors content.ts's relabeling-tamper test).
    const tampered: ServiceAnnouncement = { ...genuine, availability: false };
    expect(verifyServiceAnnouncement(tampered)).toBe(false);
    expect(verifyServiceAnnouncement(genuine)).toBe(true);
  });

  it("rejects a genuinely-signed announcement whose createdAt was tampered with (replay-resistance depends on this)", () => {
    const provider = Identity.generate();
    const genuine = signedAnnouncement(provider, { createdAt: 1000 });
    const tampered: ServiceAnnouncement = { ...genuine, createdAt: 9_999_999_999 };
    expect(verifyServiceAnnouncement(tampered)).toBe(false);
  });
});
