export const CONDITIONS = ["a", "b", "c", "d", "e", "f", "g"] as const;
export type Condition = (typeof CONDITIONS)[number];
/** Requested share of each extraction condition (2:1:1:2:1:1:2). */
export const CONDITION_WEIGHTS: Record<Condition, number> = { a: 2, b: 1, c: 1, d: 2, e: 1, f: 1, g: 2 };

export interface PoolItem {
  id: string;
  anchor: string;
  b: string;
  c: string;
  cond: Condition;
}

export type LabelMode = "follow_image" | "fixed_position";
export type Phase = "pilot" | "main";
export type SessionSource = "prolific" | "demo" | "simulated" | "loadtest";

export interface Settings {
  n: number;
  completionUrl: string;
  paused: boolean;
  phase: Phase;
  labelMode: LabelMode;
  /** How far above the current minimum load a planned condition may be before balance overrides it. */
  balanceTolerance: number;
  /** Seconds without a heartbeat before an open question is released. */
  heartbeatTimeoutSec: number;
  /** Seconds on one question, heartbeat or not, before it is released. */
  idleTimeoutSec: number;
  /** Seconds a closed/reloading tab may take to come back before its question is released. */
  leaveGraceSec: number;
  /** Seconds on the end screen before the automatic redirect. 0 means button only. */
  redirectSeconds: number;
  /** Remove attention-check failers from the per-question counts when they complete. */
  excludeFailedAttention: boolean;
  /** Reports from this many separate sessions take a question out of rotation. */
  imageErrorBlockThreshold: number;
  updatedAt: string;
}

export interface Lease {
  item: number;
  trialNo: number;
  leasedAt: number;
  leavingAt?: number;
  reason?: AssignmentReason;
  loadBefore?: number;
  minLoad?: number;
}

/** Shared allocation state: the single document every assignment goes through. */
export interface Ledger {
  answered: number[];
  reserved: number[];
  errorReports: number[];
  blocked: number[];
  leases: Record<string, Lease>;
  /** Highest trial already counted per participant, so a retried save never counts twice. */
  lastCommit: Record<string, number>;
  releasedTotal: number;
  overridesTotal: number;
}

export type AssignmentReason = "planned" | "balance_override" | "anchor_relaxed" | "last_resort";

export type TrialKind = "practice" | "main" | "attention";
export type ResponseValue = "B" | "C" | "equal" | "cannot_judge";

export interface Trial {
  no: number;
  kind: TrialKind;
  /** Pool index for main trials, otherwise -1. */
  item: number;
  tripletId: string;
  condition: string;
  anchorId: string;
  bId: string;
  cId: string;
  leftRole: "b" | "c";
  leftLabel: "B" | "C";
  rightLabel: "B" | "C";
  reason: AssignmentReason | "fixed";
  /** Attention checks only: the label the participant was told to select. */
  expected?: "B" | "C";
  prompt: string;
  imageBase: string;
  loadBefore?: number;
  minLoad?: number;
}

export type Stage =
  | "consent"
  | "instructions"
  | "comprehension"
  | "practice"
  | "main"
  | "post_aspects"
  | "post_most"
  | "post_difficulty"
  | "post_comments"
  | "demographics"
  | "complete"
  | "ended_comprehension"
  | "ended_declined";

export type SessionStatus =
  | "in_progress"
  | "dropped"
  | "completed"
  | "terminated_comprehension"
  | "declined";

/** One saved answer of any kind. This is the row shape the CSV export is built from. */
export interface ResponseRow {
  screenId: string;
  questionId: string;
  sessionId: string;
  kind: "consent" | "comprehension" | "practice" | "main" | "attention" | "post" | "demographic";
  trialNo?: number;
  tripletId?: string;
  condition?: string;
  anchorId?: string;
  bId?: string;
  cId?: string;
  leftImageId?: string;
  rightImageId?: string;
  leftLabel?: string;
  rightLabel?: string;
  value: string;
  text?: string;
  selectedImageId?: string;
  correct?: boolean;
  rtMs?: number;
  imagesShownAt?: string;
  answeredAt: string;
  zoomCount?: number;
  assignmentReason?: string;
  lateAfterRelease?: boolean;
  autofilled?: boolean;
}

export interface SessionEvent {
  at: string;
  type: string;
  detail?: string;
}

export interface Session {
  pid: string;
  studyId: string;
  sessionIds: string[];
  phase: Phase;
  source: SessionSource;
  status: SessionStatus;
  stage: Stage;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  n: number;
  total: number;
  attentionPositions: number[];
  /** Condition slots still to be presented, already in random order. */
  plan: Condition[];
  seenItems: number[];
  seenAnchors: string[];
  nextTrialNo: number;
  practiceIndex: number;
  current: Trial | null;
  /** Answer saved on the session but not yet counted in the ledger. */
  pendingCommit: { item: number; trialNo: number } | null;
  comprehensionAttempts: number;
  attentionPassed: number;
  attentionFailed: number;
  excludedFromBalance: boolean;
  aspects: string[];
  otherAspect: string;
  accessCount: number;
  responses: ResponseRow[];
  events: SessionEvent[];
}

export interface Heartbeat {
  at: number;
}

export interface ImageErrorRecord {
  at: string;
  pid: string;
  tripletId: string;
  url: string;
  kind: string;
  simulated: boolean;
}

/** A question as the browser receives it: never contains the attention-check answer. */
export interface PublicTrial {
  no: number;
  kind: TrialKind;
  total: number;
  answeredMain: number;
  prompt: string;
  subPrompts?: string[];
  reference: string;
  left: { url: string; label: string };
  right: { url: string; label: string };
  demo?: {
    tripletId: string;
    condition: string;
    reason: string;
    anchorId: string;
    leftRole: string;
    expected?: string;
    loadBefore?: number;
    minLoad?: number;
  };
}

export interface ParticipantState {
  stage: Stage;
  status: SessionStatus;
  pid: string;
  trial: PublicTrial | null;
  comprehensionAttempts: number;
  aspects: string[];
  otherAspect: string;
  completionUrl?: string;
  redirectSeconds: number;
  alreadyCompleted?: boolean;
  resumed?: boolean;
  duplicate?: boolean;
  paused?: boolean;
  demoMode: boolean;
  total: number;
}

export interface ConditionSummary {
  condition: Condition;
  items: number;
  answered: number;
  targetShare: number;
  actualShare: number;
  minAnswered: number;
  maxAnswered: number;
}

export interface AdminSummary {
  settings: Settings;
  poolSize: number;
  images: number;
  participants: {
    total: number;
    active: number;
    completed: number;
    dropped: number;
    terminated: number;
    declined: number;
    bySource: Record<string, number>;
    attentionFailed: number;
  };
  funnel: { stage: string; label: string; count: number }[];
  responses: { main: number; attention: number; practice: number; survey: number; total: number };
  balance: {
    min: number;
    max: number;
    mean: number;
    sd: number;
    reserved: number;
    blocked: number;
    histogram: { answered: number; items: number }[];
    overrides: number;
    releases: number;
  };
  conditions: ConditionSummary[];
  sessions: SessionSummary[];
  imageErrors: ImageErrorRecord[];
  importReport: unknown;
  defectReport: unknown;
  now: string;
  demoMode: boolean;
  releasedNow: number;
}

export interface SessionSummary {
  pid: string;
  studyId: string;
  sessionId: string;
  source: string;
  phase: string;
  status: SessionStatus;
  stage: Stage;
  mainAnswered: number;
  n: number;
  attentionPassed: number;
  attentionFailed: number;
  accessCount: number;
  updatedAt: string;
}

export interface ItemRow {
  index: number;
  id: string;
  condition: Condition;
  anchorId: string;
  answered: number;
  reserved: number;
  errorReports: number;
  blocked: boolean;
}
