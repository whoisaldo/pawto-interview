// What needs the interviewer now: what is running, what is next, what is
// waiting to be written up, and whether the parts a session leans on are up.

import { useState } from "react";
import { Link } from "react-router-dom";
import { Plus } from "lucide-react";
import { needsEvaluation, useConsole } from "../context";
import { errorMessage, interviewApi } from "../api";
import type { SessionSummary } from "../api";
import { copyText, inviteUrl, timeAgo } from "../format";
import { LastRunCell, SessionCell } from "../parts/rows";
import { buttonClass, cn } from "../classes";
import {
  AiPill,
  Button,
  Empty,
  Failure,
  Note,
  PageHeader,
  Panel,
  PanelHeader,
  SkeletonRows,
  StatusPill,
  tableClass,
  tdClass,
  thClass,
} from "../ui";

const CAP = 5;

const CopyInvite = ({ inviteCode }: { inviteCode: string }) => {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={async () => {
        setState((await copyText(inviteUrl(inviteCode))) ? "copied" : "failed");
        setTimeout(() => setState("idle"), 2000);
      }}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy invite"}
    </Button>
  );
};

const StartButton = ({ session, onStarted }: { session: SessionSummary; onStarted: () => Promise<void> }) => {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      {error && <Note tone="negative">{error}</Note>}
      <Button
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await interviewApi.act(session.id, "start");
            await onStarted();
          } catch (failure) {
            setError(errorMessage(failure));
          } finally {
            setBusy(false);
          }
        }}
      >
        Start
      </Button>
    </span>
  );
};

const Overview = () => {
  const { sessions } = useConsole();
  const list = sessions.data;
  const live = list?.filter((session) => session.status === "running" || session.status === "paused") ?? [];
  const scheduled = list?.filter((session) => session.status === "scheduled") ?? [];
  const waiting = list?.filter(needsEvaluation) ?? [];

  return (
    <>
      <PageHeader
        title="Overview"
        actions={
          <Link to="/console/interviews/new" className={buttonClass("primary")}>
            <Plus className="size-4" aria-hidden />
            New interview
          </Link>
        }
      />

      <div className="space-y-6">
        <Panel>
          <PanelHeader title="Live now" detail={list ? `${live.length} ${live.length === 1 ? "session" : "sessions"}` : undefined} />
          {sessions.error && !list ? (
            <Failure message={sessions.error} onRetry={sessions.reload} />
          ) : !list ? (
            <SkeletonRows rows={2} />
          ) : live.length === 0 ? (
            <Empty
              action={
                scheduled[0] ? (
                  <Link to={`/console/interviews/${scheduled[0].id}`} className={buttonClass("secondary", "sm")}>
                    Open {scheduled[0].title}
                  </Link>
                ) : undefined
              }
            >
              No live sessions.
            </Empty>
          ) : (
            <div className="relative overflow-x-auto">
              <table className={tableClass}>
                <thead>
                  <tr>
                    <th className={thClass}>Session</th>
                    <th className={thClass}>Status</th>
                    <th className={thClass}>AI</th>
                    <th className={thClass}>Candidate</th>
                    <th className={thClass}>Last run</th>
                    <th className={thClass}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {live.map((session) => (
                    <tr key={session.id}>
                      <td className={cn(tdClass, "w-full max-w-0")}>
                        <SessionCell session={session} />
                      </td>
                      <td className={tdClass}>
                        <StatusPill status={session.status} />
                      </td>
                      <td className={tdClass}>
                        <AiPill policy={session.aiPolicy} />
                      </td>
                      <td className={cn(tdClass, "whitespace-nowrap", session.candidateJoined ? "text-muted" : "text-warning")}>
                        {session.candidateJoined ? "In the room" : "Has not opened the link"}
                      </td>
                      <td className={cn(tdClass, "whitespace-nowrap")}>
                        <LastRunCell session={session} />
                      </td>
                      <td className={cn(tdClass, "text-right whitespace-nowrap")}>
                        <Link to={`/console/interviews/${session.id}/room`} className={buttonClass("secondary", "sm")}>
                          Open room
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <div className="grid items-start gap-6 xl:grid-cols-2">
          <Panel>
            <PanelHeader
              title="Scheduled"
              detail={list ? `${scheduled.length} waiting to start` : undefined}
              actions={
                <Link to="/console/interviews" className={buttonClass("ghost", "sm")}>
                  View all
                </Link>
              }
            />
            {!list ? (
              <SkeletonRows />
            ) : scheduled.length === 0 ? (
              <Empty
                action={
                  <Link to="/console/interviews/new" className={buttonClass("secondary", "sm")}>
                    New interview
                  </Link>
                }
              >
                Nothing is scheduled.
              </Empty>
            ) : (
              <div className="relative overflow-x-auto">
                <table className={tableClass}>
                  <thead>
                    <tr>
                      <th className={thClass}>Session</th>
                      <th className={thClass}>AI</th>
                      <th className={thClass}>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {scheduled.slice(0, CAP).map((session) => (
                      <tr key={session.id}>
                        <td className={cn(tdClass, "w-full max-w-0")}>
                          <SessionCell session={session} />
                        </td>
                        <td className={tdClass}>
                          <AiPill policy={session.aiPolicy} />
                        </td>
                        <td className={cn(tdClass, "text-right whitespace-nowrap")}>
                          <CopyInvite inviteCode={session.inviteCode} />
                          <StartButton session={session} onStarted={sessions.reload} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel>
            <PanelHeader
              title="To evaluate"
              detail={list ? `${waiting.length} ended without an evaluation` : undefined}
              actions={
                <Link to="/console/evaluations" className={buttonClass("ghost", "sm")}>
                  View all
                </Link>
              }
            />
            {!list ? (
              <SkeletonRows />
            ) : waiting.length === 0 ? (
              <Empty>Every ended session has a saved evaluation.</Empty>
            ) : (
              <div className="relative overflow-x-auto">
                <table className={tableClass}>
                  <thead>
                    <tr>
                      <th className={thClass}>Session</th>
                      <th className={thClass}>Ended</th>
                      <th className={thClass}>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {waiting.slice(0, CAP).map((session) => (
                      <tr key={session.id}>
                        <td className={cn(tdClass, "w-full max-w-0")}>
                          <SessionCell session={session} to={`/console/evaluations/${session.id}`} />
                        </td>
                        <td className={cn(tdClass, "whitespace-nowrap text-muted")}>
                          {session.endedAt ? timeAgo(session.endedAt) : "–"}
                        </td>
                        <td className={cn(tdClass, "text-right whitespace-nowrap")}>
                          <Link to={`/console/evaluations/${session.id}`} className={buttonClass("secondary", "sm")}>
                            Write evaluation
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
};

export default Overview;
