// Questions put to the assistant and what came back, with what was attached
// and what each one used. The interviewer and the candidate read the same
// record through this.

import Markdown from "react-markdown";
import type { Role, Turn } from "../api";
import { bytesText, countText, secondsText, timeOfDay, usdText } from "../format";
import { cn } from "../classes";
import { Figure, Note, Pill } from "../ui";

const CONTEXT_WORDS: Record<string, string> = {
  problem: "problem",
  code: "code",
  "test-results": "test results",
};

/** What the asker attached, by name and size. "Nothing attached" is an answer too. */
export const ContextSent = ({ turn }: { turn: Turn }) => (
  <p className="text-xs text-faint">
    {turn.context.length === 0
      ? "Nothing attached"
      : `Attached: ${turn.context.map((item) => `${CONTEXT_WORDS[item.kind] ?? item.kind} ${bytesText(item.bytes)}`).join(", ")}`}
  </p>
);

/** Everything sent for a turn. With prompt caching most of it is counted as cache tokens. */
const sentTokens = (turn: Turn): number | null =>
  turn.usage.inputTokens === null
    ? null
    : turn.usage.inputTokens + (turn.usage.cacheReadTokens ?? 0) + (turn.usage.cacheWriteTokens ?? 0);

/** Model, tokens, time and cost for one answer. Shown for every finished turn. */
export const UsageLine = ({ turn, configuredModel }: { turn: Turn; configuredModel?: string | null }) => {
  const { usage } = turn;
  const parts: string[] = [];
  const sent = sentTokens(turn);
  if (sent !== null && usage.outputTokens !== null) {
    parts.push(`${countText(sent)} in, ${countText(usage.outputTokens)} out tokens`);
  }
  if (usage.durationMs !== null) parts.push(secondsText(usage.durationMs));
  if (usage.costUsd !== null) parts.push(`${usdText(usage.costUsd)} at list price`);
  const substituted = Boolean(configuredModel && turn.model && turn.model !== configuredModel);
  return (
    <p className="text-xs text-faint">
      <Figure className={substituted ? "text-warning" : undefined}>{turn.model ?? "model not reported"}</Figure>
      {turn.effort && <span>, {turn.effort} effort</span>}
      {substituted && <span className="text-warning"> (configured: {configuredModel})</span>}
      {parts.length > 0 && <span> · {parts.join(" · ")}</span>}
    </p>
  );
};

const STATUS_NOTE: Partial<Record<Turn["status"], { tone: "negative" | "warning" | "muted"; text: string }>> = {
  failed: { tone: "negative", text: "No answer." },
  timeout: { tone: "negative", text: "Stopped: it took too long." },
  cancelled: { tone: "muted", text: "Stopped before it finished." },
  truncated: { tone: "warning", text: "Cut off at the size limit." },
};

export const Answer = ({ text, streaming }: { text: string; streaming?: boolean }) => (
  <div className={cn("prose-answer text-pretty break-words text-ink", streaming && "min-h-5")} aria-live={streaming ? "polite" : undefined}>
    <Markdown>{text}</Markdown>
  </div>
);

export const TurnBlock = ({
  turn,
  viewer,
  configuredModel,
  streamingText,
  thinking,
  compact = false,
}: {
  turn: Turn;
  viewer: Role;
  configuredModel?: string | null;
  /** While this turn is being answered here, the text so far. */
  streamingText?: string;
  thinking?: boolean;
  compact?: boolean;
}) => {
  const live = turn.status === "running";
  const text = live ? (streamingText ?? "") : turn.answer;
  const note = STATUS_NOTE[turn.status];
  const asker =
    turn.askedAs === viewer ? "You" : turn.askedAs === "candidate" ? (turn.userName ?? "Candidate") : "Interviewer";
  return (
    <article className="space-y-2 px-4 py-3">
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-medium text-ink">{asker}</span>
        {viewer === "interviewer" && !compact && (
          <Pill>{turn.askedAs === "candidate" ? "Candidate" : "Interviewer"}</Pill>
        )}
        {!compact && <Figure className="text-xs text-faint">{timeOfDay(turn.createdAt)}</Figure>}
      </header>
      <p className="text-pretty break-words whitespace-pre-wrap text-ink">{turn.question}</p>
      {!compact && <ContextSent turn={turn} />}

      <div className={compact ? "space-y-1" : "border-l border-control pl-3"}>
        {compact && text && <p className="text-xs font-medium text-muted">Codex</p>}
        {text && <Answer text={text} streaming={live} />}
        {live && !text && (
          <p className="text-muted" aria-live="polite">
            {thinking ? "Working…" : "Sending…"}
          </p>
        )}
        {note && (
          <Note tone={note.tone} className={text ? "mt-2" : undefined}>
            {compact && turn.status === "failed" ? (turn.error ?? "Codex could not answer.") : [note.text, turn.error].filter(Boolean).join(" ")}
          </Note>
        )}
      </div>
      {!live && (compact ? (
        <details className="text-xs text-faint">
          <summary className="w-fit cursor-pointer rounded-sm">Details</summary>
          <div className="mt-1 space-y-0.5">
            <ContextSent turn={turn} />
            <UsageLine turn={turn} configuredModel={configuredModel} />
          </div>
        </details>
      ) : <UsageLine turn={turn} configuredModel={configuredModel} />)}
    </article>
  );
};

/** Totals across the turns shown, in the same units as each turn. */
export const UsageTotal = ({ turns }: { turns: Turn[] }) => {
  const sum = (pick: (turn: Turn) => number | null) => turns.reduce((total, turn) => total + (pick(turn) ?? 0), 0);
  const cost = sum((turn) => turn.usage.costUsd);
  return (
    <p className="text-xs text-faint">
      <Figure>{turns.length}</Figure> {turns.length === 1 ? "question" : "questions"} ·{" "}
      <Figure>{countText(sum(sentTokens))}</Figure> in,{" "}
      <Figure>{countText(sum((turn) => turn.usage.outputTokens))}</Figure> out tokens
      {turns.some((turn) => turn.usage.costUsd !== null) && <> · <Figure>{usdText(cost)}</Figure> at list price</>}
    </p>
  );
};
