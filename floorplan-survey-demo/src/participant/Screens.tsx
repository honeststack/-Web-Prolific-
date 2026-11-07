import { useEffect, useRef, useState } from "react";
import { ASPECTS, COMPREHENSION, CONSENT, DEMOGRAPHICS, EXTRA_ITEMS_BASE } from "../../shared/content";

export function Band({ title, progress, note }: { title: string; progress?: number | null; note?: string }) {
  return (
    <header className="band">
      <div className="band-row">
        <span className="band-title">{title}</span>
        {note && <span className="band-note">{note}</span>}
      </div>
      {progress !== undefined && progress !== null && (
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="Study progress">
          <div style={{ width: `${progress * 100}%` }} />
        </div>
      )}
    </header>
  );
}

function Page({ title, children, wide }: { title: string; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [title]);
  return (
    <div className="text-page">
      <Band title={title} />
      <main className={`sheet ${wide ? "sheet-wide" : ""}`}>{children}</main>
    </div>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="actions">{children}</div>;
}

function Choice({ type, name, checked, label, onChange }: { type: "radio" | "checkbox"; name: string; checked: boolean; label: string; onChange: () => void }) {
  return (
    <label className={`choice ${checked ? "is-selected" : ""}`}>
      <input type={type} name={name} checked={checked} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}

export function ConsentScreen({ busy, onSubmit }: { busy: boolean; onSubmit: (agree: boolean) => void }) {
  return (
    <Page title={CONSENT.title}>
      {CONSENT.sections.map((section) => (
        <section className="copy-block" key={section.heading}>
          <h2>{section.heading}</h2>
          <p>{section.body}</p>
        </section>
      ))}
      <Actions>
        <button className="button quiet" disabled={busy} onClick={() => onSubmit(false)}>
          I do not agree
        </button>
        <button className="button primary" disabled={busy} onClick={() => onSubmit(true)}>
          I agree and continue
        </button>
      </Actions>
    </Page>
  );
}

export function InstructionsScreen({ busy, onContinue }: { busy: boolean; onContinue: () => void }) {
  return (
    <Page title="How to read the floor plans">
      <div className="instructions">
        <div className="copy-block">
          <p>The diagram below is the example of floor plan.</p>
          <p>All diagrams use the same spatial canvas: 18 m × 18 m.</p>
          <p className="legend-heading">The colors represent as follows:</p>
          <ul className="color-legend">
            <li>
              <i style={{ background: "#000" }} /> Black <span>walls</span>
            </li>
            <li>
              <i style={{ background: "#fff" }} /> White <span>interior</span>
            </li>
            <li>
              <i style={{ background: "#cdcdcd" }} /> Gray <span>exterior</span>
            </li>
          </ul>
          <p>The orientation of the entrances is consistently downward.</p>
          <p>Room labels and furniture are not shown.</p>
        </div>
        <figure className="example-plan">
          <img src={`${EXTRA_ITEMS_BASE}/instructions/a.png`} alt="Example floor plan" />
        </figure>
      </div>
      <p className="callout">Compare the visible outline and room arrangement. Do not choose based on which home you would prefer.</p>
      <Actions>
        <button className="button primary" disabled={busy} onClick={onContinue}>
          Continue
        </button>
      </Actions>
    </Page>
  );
}

export function ComprehensionScreen({ busy, attempts, onSubmit }: { busy: boolean; attempts: number; onSubmit: (value: string) => void }) {
  const [value, setValue] = useState<string | null>(null);
  const retry = attempts > 0;
  return (
    <Page title={retry ? "Comprehension check — second attempt" : "Comprehension check"}>
      {retry && (
        <p className="notice" role="alert">
          Your first answer was incorrect. Please review the reminder and try once more.
        </p>
      )}
      <p className="callout">{COMPREHENSION.reminder}</p>
      <h2 className="question-title">{COMPREHENSION.question}</h2>
      <div className="choice-list" role="radiogroup">
        {COMPREHENSION.options.map((option) => (
          <Choice key={option.value} type="radio" name="comprehension" checked={value === option.value} label={option.label} onChange={() => setValue(option.value)} />
        ))}
      </div>
      <Actions>
        <button className="button primary" disabled={!value || busy} onClick={() => value && onSubmit(value)}>
          Submit answer
        </button>
      </Actions>
    </Page>
  );
}

function ReturnSteps() {
  return (
    <ol className="steps">
      <li>Close this survey tab.</li>
      <li>Return to the Prolific website.</li>
      <li>Click “Stop Without Completing” (or “Cancel participation”) to return your submission.</li>
    </ol>
  );
}

export function EndedComprehension() {
  return (
    <Page title="End of study — comprehension check">
      <p className="lead">You did not pass the comprehension check after two attempts, so you cannot continue with this study.</p>
      <p>Please follow these steps:</p>
      <ReturnSteps />
      <p className="thanks">Thank you for your time.</p>
    </Page>
  );
}

export function EndedDeclined() {
  return (
    <Page title="End of study">
      <p className="lead">You chose not to take part. No answers about floor plans have been recorded.</p>
      <p>Please follow these steps:</p>
      <ReturnSteps />
      <p className="thanks">Thank you for your time.</p>
    </Page>
  );
}

export function LeftScreen({ onReturn }: { onReturn: () => void }) {
  return (
    <Page title="You have left the study">
      <p className="lead">Using the browser's back button ends your current question, and earlier answers cannot be changed.</p>
      <p>The answers you already submitted are saved. If you would like to carry on, you can return and continue with new questions.</p>
      <Actions>
        <button className="button primary" onClick={onReturn}>
          Return to the study
        </button>
      </Actions>
    </Page>
  );
}

export function MessageScreen({ title, body }: { title: string; body: string[] }) {
  return (
    <Page title={title}>
      {body.map((text) => (
        <p className="lead" key={text}>
          {text}
        </p>
      ))}
    </Page>
  );
}

function OtherInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <input className="text-input other-input" aria-label="Describe other aspect" placeholder="Please describe" maxLength={500} value={value} onChange={(e) => onChange(e.target.value)} />;
}

export function AspectsScreen({ busy, options, onSubmit }: { busy: boolean; options: typeof ASPECTS; onSubmit: (values: string[], other: string) => void }) {
  const [values, setValues] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const toggle = (value: string) => setValues((current) => (current.includes(value) ? current.filter((v) => v !== value) : [...current, value]));
  const otherMissing = values.includes("other") && !other.trim();
  return (
    <Page title="About your judgement">
      <h2 className="question-title">Which aspects did you consider when judging similarity? Select all that apply.</h2>
      <div className="choice-list">
        {options.map((option) => (
          <div key={option.value}>
            <Choice type="checkbox" name="aspects" checked={values.includes(option.value)} label={option.label} onChange={() => toggle(option.value)} />
            {option.value === "other" && values.includes("other") && <OtherInput value={other} onChange={setOther} />}
          </div>
        ))}
      </div>
      <Actions>
        <button className="button primary" disabled={values.length === 0 || otherMissing || busy} onClick={() => onSubmit(values, other)}>
          Continue
        </button>
      </Actions>
    </Page>
  );
}

export function MostImportantScreen({ busy, chosen, otherText, onSubmit }: { busy: boolean; chosen: string[]; otherText: string; onSubmit: (value: string, other: string) => void }) {
  const [value, setValue] = useState<string | null>(chosen.length === 1 ? chosen[0] : null);
  const [other, setOther] = useState(otherText);
  const options = ASPECTS.filter((a) => chosen.includes(a.value));
  return (
    <Page title="Most important aspect">
      <h2 className="question-title">Which aspect did you consider most when judging similarity? Select one.</h2>
      <div className="choice-list" role="radiogroup">
        {options.map((option) => (
          <div key={option.value}>
            <Choice type="radio" name="most" checked={value === option.value} label={option.label} onChange={() => setValue(option.value)} />
            {option.value === "other" && value === "other" && <OtherInput value={other} onChange={setOther} />}
          </div>
        ))}
      </div>
      <Actions>
        <button className="button primary" disabled={!value || busy || (value === "other" && !other.trim())} onClick={() => value && onSubmit(value, other)}>
          Continue
        </button>
      </Actions>
    </Page>
  );
}

export function DifficultyScreen({ busy, options, onSubmit }: { busy: boolean; options: { value: string; label: string }[]; onSubmit: (value: string) => void }) {
  const [value, setValue] = useState<string | null>(null);
  return (
    <Page title="Overall difficulty">
      <h2 className="question-title">How difficult was it to compare the floor plans?</h2>
      <div className="choice-list" role="radiogroup">
        {options.map((option) => (
          <Choice key={option.value} type="radio" name="difficulty" checked={value === option.value} label={option.label} onChange={() => setValue(option.value)} />
        ))}
      </div>
      <Actions>
        <button className="button primary" disabled={!value || busy} onClick={() => value && onSubmit(value)}>
          Continue
        </button>
      </Actions>
    </Page>
  );
}

export function CommentsScreen({ busy, onSubmit }: { busy: boolean; onSubmit: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <Page title="Additional comments">
      <label className="question-title" htmlFor="comments">
        Was there anything that made the floor plans difficult to compare? Please share any comments about how you made your judgments.
      </label>
      <p className="helper-block">Optional.</p>
      <textarea id="comments" className="text-input" rows={6} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} />
      <Actions>
        <button className="button primary" disabled={busy} onClick={() => onSubmit(text)}>
          Continue
        </button>
      </Actions>
    </Page>
  );
}

export function DemographicsScreen({ busy, onSubmit }: { busy: boolean; onSubmit: (answers: Record<string, string>) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const complete = DEMOGRAPHICS.every((q) => answers[q.id]);
  const unanswered = DEMOGRAPHICS.filter((q) => !answers[q.id]).length;
  return (
    <Page title="About you" wide>
      <p className="lead">Finally, we'd like to ask about your background and experience.</p>
      <p className="helper-block">Questions marked * are required. You may select "Prefer not to say" where available.</p>
      <div className="demographics">
        {DEMOGRAPHICS.map((question) => (
          <fieldset key={question.id} className="question-set">
            <legend>{question.label}</legend>
            <div className="compact-choices">
              {question.options.map((option) => (
                <Choice key={option} type="radio" name={question.id} checked={answers[question.id] === option} label={option} onChange={() => setAnswers((a) => ({ ...a, [question.id]: option }))} />
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      <Actions>
        {!complete && <span className="helper">{unanswered} required {unanswered === 1 ? "question" : "questions"} left</span>}
        <button className="button primary" disabled={!complete || busy} onClick={() => onSubmit(answers)}>
          {busy ? "Saving…" : "Submit survey"}
        </button>
      </Actions>
    </Page>
  );
}

export function CompleteScreen({ completionUrl, redirectSeconds, alreadyCompleted, holdRedirect }: { completionUrl: string; redirectSeconds: number; alreadyCompleted: boolean; holdRedirect: boolean }) {
  const [left, setLeft] = useState(redirectSeconds);
  const [held, setHeld] = useState(alreadyCompleted);
  const go = useRef(() => window.location.assign(completionUrl));
  go.current = () => window.location.assign(completionUrl);

  useEffect(() => {
    if (held || !redirectSeconds || !completionUrl) return;
    if (left <= 0) {
      go.current();
      return;
    }
    const timer = setTimeout(() => setLeft((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [completionUrl, held, left, redirectSeconds]);

  return (
    <Page title="End of Study">
      <div className="end-card">
        <div className="end-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        </div>
        {alreadyCompleted ? (
          <>
            <h1>You have already completed this study.</h1>
            <p>Your responses were saved, and the study cannot be answered a second time.</p>
          </>
        ) : (
          <>
            <h1>Thank you for your time.</h1>
            <p>Your survey responses have been saved.</p>
            <p>Please click the button below and register your completion.</p>
          </>
        )}
        <button className="button primary" onClick={() => go.current()} disabled={!completionUrl}>
          Return to Prolific
        </button>
        {!held && redirectSeconds > 0 && (
          <p className="helper">
            Redirecting automatically in {left} second{left === 1 ? "" : "s"}.
            {holdRedirect && (
              <button className="link-button inline" onClick={() => setHeld(true)}>
                停止（デモ用）
              </button>
            )}
          </p>
        )}
      </div>
    </Page>
  );
}
