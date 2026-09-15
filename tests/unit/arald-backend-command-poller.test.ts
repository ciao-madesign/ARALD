import { afterEach, describe, expect, it, vi } from "vitest";
import { pollAndDeliverCommands } from "../../arald-backend/command-poller.js";

/**
 * `arald-backend/command-poller.ts` (Pezzo 1/2/4 del canale di comando,
 * docs/security.md voci #81/#82/#83) — la metà Box→specchio del nuovo flusso: un
 * fake `pg.Pool` (stesso pattern di `arald-backend-postgres-sync.test.ts`)
 * registra le query invece di parlare a un Postgres reale, `fetch` è
 * stubbato per simulare le risposte del nodo. La proprietà da verificare:
 * `2xx`/`422`/`400`/`413` sono terminali (consegnato/fallito — trovato
 * dalla revisione, `docs/security.md` voce #81: 400/413 descrivono i byte
 * del comando stesso, che un retry non cambia mai), ogni altro esito —
 * incluso un fallimento di trasporto — lascia il comando `pending` per il
 * prossimo giro, mai marcato `failed` per un problema che potrebbe
 * risolversi da solo, A MENO che il comando non sia bloccato in coda da
 * più di `MAX_COMMAND_AGE_BEFORE_GIVING_UP_MS` (24h), nel qual caso viene
 * comunque marcato `failed` per non affamare i comandi più recenti dietro
 * di lui in coda (stessa voce di revisione). La maggior parte dei test qui
 * usa `kind: "drop"` (il default di `fakePool()` quando omesso, per non
 * toccare le fixture già scritte per Pezzo 1) — i due gruppi dedicati in
 * fondo verificano il routing `kind: "node-append"` (Pezzo 2, voce #82) e
 * `kind: "relay-command"` (Pezzo 4, voce #83).
 */

interface Call {
  text: string;
  params: unknown[];
}

function fakePool(pendingRows: { id: string; kind?: string; metadata: unknown; data: string; priority: number; created_at?: Date }[]) {
  const calls: Call[] = [];
  const pool = {
    async query(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      if (text.includes("SELECT id, kind, metadata, data, priority")) {
        // created_at defaults to "just now" — same shape node-postgres itself returns (a JS Date).
        return { rows: pendingRows.map((r) => ({ ...r, kind: r.kind ?? "drop", created_at: r.created_at ?? new Date() })) };
      }
      return { rows: [] };
    },
  };
  return { pool: pool as unknown as import("pg").Pool, calls };
}

describe("arald-backend command-poller pollAndDeliverCommands", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a no-op (all-zero, zero queries) when this Box has no network password configured", async () => {
    const { pool, calls } = fakePool([{ id: "c1", metadata: {}, data: "AA==", priority: 4 }]);
    const summary = await pollAndDeliverCommands(pool, "http://node.example", undefined);
    expect(summary).toEqual({ delivered: 0, failed: 0, deferred: 0 });
    expect(calls).toHaveLength(0);
  });

  it("does nothing when there are no pending commands for this node_url", async () => {
    const { pool, calls } = fakePool([]);
    const summary = await pollAndDeliverCommands(pool, "http://node.example", "pw");
    expect(summary).toEqual({ delivered: 0, failed: 0, deferred: 0 });
    expect(calls).toHaveLength(1); // only the SELECT
  });

  it("marks a command delivered on a 2xx response, and hits the right node URL with the right auth", async () => {
    const { pool, calls } = fakePool([{ id: "c1", metadata: { contentId: "x" }, data: "AA==", priority: 4 }]);
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("http://node.example/api/ingest-signed-content");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer pw");
      expect(JSON.parse(init.body as string)).toEqual({ metadata: { contentId: "x" }, data: "AA==", priority: 4 });
      return new Response(JSON.stringify({ contentId: "x" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await pollAndDeliverCommands(pool, "http://node.example", "pw");

    expect(summary).toEqual({ delivered: 1, failed: 0, deferred: 0 });
    const update = calls.find((c) => c.text.includes("status = 'delivered'"));
    expect(update?.params).toEqual(["c1"]);
  });

  it("marks a command failed (terminal, never retried) on a 422 — the node's own 'did not verify' response", async () => {
    const { pool, calls } = fakePool([{ id: "c1", metadata: {}, data: "AA==", priority: 4 }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "content did not verify" }), { status: 422 })),
    );

    const summary = await pollAndDeliverCommands(pool, "http://node.example", "pw");

    expect(summary).toEqual({ delivered: 0, failed: 1, deferred: 0 });
    const update = calls.find((c) => c.text.includes("status = 'failed'"));
    expect(update?.params).toEqual(["c1", "content did not verify"]);
  });

  it("leaves a command pending (deferred) on a 401/404/5xx — a problem with the endpoint right now, not with the command", async () => {
    for (const status of [401, 404, 500, 503]) {
      const { pool, calls } = fakePool([{ id: "c1", metadata: {}, data: "AA==", priority: 4 }]);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("", { status })),
      );

      const summary = await pollAndDeliverCommands(pool, "http://node.example", "pw");

      expect(summary).toEqual({ delivered: 0, failed: 0, deferred: 1 });
      expect(calls.filter((c) => c.text.includes("UPDATE"))).toHaveLength(0);
      vi.unstubAllGlobals();
    }
  });

  it("leaves a command pending on a transport failure (connection refused, timeout) — never marks it failed", async () => {
    const { pool, calls } = fakePool([{ id: "c1", metadata: {}, data: "AA==", priority: 4 }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );

    const summary = await pollAndDeliverCommands(pool, "http://node.example", "pw");

    expect(summary).toEqual({ delivered: 0, failed: 0, deferred: 1 });
    expect(calls.filter((c) => c.text.includes("UPDATE"))).toHaveLength(0);
  });

  it("marks a command failed (terminal, never retried) on 400/413 — the command's own bytes, which never change on retry", async () => {
    for (const status of [400, 413]) {
      const { pool, calls } = fakePool([{ id: "c1", metadata: {}, data: "AA==", priority: 4 }]);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ error: `bad request ${status}` }), { status })),
      );

      const summary = await pollAndDeliverCommands(pool, "http://node.example", "pw");

      expect(summary).toEqual({ delivered: 0, failed: 1, deferred: 0 });
      const update = calls.find((c) => c.text.includes("status = 'failed'"));
      expect(update?.params).toEqual(["c1", `bad request ${status}`]);
      vi.unstubAllGlobals();
    }
  });

  it("leaves a command pending (deferred) on a 429 — this Box's own budget is temporarily exhausted, worth retrying", async () => {
    const { pool, calls } = fakePool([{ id: "c1", metadata: {}, data: "AA==", priority: 4 }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "too many requests" }), { status: 429 })),
    );

    const summary = await pollAndDeliverCommands(pool, "http://node.example", "pw");

    expect(summary).toEqual({ delivered: 0, failed: 0, deferred: 1 });
    expect(calls.filter((c) => c.text.includes("UPDATE"))).toHaveLength(0);
  });

  /**
   * Trovato dalla revisione (`docs/security.md` voce #81, punto 6): senza questo, un comando
   * bloccato per un motivo "transitorio" ma in realtà permanente (es. il Box ha disattivato
   * `allowRemoteContentIngest` dopo l'accodamento) restava `pending` per sempre, e — dato che
   * `fetchPendingCommands()` prende sempre i più vecchi per primi — avrebbe affamato ogni comando
   * più recente accodato dietro di lui.
   */
  it("gives up and marks failed a command stuck pending for longer than MAX_COMMAND_AGE_BEFORE_GIVING_UP_MS, even on an otherwise-'deferred' status", async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago — past the 24h give-up threshold
    const { pool, calls } = fakePool([{ id: "stuck", metadata: {}, data: "AA==", priority: 4, created_at: old }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })), // feature disabled on the Box — normally deferred
    );

    const summary = await pollAndDeliverCommands(pool, "http://node.example", "pw");

    expect(summary).toEqual({ delivered: 0, failed: 1, deferred: 0 });
    const update = calls.find((c) => c.text.includes("status = 'failed'"));
    expect(update?.params?.[0]).toBe("stuck");
    expect(String(update?.params?.[1])).toMatch(/gave up/);
  });

  it("gives up on an old command even on a pure transport failure (never reachable at all)", async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const { pool, calls } = fakePool([{ id: "stuck", metadata: {}, data: "AA==", priority: 4, created_at: old }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );

    const summary = await pollAndDeliverCommands(pool, "http://node.example", "pw");

    expect(summary).toEqual({ delivered: 0, failed: 1, deferred: 0 });
    const update = calls.find((c) => c.text.includes("status = 'failed'"));
    expect(update?.params?.[0]).toBe("stuck");
    expect(String(update?.params?.[1])).toMatch(/gave up/);
  });

  it("does NOT give up on a command still well within MAX_COMMAND_AGE_BEFORE_GIVING_UP_MS", async () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    const { pool, calls } = fakePool([{ id: "c1", metadata: {}, data: "AA==", priority: 4, created_at: recent }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );

    const summary = await pollAndDeliverCommands(pool, "http://node.example", "pw");

    expect(summary).toEqual({ delivered: 0, failed: 0, deferred: 1 });
    expect(calls.filter((c) => c.text.includes("UPDATE"))).toHaveLength(0);
  });

  it("processes multiple commands independently — one delivered, one failed, in one tick", async () => {
    const { pool, calls } = fakePool([
      { id: "ok", metadata: {}, data: "AA==", priority: 4 },
      { id: "bad", metadata: {}, data: "BB==", priority: 4 },
    ]);
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      return body.data === "AA=="
        ? new Response(JSON.stringify({}), { status: 200 })
        : new Response(JSON.stringify({ error: "bad signature" }), { status: 422 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await pollAndDeliverCommands(pool, "http://node.example", "pw");

    expect(summary).toEqual({ delivered: 1, failed: 1, deferred: 0 });
    expect(calls.find((c) => c.text.includes("status = 'delivered'"))?.params).toEqual(["ok"]);
    expect(calls.find((c) => c.text.includes("status = 'failed'"))?.params).toEqual(["bad", "bad signature"]);
  });

  /**
   * "Pezzo 2" del canale di comando (`docs/security.md` voce #82): un comando `kind: "node-append"`
   * va a un endpoint diverso, con un body diverso — l'intera busta firmata (`metadata`) invece di
   * `{metadata, data, priority}`. Stesso mapping status→esito di `kind: "drop"`, verificato qui solo
   * per il routing (endpoint/body), non ri-testando l'intera matrice terminale/differito già coperta
   * sopra per `"drop"` — la logica di classificazione status non dipende da `kind`.
   */
  describe("routing for kind: 'node-append'", () => {
    it("posts the whole 'metadata' object (the signed submission) to /api/ingest-node-append, not /api/ingest-signed-content", async () => {
      const signedSubmission = { text: "nota", kind: "info", timestamp: 1, expiresAt: 2, targetNodeId: "box1", publisherId: "op1", signature: "abcd" };
      const { pool, calls } = fakePool([{ id: "na1", kind: "node-append", metadata: signedSubmission, data: "", priority: 4 }]);
      const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe("http://node.example/api/ingest-node-append");
        expect(JSON.parse(init.body as string)).toEqual(signedSubmission);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const summary = await pollAndDeliverCommands(pool, "http://node.example", "pw");

      expect(summary).toEqual({ delivered: 1, failed: 0, deferred: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("marks a node-append command failed (terminal) on a 422, same as a drop", async () => {
      const { pool, calls } = fakePool([{ id: "na1", kind: "node-append", metadata: { targetNodeId: "wrong-box" }, data: "", priority: 4 }]);
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "wrong target node" }), { status: 422 })));

      const summary = await pollAndDeliverCommands(pool, "http://node.example", "pw");

      expect(summary).toEqual({ delivered: 0, failed: 1, deferred: 0 });
      const update = calls.find((c) => c.text.includes("status = 'failed'"));
      expect(update?.params).toEqual(["na1", "wrong target node"]);
    });

    it("processes a 'drop' and a 'node-append' command in the same tick, each hitting its own endpoint", async () => {
      const { pool, calls } = fakePool([
        { id: "drop1", kind: "drop", metadata: { contentId: "x" }, data: "AA==", priority: 4 },
        { id: "na1", kind: "node-append", metadata: { text: "nota" }, data: "", priority: 4 },
      ]);
      const hitPaths: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          hitPaths.push(new URL(url).pathname);
          return new Response(JSON.stringify({}), { status: 200 });
        }),
      );

      const summary = await pollAndDeliverCommands(pool, "http://node.example", "pw");

      expect(summary).toEqual({ delivered: 2, failed: 0, deferred: 0 });
      expect(hitPaths.sort()).toEqual(["/api/ingest-node-append", "/api/ingest-signed-content"]);
      expect(calls.filter((c) => c.text.includes("status = 'delivered'"))).toHaveLength(2);
    });
  });

  /**
   * "Pezzo 4" del canale di comando (`docs/security.md` voce #83): un comando `kind: "relay-command"`
   * va a un terzo endpoint, stessa forma di `"node-append"` (l'intera busta firmata come body).
   */
  describe("routing for kind: 'relay-command'", () => {
    it("posts the whole 'metadata' object (the signed submission) to /api/ingest-relay-command", async () => {
      const signedSubmission = { command: "reboot", timestamp: 1, targetNodeId: "box1", publisherId: "op1", signature: "abcd" };
      const { pool, calls } = fakePool([{ id: "rc1", kind: "relay-command", metadata: signedSubmission, data: "", priority: 2 }]);
      const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe("http://node.example/api/ingest-relay-command");
        expect(JSON.parse(init.body as string)).toEqual(signedSubmission);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const summary = await pollAndDeliverCommands(pool, "http://node.example", "pw");

      expect(summary).toEqual({ delivered: 1, failed: 0, deferred: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("marks a relay-command failed (terminal) on a 422 — a replay or bad signature, never worth retrying", async () => {
      const { pool, calls } = fakePool([{ id: "rc1", kind: "relay-command", metadata: { targetNodeId: "wrong-box" }, data: "", priority: 2 }]);
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "wrong target node" }), { status: 422 })));

      const summary = await pollAndDeliverCommands(pool, "http://node.example", "pw");

      expect(summary).toEqual({ delivered: 0, failed: 1, deferred: 0 });
      const update = calls.find((c) => c.text.includes("status = 'failed'"));
      expect(update?.params).toEqual(["rc1", "wrong target node"]);
    });

    it("leaves a relay-command pending (deferred) on a 429 — this Box's own relay-command budget is temporarily exhausted", async () => {
      const { pool, calls } = fakePool([{ id: "rc1", kind: "relay-command", metadata: {}, data: "", priority: 2 }]);
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "too many requests" }), { status: 429 })));

      const summary = await pollAndDeliverCommands(pool, "http://node.example", "pw");

      expect(summary).toEqual({ delivered: 0, failed: 0, deferred: 1 });
      expect(calls.filter((c) => c.text.includes("UPDATE"))).toHaveLength(0);
    });

    it("processes all three kinds ('drop', 'node-append', 'relay-command') in the same tick, each hitting its own endpoint", async () => {
      const { pool, calls } = fakePool([
        { id: "drop1", kind: "drop", metadata: { contentId: "x" }, data: "AA==", priority: 4 },
        { id: "na1", kind: "node-append", metadata: { text: "nota" }, data: "", priority: 4 },
        { id: "rc1", kind: "relay-command", metadata: { command: "reboot" }, data: "", priority: 2 },
      ]);
      const hitPaths: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          hitPaths.push(new URL(url).pathname);
          return new Response(JSON.stringify({}), { status: 200 });
        }),
      );

      const summary = await pollAndDeliverCommands(pool, "http://node.example", "pw");

      expect(summary).toEqual({ delivered: 3, failed: 0, deferred: 0 });
      expect(hitPaths.sort()).toEqual(["/api/ingest-node-append", "/api/ingest-relay-command", "/api/ingest-signed-content"]);
      expect(calls.filter((c) => c.text.includes("status = 'delivered'"))).toHaveLength(3);
    });
  });
});
