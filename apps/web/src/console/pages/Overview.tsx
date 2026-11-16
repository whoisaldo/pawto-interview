// What needs the interviewer now: what is running, what is next, what is
// waiting to be written up, and whether the parts a session leans on are up.

import { useState } from "react";
import { Link } from "react-router-dom";
import { Plus } from "lucide-react";
import { needsEvaluation, useConsole } from "../context";
import { errorMessage, interviewApi } from "../api";
import type { SessionSummary, SystemStatus } from "../api";
import { copyText, durationText, inviteUrl, timeAgo } from "../format";
import { ClockCell, LastRunCell, SessionCell } from "../parts/rows";
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

const sentence = (sessions: SessionSummary[]): string => {
  const live = sessions.filter((session) => session.status === "running" || session.status === "paused");
  const scheduled = sessions.filter((session) => session.status === "scheduled").length;
  const waiting = sessions.filter(needsEvaluation).length;
  const parts = [
    live.length === 0
      ? "Nothing is running"
      : live.length === 1
        ? `${live[0].title} is ${live[0].status}`
        : `${live.length} sessions are live`,
    `${scheduled} scheduled`,
    waiting === 0 ? "no evaluations waiting" : `${waiting} ended ${waiting === 1 ? "session has" : "sessions have"} no evaluation`,
  ];
  return `${parts.join(", ")}.`;
};

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

const Cell = ({ label, state, detail, tone }: { label: string; state: string; detail: string; tone: string }) => (
  <div className="px-5 py-4">
    <p className="text-xs text-faint">{label}</p>
    <p className={cn("mt-1 text-base font-medium", tone)}>{state}</p>
    <p className="mt-0.5 text-body text-pretty text-muted">{detail}</p>
  </div>
);

const Readiness = ({ system }: { system: SystemStatus }) => {
  const { judge, assistant } = system;
  const stuck = judge.waiting > 0 && (judge.oldestWaitingSeconds ?? 0) > 20;
  return (
    <div className="grid divide-y divide-rule md:grid-cols-3 md:divide-x md:divide-y-0">
      <Cell
        label="Sign-in"
        state={system.authMode === "demo" ? "Local demo" : "Clerk"}
        tone={system.authMode === "demo" ? "text-warning" : "text-ink"}
        detail={
          system.authMode === "demo"
            ? "A stand-in for real sign-in. Answers this machine and its tailnet only."
            : "Interviewers are the accounts listed on the server."
        }
      />
      <Cell
        label="Judge"
        state={stuck ? "Not answering" : judge.waiting > 0 ? "Judging" : "Ready"}
        tone={stuck ? "text-negative" : "text-positive"}
        detail={
          stuck
            ? `${judge.waiting} ${judge.waiting === 1 ? "run has" : "runs have"} waited ${judge.oldestWaitingSeconds} s. Check that the runner is up.`
            : judge.lastJudgedAt
              ? `Last verdict ${timeAgo(judge.lastJudgedAt)}. Each run gets its own container with no network.`
              : "No run judged yet. Each run gets its own container with no network."
        }
      />
      <Cell
        label="Assistant"
        state={assistant.ready ? "Ready" : assistant.problem ? "Misconfigured" : "Not set up"}
        tone={assistant.ready ? "text-positive" : assistant.problem ? "text-negative" : "text-muted"}
        detail={
          assistant.ready
            ? `${assistant.model}${assistant.effort ? `, ${assistant.effort} effort` : ""}, through ${assistant.launcher}.`
            : (assistant.problem ?? "No Claude CLI is configured, so sessions with AI allowed will say it is unavailable.")
        }
      />
    </div>
  );
};

const Overview = () => {
  const { sessions, system } = useConsole();
  const list = sessions.data;
  const live = list?.filter((session) => session.status === "running" || session.status === "paused") ?? [];
  const scheduled = list?.filter((session) => session.status === "scheduled") ?? [];
  const waiting = list?.filter(needsEvaluation) ?? [];

  return (
    <>
      <PageHeader
        title="Overview"
        finding={list ? sentence(list) : undefined}
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
              No session is running. Start a scheduled one when the candidate is ready.
            </Empty>
          ) : (
            <div className="relative overflow-x-auto">
              <table className={tableClass}>
                <thead>
                  <tr>
                    <th className={thClass}>Session</th>
                    <th className={thClass}>Status</th>
                    <th className={cn(thClass, "text-right")}>Clock</th>
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
                      <td className={cn(tdClass, "text-right")}>
                        <ClockCell session={session} />
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
                      <th className={cn(thClass, "text-right")}>Length</th>
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
                        <td className={cn(tdClass, "text-right whitespace-nowrap text-muted")}>
                          {durationText(session.durationSeconds)}
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
                      <th className={thClass}>Last run</th>
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
                        <td className={tdClass}>
                          <LastRunCell session={session} />
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

        <Panel>
          <PanelHeader
            title="Readiness"
            detail="What a live session depends on"
            actions={
              <Link to="/console/settings" className={buttonClass("ghost", "sm")}>
                Settings
              </Link>
            }
          />
          {system.data ? (
            <Readiness system={system.data} />
          ) : system.error ? (
            <Failure message={system.error} onRetry={system.reload} />
          ) : (
            <SkeletonRows rows={1} />
          )}
        </Panel>
      </div>
    </>
  );
};

export default Overview;
