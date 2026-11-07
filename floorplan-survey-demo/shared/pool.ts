import { Condition } from "./types";

/** Extraction condition is the middle token of the triplet id, e.g. 10015_a_1 → a. */
export function conditionOf(tripletId: string): Condition | null {
  const match = /^[^_]+_([a-g])_[^_]+$/.exec(tripletId);
  return match ? (match[1] as Condition) : null;
}
