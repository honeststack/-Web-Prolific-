import { ParticipantState } from "../shared/types";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function parse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new HttpError(response.status, body?.error ?? "error", body?.message ?? `HTTP ${response.status}`);
  return body as T;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Participant requests keep retrying through network errors and 5xx responses.
 * The server treats repeats as no-ops, so an answer is never lost or double counted,
 * and the screen does not advance until the server confirms the save.
 */
export async function postParticipant(path: string, payload: unknown, onRetry?: (retrying: boolean) => void): Promise<ParticipantState> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`/api${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (response.status < 500) {
        const result = await parse<ParticipantState>(response);
        onRetry?.(false);
        return result;
      }
    } catch {
      // Offline or connection dropped: fall through to the retry below.
    }
    onRetry?.(true);
    await sleep(Math.min(8000, 400 * 2 ** attempt) * (0.5 + Math.random() / 2));
  }
}

export function beacon(path: string, payload: unknown) {
  const body = JSON.stringify(payload);
  if (!navigator.sendBeacon?.(`/api${path}`, body)) {
    void fetch(`/api${path}`, { method: "POST", body, keepalive: true }).catch(() => undefined);
  }
}

export interface ApiInfo {
  demoMode: boolean;
  demoPassword?: string;
  poolSize: number;
}

export async function getInfo(): Promise<ApiInfo> {
  return parse<ApiInfo>(await fetch("/api/info"));
}

export function adminClient(password: string) {
  const headers = { "x-admin-password": password, "content-type": "application/json" };
  return {
    get: async <T,>(path: string) => parse<T>(await fetch(`/api/admin${path}`, { headers })),
    post: async <T,>(path: string, payload: unknown = {}) =>
      parse<T>(await fetch(`/api/admin${path}`, { method: "POST", headers, body: JSON.stringify(payload) })),
    download: async (type: string, excludeTest: boolean) => {
      const response = await fetch(`/api/admin/export?type=${type}${excludeTest ? "&excludeTest=1" : ""}`, { headers });
      if (!response.ok) throw new HttpError(response.status, "export_failed", "CSVを出力できませんでした。");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `${type}_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    },
  };
}
export type AdminClient = ReturnType<typeof adminClient>;
