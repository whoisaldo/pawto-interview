// Session controls and invites.

import { useState } from "react";
import { Pause, Play, RotateCcw, Square } from "lucide-react";
import { errorMessage, interviewApi } from "../api";
import type { SessionSummary } from "../api";
import { inviteUrl } from "../format";
import {
  Button,
  ConfirmButton,
  CopyField,
  Note,
} from "../ui";

export const InviteLink = ({ inviteCode }: { inviteCode: string }) => (
  <CopyField label="Candidate invite link" value={inviteUrl(inviteCode)} />
);

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
            description="Return this session to Scheduled and hide held-back cases. Previous runs, questions, and notes are kept."
            confirmLabel="Reset session"
            onConfirm={() => act("reset")}
          />
        )}
      </div>
      {error && <Note tone="negative">{error}</Note>}
    </div>
  );
};
