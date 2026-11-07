import { timingSafeEqual } from "node:crypto";
import { conditionOf } from "../shared/pool";
import { PoolItem, Stage } from "../shared/types";
import {
  adminSummary,
  answer,
  ApiError,
  Context,
  enter,
  exportCsv,
  heartbeat,
  itemRows,
  leave,
  reconcile,
  reportImageError,
  resetAll,
  seedSimulated,
  setBlocked,
  submitStage,
  updateSettings,
} from "./service";

export interface ApiConfig {
  adminPassword: string;
  usingDefaultPassword: boolean;
}

export const DEFAULT_DEMO_PASSWORD = "demo-admin";

export function poolFromRows(rows: string[][]): PoolItem[] {
  return rows.map(([id, anchor, b, c]) => ({ id, anchor, b, c, cond: conditionOf(id)! }));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function passwordMatches(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function body(req: Request): Promise<Record<string, unknown>> {
  // sendBeacon posts text/plain, so parse from text rather than trusting the content type.
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json");
  }
}

const PID = /^[A-Za-z0-9_-]{1,64}$/;
function pidOf(input: Record<string, unknown>): string {
  const pid = input.pid;
  if (typeof pid !== "string" || !PID.test(pid)) throw new ApiError(400, "invalid_pid");
  return pid;
}

export async function handleApi(req: Request, ctx: Context, config: ApiConfig): Promise<Response> {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api/, "").replace(/\/$/, "");
  const method = req.method;
  try {
    if (route === "/info" && method === "GET") {
      return json({
        demoMode: ctx.demoMode,
        demoPassword: ctx.demoMode && config.usingDefaultPassword ? config.adminPassword : undefined,
        poolSize: ctx.pool.length,
      });
    }
    if (route === "/session/enter" && method === "POST") {
      const input = await body(req);
      return json(
        await enter(ctx, {
          pid: input.pid as string,
          studyId: input.studyId as string,
          sessionId: input.sessionId as string,
          source: input.source as string,
        }),
      );
    }
    if (route === "/session/stage" && method === "POST") {
      const input = await body(req);
      return json(await submitStage(ctx, pidOf(input), input.stage as Stage, (input.payload ?? {}) as Record<string, unknown>));
    }
    if (route === "/session/answer" && method === "POST") {
      const input = await body(req);
      return json(
        await answer(ctx, {
          pid: pidOf(input),
          trialNo: Number(input.trialNo),
          kind: String(input.kind),
          value: input.value as never,
          rtMs: Number(input.rtMs),
          imagesShownAt: typeof input.imagesShownAt === "string" ? input.imagesShownAt : undefined,
          zoomCount: Number(input.zoomCount) || 0,
          sessionId: typeof input.sessionId === "string" ? input.sessionId : undefined,
          autofilled: ctx.demoMode && input.autofilled === true,
        }),
      );
    }
    if (route === "/session/heartbeat" && method === "POST") {
      return json(await heartbeat(ctx, pidOf(await body(req))));
    }
    if (route === "/session/leave" && method === "POST") {
      const input = await body(req);
      return json(await leave(ctx, pidOf(input), String(input.reason)));
    }
    if (route === "/session/image-error" && method === "POST") {
      const input = await body(req);
      return json(await reportImageError(ctx, { pid: pidOf(input), trialNo: Number(input.trialNo), url: String(input.url), simulated: input.simulated === true }));
    }

    if (route.startsWith("/admin/")) {
      if (!passwordMatches(req.headers.get("x-admin-password"), config.adminPassword)) {
        throw new ApiError(401, "unauthorized", "パスワードが正しくありません。");
      }
      if (route === "/admin/summary" && method === "GET") return json(await adminSummary(ctx));
      if (route === "/admin/items" && method === "GET") return json(await itemRows(ctx));
      if (route === "/admin/settings" && method === "POST") return json(await updateSettings(ctx, await body(req)));
      if (route === "/admin/block" && method === "POST") {
        const input = await body(req);
        return json(await setBlocked(ctx, String(input.tripletId), input.blocked === true));
      }
      if (route === "/admin/export" && method === "GET") {
        const type = url.searchParams.get("type") ?? "responses";
        const csv = await exportCsv(ctx, type, url.searchParams.get("excludeTest") === "1");
        return new Response(csv, {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="${type}.csv"`,
            "cache-control": "no-store",
          },
        });
      }
      if (route === "/admin/reconcile" && method === "POST") return json(await reconcile(ctx, (await body(req)).fix === true));
      if (route === "/admin/reset" && method === "POST") return json(await resetAll(ctx));
      if (route === "/admin/seed" && method === "POST") {
        if (!ctx.demoMode) throw new ApiError(403, "demo_only");
        return json(await seedSimulated(ctx, Number((await body(req)).count) || 20));
      }
    }
    return json({ error: "not_found" }, 404);
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.code, message: error.message }, error.status);
    console.error(error);
    return json({ error: "server_error", message: "Unexpected server error." }, 500);
  }
}
