// A session's clock and the controls that move it.

import { useState } from "react";
import { Pause, Play, RotateCcw, Square } from "lucide-react";
import { errorMessage, interviewApi } from "../api";
import type { Clock, SessionSummary } from "../api";
import { clockText, durationText, inviteUrl } from "../format";
import { useLiveClock } from "../hooks";
import { cn } from "../classes";
import {
  Button,
  ConfirmButton,
  CopyField,
  Figure,
  Note,
} from "../ui";

export const InviteLink = ({ inviteCode }: { inviteCode: string }) => (
  <CopyField label="Candidate invite link" value={inviteUrl(inviteCode)} />
);

/** Time left, large, with what it is counted against. */
export const ClockReadout = ({ clock, size = "lg" }: { clock: Clock; size?: "md" | "lg" }) => {
  const live = useLiveClock(clock);
  const over = live.over > 0;
  return (
    <div className="flex items-baseline gap-2.5">
      <Figure
        className={cn(
          "leading-none font-medium",
          size === "lg" ? "text-3xl" : "text-xl",
          over ? "text-negative" : clock.status === "running" ? "text-ink" : "text-muted",
        )}
      >
        <span className="sr-only">{over ? "Over time by " : "Time left "}</span>
        {over ? `+${clockText(live.over)}` : clockText(live.remaining)}
      </Figure>
      <span className="text-xs text-faint">
        {over
          ? `over the ${durationText(clock.durationSeconds)} planned`
          : clock.status === "scheduled"
            ? `planned, not started`
            : `left of ${durationText(clock.durationSeconds)}`}
      </span>
    </div>
  );
};

/** Start, pause, end and reset. Ending and resetting ask first. */
export const SessionControls = ({
  session,
  onChanged,
  size = "md",
}: {
  session: Pick<SessionSummary, "id" | "status" | "title">;
  onChanged: () => void | Promise<void>;
  size?: "sm" | "md";
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: "start" | "pause" | "end" | "reset") => {
    setBusy(true);
    setError(null);
    try {
      await interviewApi.act(session.id, action);
      await onChanged();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const { status } = session;
  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {status === "scheduled" && (
          <Button variant="primary" size={size} disabled={busy} onClick={() => act("start")}>
            <Play className="size-3.5" aria-hidden />
            Start session
          </Button>
        )}
        {status === "paused" && (
          <Button variant="primary" size={size} disabled={busy} onClick={() => act("start")}>
            <Play className="size-3.5" aria-hidden />
            Resume
          </Button>
        )}
        {status === "running" && (
          <Button size={size} disabled={busy} onClick={() => act("pause")}>
            <Pause className="size-3.5" aria-hidden />
            Pause
          </Button>
        )}
        {(status === "running" || status === "paused") && (
          <ConfirmButton
            size={size}
            variant="secondary"
            disabled={busy}
            label={
              <>
                <Square className="size-3.5" aria-hidden />
                End session
              </>
            }
            title={`End "${session.title}"?`}
            description="The candidate can no longer edit, run tests or ask the assistant. Runs, questions and your notes are kept, and you can still write the evaluation."
            confirmLabel="End session"
            onConfirm={() => act("end")}
          />
        )}
        {status !== "scheduled" && (
          <ConfirmButton
            size={size}
            variant="ghost"
            disabled={busy}
            label={
              <>
                <RotateCcw className="size-3.5" aria-hidden />
                Reset
              </>
            }
            title={`Reset "${session.title}"?`}
            description="The clock goes back to zero, the session returns to scheduled and held-back cases are hidden again. Runs, assistant questions and notes already recorded are kept."
            confirmLabel="Reset session"
            onConfirm={() => act("reset")}
          />
        )}
      </div>
      {error && <Note tone="negative">{error}</Note>}
    </div>
  );
};
