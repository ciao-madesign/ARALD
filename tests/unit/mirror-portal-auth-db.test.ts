import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { assignNode, createOrganization, createUser, withTransaction, type ConnectablePool } from "../../mirror-portal/lib/auth-db.js";

/**
 * A fake `pg.Pool`/`PoolClient` pair that records every query (text + params)
 * instead of touching a real Postgres — same "test the pure/injectable shape,
 * verify the real thing lives against real Postgres separately" split this
 * repository already uses for `arald-backend/postgres-sync.test.ts`'s fake
 * `SyncClient`. Resolves canned rows by matching a query's SQL prefix so the
 * three write functions under test (which all run inside `withTransaction()`)
 * can complete without a database, while every regression test below still
 * exercises the *real* `withTransaction`/`assignNode`/`createOrganization`/
 * `createUser` code, not a re-implementation of it.
 */
function createFakeClient(rowsByPrefix: Record<string, unknown[]> = {}) {
  const calls: { text: string; params: unknown[] }[] = [];
  let released: "not-released" | "released-cleanly" | Error = "not-released";
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      const trimmed = text.trim();
      for (const prefix of Object.keys(rowsByPrefix)) {
        if (trimmed.startsWith(prefix)) return { rows: rowsByPrefix[prefix] };
      }
      return { rows: [] };
    },
    release: (err?: unknown) => {
      released = err instanceof Error ? err : "released-cleanly";
    },
  } as unknown as PoolClient;
  return {
    client,
    calls,
    getReleased: () => released,
    pool: { connect: async () => client } satisfies ConnectablePool,
  };
}

describe("mirror-portal/lib/auth-db — transaction handling", () => {
  describe("withTransaction", () => {
    it("runs BEGIN, the callback's own queries, then COMMIT, and releases the client cleanly", async () => {
      const fake = createFakeClient();
      const result = await withTransaction(async (client) => {
        await client.query("SELECT 1");
        return "ok";
      }, fake.pool);

      expect(result).toBe("ok");
      expect(fake.calls.map((c) => c.text)).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
      expect(fake.getReleased()).toBe("released-cleanly");
    });

    it("regression: on failure, rolls back and releases the client WITH the error, never a plain release()", async () => {
      // Found by a second review pass: a plain release() after a failed transaction tells
      // node-postgres the connection is healthy, risking "current transaction is aborted" errors on
      // a later, completely unrelated query pulled from the same pool.
      const fake = createFakeClient();
      const failure = new Error("boom");

      await expect(
        withTransaction(async () => {
          throw failure;
        }, fake.pool),
      ).rejects.toBe(failure);

      expect(fake.calls.map((c) => c.text)).toEqual(["BEGIN", "ROLLBACK"]);
      expect(fake.getReleased()).toBe(failure);
    });

    it("regression: still releases with an error even when the ROLLBACK itself fails", async () => {
      const calls: string[] = [];
      let released: unknown = "not-released";
      const client = {
        query: async (text: string) => {
          calls.push(text);
          if (text === "ROLLBACK") throw new Error("connection already gone");
          if (text === "SELECT boom") throw new Error("original failure");
          return { rows: [] };
        },
        release: (err?: unknown) => {
          released = err;
        },
      } as unknown as PoolClient;
      const pool: ConnectablePool = { connect: async () => client };

      await expect(
        withTransaction(async (c) => {
          await c.query("SELECT boom");
        }, pool),
      ).rejects.toThrow("original failure");

      expect(calls).toEqual(["BEGIN", "SELECT boom", "ROLLBACK"]);
      expect(released).toBeInstanceOf(Error);
      expect((released as Error).message).toBe("original failure");
    });
  });

  describe("assignNode", () => {
    it("regression: locks the existing row with SELECT ... FOR UPDATE before upserting — guards against silently losing the fix for a reassignment race", async () => {
      const fake = createFakeClient({ "SELECT organization_id FROM nodes": [{ organization_id: "org-old" }] });

      await assignNode({ nodeUrl: "http://node.example", organizationId: "org-new", actorUserId: "u1", actorEmail: "a@example.com" }, fake.pool);

      const selectCall = fake.calls.find((c) => c.text.includes("SELECT organization_id FROM nodes"));
      expect(selectCall?.text).toMatch(/FOR UPDATE\s*$/);
    });

    it("records previousOrganizationId in the same transaction's audit_logs insert, null on a first-ever assignment", async () => {
      const fakeFirst = createFakeClient({ "SELECT organization_id FROM nodes": [] });
      await assignNode({ nodeUrl: "http://node.example", organizationId: "org-a", actorUserId: "u1", actorEmail: "a@example.com" }, fakeFirst.pool);
      const firstAudit = fakeFirst.calls.find((c) => c.text.includes("INSERT INTO audit_logs"));
      expect(JSON.parse(firstAudit?.params[3] as string)).toMatchObject({ organizationId: "org-a", previousOrganizationId: null });

      const fakeReassign = createFakeClient({ "SELECT organization_id FROM nodes": [{ organization_id: "org-a" }] });
      await assignNode({ nodeUrl: "http://node.example", organizationId: "org-b", actorUserId: "u1", actorEmail: "a@example.com" }, fakeReassign.pool);
      const secondAudit = fakeReassign.calls.find((c) => c.text.includes("INSERT INTO audit_logs"));
      expect(JSON.parse(secondAudit?.params[3] as string)).toMatchObject({ organizationId: "org-b", previousOrganizationId: "org-a" });
    });

    it("both the node upsert and its audit_logs entry happen inside one BEGIN/COMMIT — never two separate transactions", async () => {
      const fake = createFakeClient({ "SELECT organization_id FROM nodes": [] });
      await assignNode({ nodeUrl: "http://node.example", organizationId: "org-a", actorUserId: "u1", actorEmail: "a@example.com" }, fake.pool);

      const texts = fake.calls.map((c) => c.text);
      expect(texts[0]).toBe("BEGIN");
      expect(texts[texts.length - 1]).toBe("COMMIT");
      expect(texts.some((t) => t.includes("INSERT INTO nodes"))).toBe(true);
      expect(texts.some((t) => t.includes("INSERT INTO audit_logs"))).toBe(true);
    });
  });

  describe("createOrganization / createUser — audit atomicity", () => {
    it("regression: createOrganization's audit_logs insert happens inside the same transaction as the organizations insert, not as a separate call afterward", async () => {
      const fake = createFakeClient({ "INSERT INTO organizations": [{ id: "org-1", name: "Rifugio", created_at: new Date() }] });

      await createOrganization({ name: "Rifugio", actorUserId: "u1", actorEmail: "a@example.com" }, fake.pool);

      const texts = fake.calls.map((c) => c.text);
      expect(texts[0]).toBe("BEGIN");
      expect(texts[texts.length - 1]).toBe("COMMIT");
      expect(texts.filter((t) => t.includes("INSERT INTO audit_logs"))).toHaveLength(1);
    });

    it("regression: createUser's audit_logs insert happens inside the same transaction as the users insert", async () => {
      const fake = createFakeClient({
        "INSERT INTO users": [{ id: "u1", email: "a@example.com", role: "admin", organization_id: null, created_at: new Date() }],
      });

      await createUser(
        { email: "a@example.com", passwordHash: "salt:hash", role: "admin", organizationId: null, actorUserId: null, actorEmail: "a@example.com" },
        fake.pool,
      );

      const texts = fake.calls.map((c) => c.text);
      expect(texts[0]).toBe("BEGIN");
      expect(texts[texts.length - 1]).toBe("COMMIT");
      expect(texts.filter((t) => t.includes("INSERT INTO audit_logs"))).toHaveLength(1);
    });
  });
});
