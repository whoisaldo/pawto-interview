// The record of every session: how long it ran, what the last run did, how
// much the assistant was used, and whether it has been written up.

import { useState } from "react";
import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import { useConsole } from "../context";
import { interviewApi } from "../api";
import type { SessionSummary } from "../api";
import { dayAndTime, usdText } from "../format";
import { useResource, useStored } from "../hooks";
import { ScoreRow } from "../parts/evidence";
import { ClockCell, LastRunCell, SessionCell } from "../parts/rows";
import { cn } from "../classes";
import {
  AiPill,
  Count,
  Empty,
  Failure,
  Figure,
  PageHeader,
  Panel,
  SkeletonRows,
  StatusPill,
  Tab,
  TabList,
  TabRoot,
  inputClass,
  tableClass,
  tdClass,
  thClass,
} from "../ui";

const FILTERS: { value: string; label: string; match: (session: SessionSummary) => boolean }[] = [
  { value: "all", label: "All", match: () => true },
  { value: "live", label: "Live", match: (session) => session.status === "running" || session.status === "paused" },
  { value: "scheduled", label: "Scheduled", match: (session) => session.status === "scheduled" },
  { value: "ended", label: "Ended", match: (session) => session.status === "ended" },
];

const Sessions = () => {
  const { sessions } = useConsole();
  const rubric = useResource("rubric", interviewApi.rubric);
  const [filter, setFilter] = useStored<string>("tandemcode.console.sessions.filter", "all");
  const [query, setQuery] = useState("");

  const all = sessions.data ?? [];
  const needle = query.trim().toLowerCase();
  const active = FILTERS.find((item) => item.value === filter) ?? FILTERS[0];
  const shown = all.filter(
    (session) =>
      active.match(session) &&
      (needle === "" ||
        session.title.toLowerCase().includes(needle) ||
        session.candidateName.toLowerCase().includes(needle) ||
        session.problemTitle.toLowerCase().includes(needle)),
  );
  const withAi = all.filter((session) => session.aiPolicy === "allowed").length;

  return (
    <>
      <PageHeader
        title="Sessions"
        finding={
          sessions.data
            ? `${all.length} ${all.length === 1 ? "session" : "sessions"} on record, ${withAi} with AI allowed.`
            : undefined
        }
      />
      <Panel>
        <TabRoot value={active.value} onValueChange={(value) => setFilter(String(value))}>
          <TabList>
            {FILTERS.map((item) => (
              <Tab key={item.value} value={item.value}>
                {item.label}
                <Count>{all.filter(item.match).length}</Count>
              </Tab>
            ))}
          </TabList>
        </TabRoot>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-5 py-3">
          <div className="relative w-full max-w-72">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
            <input
              type="search"
              aria-label="Search sessions"
              placeholder="Search by title, candidate or problem"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className={cn(inputClass, "pl-9")}
            />
          </div>
          <p className="text-xs text-faint">
            {shown.length} of {all.length} shown, newest first
          </p>
        </div>
        {sessions.error && !sessions.data ? (
          <Failure message={sessions.error} onRetry={sessions.reload} />
        ) : !sessions.data ? (
          <SkeletonRows rows={5} />
        ) : shown.length === 0 ? (
          <Empty>{all.length === 0 ? "No sessions yet." : "No session matches."}</Empty>
        ) : (
          <div className="relative overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>Session</th>
                  <th className={thClass}>Status</th>
                  <th className={thClass}>AI</th>
                  <th className={cn(thClass, "text-right")}>Time</th>
                  <th className={cn(thClass, "text-right")}>Runs</th>
                  <th className={thClass}>Last run</th>
                  <th className={cn(thClass, "text-right")}>Assistant</th>
                  <th className={thClass}>Evidence</th>
                  <th className={thClass}>Created</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((session) => (
                  <tr key={session.id}>
                    <td className={cn(tdClass, "max-w-64")}>
                      <SessionCell session={session} />
                    </td>
                    <td className={tdClass}>
                      <StatusPill status={session.status} />
                    </td>
                    <td className={tdClass}>
                      <AiPill policy={session.aiPolicy} />
                    </td>
                    <td className={cn(tdClass, "text-right whitespace-nowrap")}>
                      <ClockCell session={session} />
                    </td>
                    <td className={cn(tdClass, "text-right font-figure text-muted")}>{session.runs.count}</td>
                    <td className={cn(tdClass, "whitespace-nowrap")}>
                      <LastRunCell session={session} />
                    </td>
                    <td className={cn(tdClass, "text-right whitespace-nowrap")}>
                      {session.aiPolicy === "disabled" ? (
                        <span className="text-faint">Off</span>
                      ) : session.assistant.turns === 0 ? (
                        <span className="text-faint">Not used</span>
                      ) : (
                        <span className="text-muted">
                          <Figure>{session.assistant.turns}</Figure> asked ·{" "}
                          <Figure>{usdText(session.assistant.costUsd)}</Figure>
                        </span>
                      )}
                    </td>
                    <td className={cn(tdClass, "whitespace-nowrap")}>
                      {session.evaluation ? (
                        <Link to={`/console/evaluations/${session.id}`} className="rounded-sm hover:underline">
                          <ScoreRow scores={session.evaluation.scores} rubric={rubric.data} />
                        </Link>
                      ) : (
                        <span className="text-faint">Not written</span>
                      )}
                    </td>
                    <td className={cn(tdClass, "whitespace-nowrap text-faint")}>{dayAndTime(session.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
};

export default Sessions;
