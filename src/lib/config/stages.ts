/** Canonical pipeline stages, in pipeline order. */
export const CANONICAL_STAGES = [
  "Replied",
  "Interested - Positive Reply",
  "Loom sent",
  "Follow-up",
  "Not interested",
  "Appt Set",
  "Watched No Reply",
  "Watching Later",
  "Call Pushed",
  "Price Sent",
  "Follow Up Later",
  "Needs Reply",
  "In Conversation",
  "Won",
  "No Response",
] as const;
export type CanonicalStage = (typeof CANONICAL_STAGES)[number];

/** Stages that count as "Loom sent or later" in the post-Loom flow. */
export const POST_LOOM_STAGES: readonly CanonicalStage[] = [
  "Loom sent",
  "Watched No Reply",
  "Watching Later",
  "Call Pushed",
  "Price Sent",
  "Follow Up Later",
  "Needs Reply",
  "In Conversation",
  "Won",
  "No Response",
];
