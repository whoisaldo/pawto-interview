import type { AiPolicy } from "./api";

/** The two AI policies, in the words used wherever one is chosen. */
export const AI_OPTIONS: { value: AiPolicy; label: string; hint: string }[] = [
  { value: "allowed", label: "AI allowed", hint: "The candidate can ask Codex in the room. You see every question." },
  { value: "disabled", label: "AI off", hint: "The assistant is not offered and cannot be reached." },
];
