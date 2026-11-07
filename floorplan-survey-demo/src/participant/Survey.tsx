import { useCallback, useEffect, useRef, useState } from "react";
import { ASPECTS, COMPREHENSION, DEMOGRAPHICS, DIFFICULTY } from "../../shared/content";
import { ParticipantState, ResponseValue, Stage } from "../../shared/types";
import { beacon, postParticipant } from "../api";
import { DemoGuide } from "../demo/DemoGuide";
import { AspectsScreen, CommentsScreen, CompleteScreen, ComprehensionScreen, ConsentScreen, DemographicsScreen, DifficultyScreen, EndedComprehension, EndedDeclined, InstructionsScreen, LeftScreen, MessageScreen, MostImportantScreen } from "./Screens";
import { TrialScreen } from "./TrialScreen";

export interface SurveyParams {
  hasAny: boolean;
  pid: string | null;
  studyId: string | null;
  sessionId: string | null;
  demo: boolean;
  source: string | null;
  failImage: boolean;
}

export function surveyParams(): SurveyParams {
  const q = new URLSearchParams(window.location.search);
  const pid = q.get("PROLIFIC_PID");
  const studyId = q.get("STUDY_ID");
  const sessionId = q.get("SESSION_ID");
  return {
    hasAny: Boolean(pid || studyId || sessionId),
    pid,
    studyId,
    sessionId,
    demo: q.get("demo") === "1",
    source: q.get("demo") === "1" ? "demo" : null,
    failImage: q.get("demo") === "1" && q.get("failImage") === "1",
  };
}

const AUTOFILL_AFTER_MAIN: { stage: Stage; payload: Record<string, unknown> }[] = [
  { stage: "post_aspects", payload: { values: ["room_arrangement", "overall_shape"] } },
  { stage: "post_most", payload: { value: "room_arrangement" } },
  { stage: "post_difficulty", payload: { value: "3" } },
  { stage: "post_comments", payload: { text: "" } },
  { stage: "demographics", payload: { answers: Object.fromEntries(DEMOGRAPHICS.map((q) => [q.id, q.options[0]])) } },
];

export function Survey({ params }: { params: SurveyParams }) {
  const [state, setState] = useState<ParticipantState | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(false);
  const failImageUsed = useRef(false);
  const pid = params.pid ?? "";
  const stateRef = useRef(state);
  stateRef.current = state;

  const call = useCallback(async (path: string, payload: unknown): Promise<ParticipantState | null> => {
    setBusy(true);
    try {
      const next = await postParticipant(path, payload, setRetrying);
      setState(next);
      return next;
    } catch {
      setFatal("Something went wrong. Please reload this page; your saved answers are safe.");
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const enter = useCallback(() => {
    setLeft(false);
    return call("/session/enter", { pid, studyId: params.studyId, sessionId: params.sessionId, source: params.source });
  }, [call, params.sessionId, params.source, params.studyId, pid]);

  const entered = useRef(false);
  useEffect(() => {
    if (entered.current) return;
    entered.current = true;
    if (!params.pid || !params.studyId || !params.sessionId) {
      setFatal("This study link is missing required information. Please open the study from Prolific.");
      return;
    }
    void enter();
  }, [enter, params.pid, params.sessionId, params.studyId]);

  const active = Boolean(state && state.status === "in_progress" && !state.paused && !left);

  useEffect(() => {
    if (!active) return;
    const send = () => void fetch("/api/session/heartbeat", { method: "POST", body: JSON.stringify({ pid }) }).catch(() => undefined);
    send();
    const timer = setInterval(send, 30_000);
    return () => clearInterval(timer);
  }, [active, pid]);

  useEffect(() => {
    if (!active) return;
    // A sentinel history entry turns the browser's back button into a detectable event.
    window.history.pushState({ survey: true }, "");
    const onPop = () => {
      beacon("/session/leave", { pid, reason: "back" });
      setLeft(true);
    };
    const onHide = () => beacon("/session/leave", { pid, reason: "pagehide" });
    window.addEventListener("popstate", onPop);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("pagehide", onHide);
    };
  }, [active, pid]);

  const submitStage = useCallback((stage: Stage, payload: Record<string, unknown>) => call("/session/stage", { pid, stage, payload }), [call, pid]);

  const submitAnswer = useCallback(
    async (value: ResponseValue, rtMs: number, imagesShownAt: string, zoomCount: number) => {
      const trial = stateRef.current?.trial;
      if (!trial) return;
      await call("/session/answer", { pid, trialNo: trial.no, kind: trial.kind, value, rtMs, imagesShownAt, zoomCount, sessionId: params.sessionId });
    },
    [call, params.sessionId, pid],
  );

  const reportImageError = useCallback(
    async (url: string, simulated: boolean) => {
      const trial = stateRef.current?.trial;
      if (!trial) return;
      await call("/session/image-error", { pid, trialNo: trial.no, url, simulated });
    },
    [call, pid],
  );

  /* Demo-only shortcuts: they go through the real API, and every row they create is marked autofilled. */
  const autoAnswer = useCallback(
    async (until: (s: ParticipantState) => boolean) => {
      setBusy(true);
      let current = stateRef.current;
      while (current?.trial && !until(current)) {
        const t: NonNullable<ParticipantState["trial"]> = current.trial;
        const expected = t.demo?.expected as ResponseValue | undefined;
        const value: ResponseValue = expected ?? (["B", "C", "B", "C", "equal"] as ResponseValue[])[t.no % 5];
        current = await postParticipant("/session/answer", { pid, trialNo: t.no, kind: t.kind, value, rtMs: 2000 + (t.no % 7) * 500, autofilled: true, sessionId: params.sessionId }, setRetrying);
        setState(current);
      }
      setBusy(false);
      return current;
    },
    [params.sessionId, pid],
  );

  const demoTools = {
    toAttentionFromHere: async () => {
      const startKind = stateRef.current?.trial?.kind;
      const startNo = startKind === "main" || startKind === "attention" ? (stateRef.current?.trial?.no ?? 0) : 0;
      await autoAnswer((s) => (s.stage !== "main" && s.stage !== "practice") || (s.trial?.kind === "attention" && s.trial.no > startNo));
    },
    toEndOfMain: async () => {
      await autoAnswer((s) => s.stage !== "main" && s.stage !== "practice");
    },
    pass: async () => {
      let current = stateRef.current;
      if (current?.stage === "consent") current = await submitStage("consent", { agree: true });
      if (current?.stage === "instructions") current = await submitStage("instructions", {});
      if (current?.stage === "comprehension") await submitStage("comprehension", { value: COMPREHENSION.correct });
    },
    finishSurvey: async () => {
      let current = stateRef.current;
      for (const step of AUTOFILL_AFTER_MAIN) {
        if (current?.stage === step.stage) current = await submitStage(step.stage, step.payload);
      }
    },
  };

  const failFirstMain = params.failImage && !failImageUsed.current && state?.trial?.kind === "main";
  const onFailConsumed = useCallback(() => {
    failImageUsed.current = true;
  }, []);

  let screen: React.ReactNode;
  if (fatal) screen = <MessageScreen title="Unable to continue" body={[fatal]} />;
  else if (!state) screen = <div className="page-loading" aria-label="Loading" />;
  else if (left) screen = <LeftScreen onReturn={() => void enter()} />;
  else if (state.paused) screen = <MessageScreen title="This study is paused" body={["The study is temporarily paused. Please try again later. No answers have been recorded."]} />;
  else {
    switch (state.stage) {
      case "consent":
        screen = <ConsentScreen busy={busy} onSubmit={(agree) => void submitStage("consent", { agree })} />;
        break;
      case "instructions":
        screen = <InstructionsScreen busy={busy} onContinue={() => void submitStage("instructions", {})} />;
        break;
      case "comprehension":
        screen = <ComprehensionScreen key={state.comprehensionAttempts} busy={busy} attempts={state.comprehensionAttempts} onSubmit={(value) => void submitStage("comprehension", { value })} />;
        break;
      case "ended_comprehension":
        screen = <EndedComprehension />;
        break;
      case "ended_declined":
        screen = <EndedDeclined />;
        break;
      case "practice":
      case "main":
        screen = state.trial ? (
          <TrialScreen key={`${state.trial.kind}-${state.trial.no}-${state.trial.reference}`} trial={state.trial} busy={busy} forceImageFailure={failFirstMain} onFailureConsumed={onFailConsumed} onSubmit={submitAnswer} onImageError={reportImageError} />
        ) : (
          <div className="page-loading" />
        );
        break;
      case "post_aspects":
        screen = <AspectsScreen busy={busy} options={ASPECTS} onSubmit={(values, other) => void submitStage("post_aspects", { values, other })} />;
        break;
      case "post_most":
        screen = <MostImportantScreen busy={busy} chosen={state.aspects} otherText={state.otherAspect} onSubmit={(value, other) => void submitStage("post_most", { value, other })} />;
        break;
      case "post_difficulty":
        screen = <DifficultyScreen busy={busy} options={DIFFICULTY} onSubmit={(value) => void submitStage("post_difficulty", { value })} />;
        break;
      case "post_comments":
        screen = <CommentsScreen busy={busy} onSubmit={(text) => void submitStage("post_comments", { text })} />;
        break;
      case "demographics":
        screen = <DemographicsScreen busy={busy} onSubmit={(answers) => void submitStage("demographics", { answers })} />;
        break;
      case "complete":
        screen = <CompleteScreen completionUrl={state.completionUrl ?? ""} redirectSeconds={state.redirectSeconds} alreadyCompleted={Boolean(state.alreadyCompleted)} holdRedirect={params.demo} />;
        break;
    }
  }

  return (
    <>
      {retrying && (
        <div className="connection-banner" role="status">
          Connection problem. Your answer has not been lost; we are trying to save it again…
        </div>
      )}
      {screen}
      {params.demo && state && <DemoGuide state={state} left={left} busy={busy} tools={demoTools} params={params} onBackTest={() => window.history.back()} />}
    </>
  );
}
