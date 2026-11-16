// The interviews an interviewer is about to run or is running. Past ones
// live under Sessions.

import { Link } from "react-router-dom";
import { Plus } from "lucide-react";
import { useConsole } from "../context";
import type { SessionSummary } from "../api";
import { useStored } from "../hooks";
import { ClockCell, SessionCell } from "../parts/rows";
import { buttonClass, cn } from "../classes";
import {
  AiPill,
  Empty,
  Failure,
  PageHeader,
  Panel,
  SkeletonRows,
  StatusPill,
  Tab,
  TabList,
  TabRoot,
  tableClass,
  tdClass,
  thClass,
} from "../ui";

const ORDER: Record<string, number> = { running: 0, paused: 1, scheduled: 2, ended: 3 };

const Rows = ({ sessions }: { sessions: SessionSummary[] }) => (
  <div className="relative overflow-x-auto">
    <table className={tableClass}>
      <thead>
        <tr>
          <th className={thClass}>Session</th>
          <th className={thClass}>Problem</th>
          <th className={thClass}>Status</th>
          <th className={cn(thClass, "text-right")}>Clock</th>
          <th className={thClass}>AI</th>
          <th className={thClass}>Candidate</th>
          <th className={thClass}>
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {sessions.map((session) => (
          <tr key={session.id}>
            <td className={cn(tdClass, "max-w-72")}>
              <SessionCell session={session} />
            </td>
            <td className={cn(tdClass, "max-w-60 truncate text-muted")}>{session.problemTitle}</td>
            <td className={tdClass}>
              <StatusPill status={session.status} />
            </td>
            <td className={cn(tdClass, "text-right whitespace-nowrap")}>
              <ClockCell session={session} />
            </td>
            <td className={tdClass}>
              <AiPill policy={session.aiPolicy} />
            </td>
            <td className={cn(tdClass, "whitespace-nowrap text-muted")}>
              {session.candidateJoined ? "Opened the link" : "Not yet"}
            </td>
            <td className={cn(tdClass, "text-right whitespace-nowrap")}>
              <Link to={`/console/interviews/${session.id}`} className={buttonClass("secondary", "sm")}>
                Open
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const Interviews = () => {
  const { sessions } = useConsole();
  const [tab, setTab] = useStored<string>("tandemcode.console.interviews.tab", "active");
  const all = [...(sessions.data ?? [])].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
  const active = all.filter((session) => session.status !== "ended");
  const shown = tab === "all" ? all : active;
  const live = active.filter((session) => session.status !== "scheduled").length;

  return (
    <>
      <PageHeader
        title="Interviews"
        finding={
          sessions.data
            ? `${active.length - live} scheduled and ${live} live. ${all.length - active.length} ended.`
            : undefined
        }
        actions={
          <Link to="/console/interviews/new" className={buttonClass("primary")}>
            <Plus className="size-4" aria-hidden />
            New interview
          </Link>
        }
      />
      <Panel>
        <TabRoot value={tab} onValueChange={(value) => setTab(String(value))}>
          <TabList>
            <Tab value="active">Upcoming and live</Tab>
            <Tab value="all">All</Tab>
          </TabList>
        </TabRoot>
        {sessions.error && !sessions.data ? (
          <Failure message={sessions.error} onRetry={sessions.reload} />
        ) : !sessions.data ? (
          <SkeletonRows rows={4} />
        ) : shown.length === 0 ? (
          <Empty
            action={
              <Link to="/console/interviews/new" className={buttonClass("secondary", "sm")}>
                New interview
              </Link>
            }
          >
            {tab === "all" ? "No interviews yet." : "Nothing is scheduled or running."}
          </Empty>
        ) : (
          <Rows sessions={shown} />
        )}
      </Panel>
    </>
  );
};

export default Interviews;
