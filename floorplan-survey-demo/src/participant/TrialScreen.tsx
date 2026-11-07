import { useCallback, useEffect, useRef, useState } from "react";
import { RESPONSE_OPTIONS } from "../../shared/content";
import { PublicTrial, ResponseValue } from "../../shared/types";
import { Band } from "./Screens";

type Slot = "reference" | "left" | "right";

interface Props {
  trial: PublicTrial;
  busy: boolean;
  forceImageFailure: boolean;
  onFailureConsumed: () => void;
  onSubmit: (value: ResponseValue, rtMs: number, imagesShownAt: string, zoomCount: number) => Promise<void>;
  onImageError: (url: string, simulated: boolean) => Promise<void>;
}

export function TrialScreen({ trial, busy, forceImageFailure, onFailureConsumed, onSubmit, onImageError }: Props) {
  const [value, setValue] = useState<ResponseValue | null>(null);
  const [ready, setReady] = useState(false);
  const [imageProblem, setImageProblem] = useState(false);
  const [zoom, setZoom] = useState<Slot | "all" | null>(null);
  const [retry, setRetry] = useState(0);
  const loaded = useRef(new Set<Slot>());
  const shownAt = useRef<{ perf: number; iso: string } | null>(null);
  const zoomCount = useRef(0);
  const submitted = useRef(false);
  const [failing] = useState(forceImageFailure);

  const urls: Record<Slot, string> = {
    reference: trial.reference,
    left: trial.left.url,
    right: trial.right.url,
  };
  const withRetry = (url: string) => (retry ? `${url}?retry=${retry}` : url);
  const src = (slot: Slot) => (failing && slot === "right" ? "/RPLAN_triplets/__demo_missing__/b.png" : withRetry(urls[slot]));

  const onLoaded = useCallback((slot: Slot) => {
    loaded.current.add(slot);
    if (loaded.current.size === 3) {
      // The clock starts once all three have actually been painted, as the brief defines it.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          shownAt.current = { perf: performance.now(), iso: new Date().toISOString() };
          setReady(true);
        }),
      );
    }
  }, []);

  const failedOnce = useRef(false);
  const onFailed = useCallback(
    (slot: Slot) => {
      if (failing) {
        onFailureConsumed();
        setImageProblem(true);
        void onImageError(trial.demo ? `${trial.demo.tripletId} (デモ用に意図的に発生させたエラー)` : urls[slot], true);
        return;
      }
      if (!failedOnce.current) {
        failedOnce.current = true;
        loaded.current.clear();
        setRetry((r) => r + 1);
        return;
      }
      setImageProblem(true);
      void onImageError(urls[slot], false);
    },
    // urls derives from trial, which is fixed for this component's lifetime (it is keyed by trial).
    [failing, onFailureConsumed, onImageError, trial],
  );

  const openZoom = (slot: Slot | "all") => {
    zoomCount.current++;
    setZoom(slot);
  };

  const confirm = () => {
    if (!value || !shownAt.current || busy || submitted.current) return;
    submitted.current = true;
    void onSubmit(value, Math.round(performance.now() - shownAt.current.perf), shownAt.current.iso, zoomCount.current).finally(() => {
      submitted.current = false;
    });
  };

  const practice = trial.kind === "practice";
  const title = practice ? `Practice ${trial.no} / ${trial.total}` : `Question ${trial.no} / ${trial.total}`;
  const progress = practice ? null : (trial.no - 1) / trial.total;

  return (
    <div className="trial-page">
      <Band title={title} progress={progress} note={practice ? "Practice answers are not used in the analysis." : undefined} />
      <main className="trial-layout">
        <section className="stage-wrap" aria-label="Floor plans">
          <div className={`stage ${ready ? "is-ready" : ""}`}>
            <figure className="plan plan-reference">
              <PlanImage src={src("reference")} alt="Reference floor plan A" onLoad={() => onLoaded("reference")} onError={() => onFailed("reference")} onZoom={() => openZoom("reference")} label="A" />
              <figcaption>A — Reference</figcaption>
            </figure>
            <figure className="plan plan-left">
              <PlanImage src={src("left")} alt={`Floor plan ${trial.left.label}`} onLoad={() => onLoaded("left")} onError={() => onFailed("left")} onZoom={() => openZoom("left")} label={trial.left.label} />
              <figcaption>{trial.left.label}</figcaption>
            </figure>
            <figure className="plan plan-right">
              <PlanImage src={src("right")} alt={`Floor plan ${trial.right.label}`} onLoad={() => onLoaded("right")} onError={() => onFailed("right")} onZoom={() => openZoom("right")} label={trial.right.label} />
              <figcaption>{trial.right.label}</figcaption>
            </figure>
          </div>
          {!ready && !imageProblem && <div className="stage-status">Loading floor plans…</div>}
          {imageProblem && <div className="stage-status">This question could not be displayed. Loading a replacement…</div>}
        </section>

        <section className="answer-panel" aria-label="Your answer">
          <div className="prompt-block">
            {trial.subPrompts?.slice(0, 2).map((text) => (
              <p className="prompt-sub" key={text}>
                {text}
              </p>
            ))}
            {!trial.subPrompts && <h1 className="prompt">{trial.prompt}</h1>}
            {trial.subPrompts?.[2] && <p className="prompt-note">{trial.subPrompts[2]}</p>}
          </div>
          <div className="option-grid" role="radiogroup" aria-label={trial.prompt}>
            {RESPONSE_OPTIONS.map((option) => (
              <label className={`choice ${value === option.value ? "is-selected" : ""}`} key={option.value}>
                <input type="radio" name="trial-answer" value={option.value} checked={value === option.value} onChange={() => setValue(option.value)} disabled={!ready} />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
          <div className="answer-actions">
            <button className="button primary wide" onClick={confirm} disabled={!value || !ready || busy}>
              {busy ? "Saving…" : "Continue"}
            </button>
            <p className="helper" aria-live="polite">
              {!value ? "Select an answer to continue." : " "}
            </p>
            <button className="link-button" onClick={() => openZoom("all")} disabled={!ready}>
              Enlarge all three plans
            </button>
          </div>
        </section>
      </main>
      {zoom && <Lightbox trial={trial} view={zoom} onView={setZoom} onClose={() => setZoom(null)} src={src} />}
    </div>
  );
}

function PlanImage({ src, alt, onLoad, onError, onZoom, label }: { src: string; alt: string; onLoad: () => void; onError: () => void; onZoom: () => void; label: string }) {
  const ref = useRef<HTMLImageElement>(null);
  const reported = useRef("");
  // A cached image may finish before React attaches onLoad.
  useEffect(() => {
    const image = ref.current;
    if (image?.complete && image.naturalWidth > 0 && reported.current !== src) {
      reported.current = src;
      onLoad();
    }
  });
  return (
    <button className="plan-frame" onClick={onZoom} aria-label={`Enlarge floor plan ${label}`}>
      <img
        ref={ref}
        src={src}
        alt={alt}
        draggable={false}
        onLoad={() => {
          if (reported.current !== src) {
            reported.current = src;
            onLoad();
          }
        }}
        onError={onError}
      />
      <span className="zoom-hint" aria-hidden="true">
        <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="8.5" cy="8.5" r="5.5" />
          <path d="M13 13l5 5M8.5 6v5M6 8.5h5" />
        </svg>
      </span>
    </button>
  );
}

function Lightbox({ trial, view, onView, onClose, src }: { trial: PublicTrial; view: Slot | "all"; onView: (v: Slot | "all") => void; onClose: () => void; src: (slot: Slot) => string }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const slots: { id: Slot; label: string; caption: string }[] = [
    { id: "reference", label: "A", caption: "A — Reference" },
    { id: "left", label: trial.left.label, caption: trial.left.label },
    { id: "right", label: trial.right.label, caption: trial.right.label },
  ];
  const shown = view === "all" ? slots : slots.filter((s) => s.id === view);

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Enlarged floor plans">
      <div className="lightbox-bar">
        <div className="segmented" role="tablist">
          {slots.map((s) => (
            <button key={s.id} role="tab" aria-selected={view === s.id} className={view === s.id ? "is-on" : ""} onClick={() => onView(s.id)}>
              {s.label}
            </button>
          ))}
          <button role="tab" aria-selected={view === "all"} className={view === "all" ? "is-on" : ""} onClick={() => onView("all")}>
            All three
          </button>
        </div>
        <button ref={closeRef} className="button ghost-dark" onClick={onClose}>
          Close
        </button>
      </div>
      <div className={`lightbox-stage count-${shown.length}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
        {shown.map((s) => (
          <figure key={s.id}>
            <img src={src(s.id)} alt={s.caption} draggable={false} />
            <figcaption>{s.caption}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}
