/**
 * Participant-facing wording, taken from 画面遷移イメージ_v2.pptx.
 * Corrections made to the source wording are listed in docs/デモ説明ガイド.md.
 */
import { ResponseValue } from "./types";

export const RESPONSE_OPTIONS: { value: ResponseValue; label: string }[] = [
  { value: "B", label: "Floor plan B." },
  { value: "C", label: "Floor plan C." },
  { value: "equal", label: "Both are equally similar." },
  { value: "cannot_judge", label: "I cannot judge from these images." },
];

export const CONSENT = {
  title: "Study information and consent",
  sections: [
    {
      heading: "Purpose",
      body: "We study how people perceive similarities between apartment floor plans. Responses will be used to evaluate and calibrate a computational similarity measure.",
    },
    {
      heading: "Your Task",
      body: "For each question, compare a reference (A) with two alternatives (B and C). Indicate which looks more similar to A, or select a tie / unable-to-judge response. This is not a housing-preference survey.",
    },
    {
      heading: "Data and rights",
      body: "We will record your responses, Prolific participant ID and background answers. Data will be stored securely and analyzed for research.",
    },
  ],
};

export const COMPREHENSION = {
  questionId: "comprehension_task",
  reminder: "Reminder: choose the plan that looks more similar to reference A, based on the visible layout.",
  question: "What is your task when comparing floor plans B and C?",
  correct: "more_similar",
  options: [
    { value: "prefer", label: "Which apartment I would prefer to live in." },
    { value: "more_similar", label: "Which floor plan is more similar to A." },
    { value: "fashion", label: "Which apartment would be more in fashion than A." },
    { value: "expensive", label: "Which apartment would be more expensive than A." },
  ],
};

export const ASPECTS = [
  { value: "overall_shape", label: "Overall floor plan shape" },
  { value: "room_count", label: "Number of rooms" },
  { value: "room_sizes", label: "Room sizes" },
  { value: "room_arrangement", label: "Arrangement of rooms" },
  { value: "room_connections", label: "Connections between rooms" },
  { value: "entrance_corridors", label: "Position of entrance and corridors" },
  { value: "intended_use", label: "Speculation of the room's intended use" },
  { value: "other", label: "Other" },
];

export const DIFFICULTY = [
  { value: "1", label: "1 — Very easy" },
  { value: "2", label: "2 — Somewhat easy" },
  { value: "3", label: "3 — Neither easy nor difficult" },
  { value: "4", label: "4 — Somewhat difficult" },
  { value: "5", label: "5 — Very difficult" },
];

export const DEMOGRAPHICS: { id: string; label: string; options: string[] }[] = [
  { id: "age_group", label: "1. What is your age group? *", options: ["18 – 24", "25 – 34", "35 – 44", "45 – 54", "55 – 64", "65 or older", "Prefer not to say"] },
  { id: "gender", label: "2. What is your gender? *", options: ["Woman", "Man", "Non-binary / Another gender", "Prefer not to say"] },
  {
    id: "education",
    label: "3. What is the highest level of education you have completed? *",
    options: ["Secondary school or below", "Vocational / Technical qualification", "Some college / University (no degree)", "Bachelor's degree", "Master's degree", "Doctoral degree", "Other / Prefer not to say"],
  },
  {
    id: "architecture_background",
    label: "4. Have you received education or worked in architecture, interior design, or building design? *",
    options: ["No, neither", "Yes, education only", "Yes, professional experience only", "Yes, both education and professional experience", "Prefer not to say"],
  },
  { id: "moves", label: "5. How many times have you moved to a different home in your lifetime? *", options: ["0", "1", "2–3", "4–5", "6–9", "10 or more", "Not sure / Prefer not to say"] },
  {
    id: "floorplan_familiarity",
    label: "6. How familiar are you with reading residential floor plans? *",
    options: ["1 — Not at all familiar", "2 — Slightly familiar", "3 — Moderately familiar", "4 — Very familiar", "5 — Extremely familiar"],
  },
];

export const MAIN_PROMPT = "Which floor plan is more similar to A?";

export function attentionPrompt(label: "B" | "C"): string {
  return `For this question only, select “Floor plan ${label}” regardless of similarity.`;
}

export const PRACTICE_PROMPTS = [
  "The floor plan at the top is the reference A.",
  "Please choose which of the two floor plans below (B or C) is more similar to A.",
  "Some comparisons may be difficult. Please make your best judgment.",
];

/** Placeholder sets: the client will supply the real practice and attention-check plans. */
export const PRACTICE_ITEMS = ["practice_1", "practice_2"];
export const ATTENTION_ITEMS: { id: string; expected: "B" | "C" }[] = [
  { id: "attention_1", expected: "B" },
  { id: "attention_2", expected: "C" },
];
export const EXTRA_ITEMS_BASE = "/survey_items";
