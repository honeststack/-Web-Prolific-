/**
 * Exercises the adapter through the real @netlify/blobs client and Netlify's local
 * Blobs server. That server checks a condition and writes in separate steps, so it
 * cannot prove behaviour under simultaneous writes. Concurrency is covered by the
 * atomic store in service.test.ts and, on a deployed site, by `npm run loadtest`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStore } from "@netlify/blobs";
import { BlobsServer } from "@netlify/blobs/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syntheticPool } from "../shared/allocator";
import { COMPREHENSION } from "../shared/content";
import { NetlifyBlobStore } from "../server/netlify-store";
import * as svc from "../server/service";

const TOKEN = "test-token";
const SITE = "test-site";
let server: BlobsServer;
let dir: string;
let store: NetlifyBlobStore;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "fp-blobs-"));
  server = new BlobsServer({ directory: dir, token: TOKEN, port: 0 });
  const { port } = await server.start();
  store = new NetlifyBlobStore(getStore({ name: "survey", edgeURL: `http://localhost:${port}`, siteID: SITE, token: TOKEN }));
});

afterAll(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("Netlify Blobs store", () => {
  it("refuses a stale write and a duplicate create", async () => {
    expect(await store.put("k", "1", { ifNew: true })).toBe(true);
    expect(await store.put("k", "2", { ifNew: true })).toBe(false);
    const doc = (await store.get("k"))!;
    expect(doc.text).toBe("1");
    expect(await store.put("k", "3", { ifMatch: doc.etag })).toBe(true);
    expect(await store.put("k", "4", { ifMatch: doc.etag })).toBe(false);
    expect((await store.get("k"))!.text).toBe("3");
    await store.remove("k");
    expect(await store.get("k")).toBeNull();
  });

  it("lists by prefix", async () => {
    await store.put("session/a", "1");
    await store.put("session/b", "1");
    await store.put("other", "1");
    expect((await store.list("session/")).sort()).toEqual(["session/a", "session/b"]);
    await Promise.all(["session/a", "session/b", "other"].map((key) => store.remove(key)));
  });

  it("runs participants through the adapter with exact counts", async () => {
    const ctx: svc.Context = { store, pool: syntheticPool({ a: 60, b: 30, c: 30, d: 60, e: 30, f: 30, g: 60 }), rng: Math.random, now: Date.now, demoMode: true };
    for (const pid of ["B1", "B2", "B3"]) {
      await svc.enter(ctx, { pid, studyId: "S", sessionId: `X_${pid}`, source: "demo" });
      await svc.submitStage(ctx, pid, "consent", { agree: true });
      await svc.submitStage(ctx, pid, "instructions", {});
      let state = await svc.submitStage(ctx, pid, "comprehension", { value: COMPREHENSION.correct });
      for (let i = 0; i < 8; i++) {
        const trial = state.trial!;
        state = await svc.answer(ctx, { pid, trialNo: trial.no, kind: trial.kind, value: "B", rtMs: 1000 });
      }
      await svc.leave(ctx, pid, "back");
    }
    const check = await svc.reconcile(ctx, false);
    expect(check.mismatchedItems).toBe(0);
    expect(check.duplicateAssignments).toBe(0);
    expect(check.savedResponses).toBe(3 * 6);
    expect((await svc.adminSummary(ctx)).balance.reserved).toBe(0);
    expect((await svc.allSessions(ctx)).map((s) => s.pid).sort()).toEqual(["B1", "B2", "B3"]);
  }, 120_000);
});
