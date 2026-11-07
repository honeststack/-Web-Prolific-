/**
 * Virtual participants that use the real HTTP API. The same code powers the
 * "同時アクセス試験" button on the admin screen and `npm run loadtest`.
 */
import { COMPREHENSION } from "./content";
import { ParticipantState, ResponseValue } from "./types";

export interface LoadTestOptions {
  baseUrl: string;
  participants: number;
  questionsEach: number;
  fetchImpl?: typeof fetch;
  onProgress?: (done: number, total: number) => void;
}

export interface LoadTestResult {
  participants: number;
  questionsEach: number;
  totalAnswers: number;
  durationMs: number;
  medianSaveMs: number;
  p95SaveMs: number;
  retries: number;
  failures: number;
  duplicateWithinParticipant: number;
  assignments: string[];
  pids: string[];
  errors: string[];
}

const RESPONSES: ResponseValue[] = ["B", "C", "equal", "cannot_judge"];

export async function runLoadTest(options: LoadTestOptions): Promise<LoadTestResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const batch = Date.now().toString(36);
  const latencies: number[] = [];
  const assignments: string[] = [];
  const pids: string[] = [];
  const errors: string[] = [];
  let retries = 0;
  let failures = 0;
  let duplicateWithinParticipant = 0;
  let done = 0;
  const total = options.participants * options.questionsEach;
  const started = Date.now();

  const post = async (path: string, payload: unknown): Promise<ParticipantState> => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await doFetch(`${options.baseUrl}/api${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(() => null);
      if (response?.ok) return (await response.json()) as ParticipantState;
      if (response && response.status < 500) throw new Error(`${path}: HTTP ${response.status}`);
      retries++;
      await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** attempt * Math.random()));
    }
    throw new Error(`${path}: gave up after retries`);
  };

  const participant = async (index: number) => {
    const pid = `LOADTEST_${batch}_${String(index + 1).padStart(3, "0")}`;
    pids.push(pid);
    const seen = new Set<string>();
    try {
      let state = await post("/session/enter", { pid, studyId: "LOADTEST", sessionId: `S_${pid}`, source: "loadtest" });
      state = await post("/session/stage", { pid, stage: "consent", payload: { agree: true } });
      state = await post("/session/stage", { pid, stage: "instructions", payload: {} });
      state = await post("/session/stage", { pid, stage: "comprehension", payload: { value: COMPREHENSION.correct } });
      let mainDone = 0;
      while (state.trial && mainDone < options.questionsEach) {
        const trial = state.trial;
        const value = trial.demo?.expected === "C" ? "C" : trial.demo?.expected === "B" ? "B" : RESPONSES[Math.floor(Math.random() * RESPONSES.length)];
        const before = Date.now();
        state = await post("/session/answer", { pid, trialNo: trial.no, kind: trial.kind, value, rtMs: 1000, autofilled: true });
        latencies.push(Date.now() - before);
        if (trial.kind === "main") {
          const id = trial.demo?.tripletId ?? trial.reference;
          if (seen.has(id)) duplicateWithinParticipant++;
          seen.add(id);
          assignments.push(id);
          mainDone++;
          done++;
          options.onProgress?.(done, total);
        }
      }
      await post("/session/leave", { pid, reason: "back" });
    } catch (error) {
      failures++;
      errors.push(`${pid}: ${(error as Error).message}`);
    }
  };

  await Promise.all(Array.from({ length: options.participants }, (_, i) => participant(i)));
  latencies.sort((a, b) => a - b);
  return {
    participants: options.participants,
    questionsEach: options.questionsEach,
    totalAnswers: assignments.length,
    durationMs: Date.now() - started,
    medianSaveMs: latencies[Math.floor(latencies.length / 2)] ?? 0,
    p95SaveMs: latencies[Math.floor(latencies.length * 0.95)] ?? 0,
    retries,
    failures,
    duplicateWithinParticipant,
    assignments,
    pids,
    errors: errors.slice(0, 10),
  };
}
