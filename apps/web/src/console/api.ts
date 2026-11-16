import { api } from "../lib/api";
import { getSessionToken, reportUnauthorized } from "../lib/auth";
import { API_BASE_URL } from "../lib/config";

export type AiPolicy = "allowed" | "disabled";
export type SessionStatus = "scheduled" | "running" | "paused" | "ended";
export type Role = "interviewer" | "candidate";
export type Dimension = "clarification" | "verification" | "understanding" | "ownership";
export type Score = 0 | 1 | 2 | null;
export type Recommendation = "undecided" | "advance" | "hold" | "decline";

export const DIMENSIONS: Dimension[] = ["clarification", "verification", "understanding", "ownership"];

export interface Clock {
  status: SessionStatus;
  durationSeconds: number;
  elapsedSeconds: number;
  remainingSeconds: number;
  runningSince: string | null;
  startedAt: string | null;
  endedAt: string | null;
  serverNow: string;
}

export interface LastRun {
  status: string;
  publicPassed: number;
  publicTotal: number;
  heldBackPassed: number;
  heldBackTotal: number;
}

export interface EvaluationSummary {
  scores: Record<Dimension, Score>;
  recommendation: Recommendation;
  updatedAt: string;
}

export interface SessionSummary extends Clock {
  id: string;
  title: string;
  candidateName: string;
  candidateEmail: string | null;
  candidateJoined: boolean;
  problemId: string;
  problemSlug: string;
  problemTitle: string;
  problemDifficulty: string | null;
  aiPolicy: AiPolicy;
  inviteCode: string;
  roomId: string;
  heldBackRevealed: boolean;
  isSample: boolean;
  createdAt: string;
  updatedAt: string;
  runs: { count: number; lastRunAt: string | null; last: LastRun | null };
  assistant: { turns: number; costUsd: number; inputTokens: number; outputTokens: number };
  evaluation: EvaluationSummary | null;
}

export interface Case {
  index: number;
  name: string;
  input: string;
  expected: string;
}

export interface GuidePhase {
  minutes: number;
  phase: string;
  detail: string;
}

export interface Guide {
  timeline?: GuidePhase[];
  changeRequest?: { prompt: string; listenFor: string[] };
  heldBackNote?: string;
  extension?: string;
}

export interface Brief {
  id: string;
  slug: string;
  title: string;
  difficulty: string | null;
  statement: string | null;
  acceptanceCriteria: string[];
  starterCode: string | null;
  timeLimitMs: number;
  memLimitMb: number;
  examples: Case[];
  heldBackCount: number;
  edited: { statement: boolean; acceptanceCriteria: boolean; starterCode: boolean };
}

export interface AssistantAvailability {
  state:
    | "ready"
    | "policy_off"
    | "not_configured"
    | "misconfigured"
    | "not_running"
    | "ended"
    | "limit_reached";
  detail: string;
  model: string | null;
  effort: string | null;
  limits: {
    codeBytes: number;
    promptBytes: number;
    outputBytes: number;
    timeoutSeconds: number | null;
    turnsPerSession: number;
  };
  turnsUsed: number;
}

export interface EvidenceDefinition {
  key: Dimension;
  label: string;
  prompt: string;
}

export interface SessionView extends Clock {
  id: string;
  title: string;
  role: Role;
  candidateName: string;
  aiPolicy: AiPolicy;
  roomId: string;
  isSample: boolean;
  problem: Brief;
  heldBackRevealed: boolean;
  heldBack: Case[] | null;
  evidence: EvidenceDefinition[] | null;
  assistant: AssistantAvailability;
  interviewer: {
    candidateEmail: string | null;
    candidateJoined: boolean;
    inviteCode: string;
    createdAt: string;
    guide: Guide | null;
    provenance: string | null;
    referenceCode: string | null;
    library: { statement: string | null; acceptanceCriteria: string[]; starterCode: string | null };
    canRevealHeldBack: boolean;
  } | null;
}

export interface RunCase extends Case {
  ran: boolean;
  passed: boolean | null;
  timeMs?: number | null;
  stdout?: string;
  stderr?: string;
}

export interface RunView {
  id: string;
  userId: string;
  userName: string | null;
  createdAt: string;
  state: "pending" | "running" | "judged";
  public: {
    passed: number;
    total: number;
    status: string | null;
    timeMs: number | null;
    cases: RunCase[];
  };
  heldBackCount: number;
  heldBack: { passed: number; total: number; cases: RunCase[] } | null;
  overallStatus?: string | null;
  judgeFailed: boolean;
  code?: string | null;
}

export interface TurnUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
  firstTokenMs: number | null;
}

export type TurnStatus = "running" | "completed" | "cancelled" | "failed" | "timeout" | "truncated";

export interface Turn {
  id: string;
  sessionId: string;
  conversationId: string;
  userId: string;
  userName: string | null;
  askedAs: Role;
  question: string;
  context: { kind: "problem" | "code" | "test-results"; bytes: number }[];
  promptBytes: number;
  answer: string;
  status: TurnStatus;
  error: string | null;
  model: string | null;
  effort: string | null;
  usage: TurnUsage;
  createdAt: string;
  finishedAt: string | null;
}

export interface Evaluation {
  sessionId: string;
  evidence: Record<Dimension, { score: Score; note: string }>;
  summary: string;
  recommendation: Recommendation;
  updatedBy: string | null;
  updatedByName: string | null;
  updatedAt: string | null;
  saved: boolean;
}

export interface Rubric {
  evidence: EvidenceDefinition[];
  scores: { value: 0 | 1 | 2; label: string }[];
  unobserved: string;
  recommendations: { value: Recommendation; label: string }[];
}

export interface LibraryProblem {
  id: string;
  slug: string;
  title: string;
  difficulty: string | null;
  statement: string | null;
  starterCode: string | null;
  timeLimitMs: number;
  memLimitMb: number;
  examples: Case[];
  heldBack: Case[];
  sessionCount: number;
  hasGuide: boolean;
  summary: string | null;
  acceptanceCriteria: string[];
  provenance: string | null;
  guide: Guide | null;
  referenceCode: string | null;
  recommendedDurationSeconds: number | null;
}

export interface InterviewSettings {
  defaultDurationSeconds: number;
  defaultAiPolicy: AiPolicy;
  updatedAt: string;
}

export interface SystemStatus {
  authMode: "clerk" | "demo";
  judge: { waiting: number; oldestWaitingSeconds: number | null; lastJudgedAt: string | null };
  assistant: {
    configured: boolean;
    ready: boolean;
    problem: string | null;
    launcher: string | null;
    profile: string | null;
    model: string | null;
    effort: string | null;
    limits: AssistantAvailability["limits"];
    running: number;
    maxRunning: number;
  };
}

export interface AssistantTest {
  ok: boolean;
  status: string;
  error: string | null;
  answer: string;
  usage: {
    model: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    durationMs: number | null;
    firstTokenMs: number | null;
  } | null;
}

export interface BriefEdit {
  statement?: string | null;
  acceptanceCriteria?: string[] | null;
  starterCode?: string | null;
}

export interface InterviewInput {
  title: string;
  candidateName: string;
  candidateEmail?: string | null;
  problemId: string;
  durationSeconds: number;
  aiPolicy: AiPolicy;
  brief?: BriefEdit;
}

/** What the API said went wrong, in its own words where it gave any. */
export const errorMessage = (error: unknown, fallback = "Something went wrong. Try again."): string => {
  const response = (error as { response?: { data?: { detail?: unknown }; status?: number } }).response;
  const detail = response?.data?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail.length > 0) {
    const first = detail[0] as { msg?: string; loc?: unknown[] };
    const field = Array.isArray(first.loc) ? first.loc[first.loc.length - 1] : null;
    return `${field ? `${String(field)}: ` : ""}${first.msg ?? "Not valid"}`;
  }
  if (!response) return "Could not reach the server.";
  return fallback;
};

export const errorStatus = (error: unknown): number | undefined =>
  (error as { response?: { status?: number } }).response?.status;

const get = async <T>(path: string): Promise<T> => (await api.get(path)).data;

export const interviewApi = {
  list: () => get<SessionSummary[]>("/interviews"),
  summary: (id: string) => get<SessionSummary>(`/interviews/${id}/summary`),
  view: (id: string) => get<SessionView>(`/interviews/${id}`),
  create: async (input: InterviewInput): Promise<SessionSummary> => (await api.post("/interviews", input)).data,
  update: async (id: string, changes: Partial<InterviewInput>): Promise<SessionSummary> =>
    (await api.patch(`/interviews/${id}`, changes)).data,
  act: async (id: string, action: "start" | "pause" | "end" | "reset"): Promise<SessionSummary> =>
    (await api.post(`/interviews/${id}/${action}`)).data,
  reveal: async (id: string, revealed: boolean): Promise<SessionSummary> =>
    (await api.put(`/interviews/${id}/held-back`, { revealed })).data,
  join: async (inviteCode: string): Promise<{ sessionId: string }> =>
    (await api.post("/interviews/join", { inviteCode })).data,

  runs: (id: string) => get<RunView[]>(`/interviews/${id}/runs`),
  run: (id: string, runId: string) => get<RunView>(`/interviews/${id}/runs/${runId}`),

  evaluation: (id: string) => get<Evaluation>(`/interviews/${id}/evaluation`),
  saveEvaluation: async (
    id: string,
    body: Pick<Evaluation, "evidence" | "summary" | "recommendation">,
  ): Promise<Evaluation> => (await api.put(`/interviews/${id}/evaluation`, body)).data,
  exportEvaluation: async (id: string, format: "json" | "markdown"): Promise<string> =>
    (
      await api.get(`/interviews/${id}/evaluation/export`, {
        params: { format },
        responseType: "text",
        transformResponse: (data) => data,
      })
    ).data,

  rubric: () => get<Rubric>("/interviews/rubric"),
  library: () => get<LibraryProblem[]>("/interviews/problems"),
  settings: () => get<InterviewSettings>("/interviews/settings"),
  saveSettings: async (body: Pick<InterviewSettings, "defaultDurationSeconds" | "defaultAiPolicy">) =>
    (await api.put("/interviews/settings", body)).data as InterviewSettings,
  system: () => get<SystemStatus>("/interviews/system"),
  testAssistant: async (): Promise<AssistantTest> => (await api.post("/interviews/assistant/test")).data,

  turns: (id: string) => get<Turn[]>(`/interviews/${id}/assistant/turns`),
  cancelTurn: async (id: string, turnId: string) =>
    (await api.post(`/interviews/${id}/assistant/turns/${turnId}/cancel`)).data,
};

export interface AskInput {
  question: string;
  context: { prompt: boolean; code: boolean; tests: boolean };
  code?: string;
  conversationId?: string;
}

export interface AskHandlers {
  onTurn: (turn: Turn) => void;
  onStarted: (model: string | null) => void;
  onThinking: () => void;
  onDelta: (text: string) => void;
  onDone: (turn: Turn) => void;
}

/** Why a question was refused before any answer began. */
export class AskRefused extends Error {
  readonly state: string | null;
  readonly status: number;

  constructor(message: string, status: number, state: string | null) {
    super(message);
    this.status = status;
    this.state = state;
  }
}

/**
 * Ask the assistant one question and read the answer as it is written.
 *
 * A stream, so fetch rather than axios. It resolves when the server has said
 * how the turn ended; it rejects with AskRefused when the question was never
 * taken, and with whatever fetch throws when the connection drops, including
 * the caller's own abort.
 */
export const askAssistant = async (
  sessionId: string,
  input: AskInput,
  handlers: AskHandlers,
  signal: AbortSignal,
): Promise<void> => {
  const token = await getSessionToken();
  if (!token) throw new AskRefused("You are signed out.", 401, null);

  const response = await fetch(`${API_BASE_URL}/interviews/${sessionId}/assistant/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
    signal,
  });

  if (!response.ok || !response.body) {
    if (response.status === 401) reportUnauthorized();
    let detail = "The assistant could not take the question.";
    try {
      const body = await response.json();
      detail = errorMessage({ response: { data: body, status: response.status } }, detail);
    } catch {
      // Not JSON: keep the plain sentence.
    }
    throw new AskRefused(detail, response.status, response.headers.get("X-Assistant-State"));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;

  const dispatch = (block: string) => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (data.length === 0) return;
    const payload = JSON.parse(data.join("\n"));
    if (event === "turn") handlers.onTurn(payload);
    else if (event === "started") handlers.onStarted(payload.model ?? null);
    else if (event === "thinking") handlers.onThinking();
    else if (event === "delta") handlers.onDelta(payload.text);
    else if (event === "done") {
      finished = true;
      handlers.onDone(payload);
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      dispatch(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
  }
  if (!finished) throw new Error("The connection closed before the answer finished.");
};
