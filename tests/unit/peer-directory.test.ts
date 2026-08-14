import { describe, expect, it } from "vitest";
import { PeerDirectory } from "../../node/src/peer-directory.js";
import { EncryptionIdentity, signIdentityAnnouncement } from "../../node/src/encryption.js";
import { Identity } from "../../node/src/identity.js";

function makeAnnouncement() {
  return signIdentityAnnouncement(Identity.generate(), EncryptionIdentity.generate());
}

describe("PeerDirectory", () => {
  it("records and retrieves an announcement's key", () => {
    const directory = new PeerDirectory();
    const announcement = makeAnnouncement();

    expect(directory.record(announcement)).toBe(true);
    expect(directory.has(announcement.nodeId)).toBe(true);
    expect(directory.getKey(announcement.nodeId)).toBe(announcement.encryptionPublicKey);
    expect(directory.get(announcement.nodeId)).toEqual(announcement);
  });

  it("treats a node id's binding as immutable: re-recording the same node id is a no-op", () => {
    const directory = new PeerDirectory();
    const first = makeAnnouncement();
    directory.record(first);

    const second = signIdentityAnnouncement(Identity.generate(), EncryptionIdentity.generate());
    const impostor = { ...second, nodeId: first.nodeId };

    expect(directory.record(impostor)).toBe(false);
    expect(directory.getKey(first.nodeId)).toBe(first.encryptionPublicKey);
  });

  it("evicts the oldest entry once maxSize is exceeded", () => {
    const directory = new PeerDirectory({ maxSize: 2 });
    const a = makeAnnouncement();
    const b = makeAnnouncement();
    const c = makeAnnouncement();

    directory.record(a);
    directory.record(b);
    directory.record(c);

    expect(directory.size).toBe(2);
    expect(directory.has(a.nodeId)).toBe(false);
    expect(directory.has(c.nodeId)).toBe(true);
  });

  it("lists every recorded announcement", () => {
    const directory = new PeerDirectory();
    const a = makeAnnouncement();
    const b = makeAnnouncement();
    directory.record(a);
    directory.record(b);

    const list = directory.list();
    expect(list).toHaveLength(2);
    expect(list.map((entry) => entry.nodeId).sort()).toEqual([a.nodeId, b.nodeId].sort());
  });
});
