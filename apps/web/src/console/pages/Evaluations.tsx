// Evidence notes across sessions: which are still to write, and what was
// recorded on the ones that are saved.

import { useState } from "react";
import { Link } from "react-router-dom";
import { Download } from "lucide-react";
import { needsEvaluation, useConsole } from "../context";
import { errorMessage, interviewApi } from "../api";
import type { Rubric, SessionSummary } from "../api";
import { dayAndTime, downloadText, timeAgo } from "../format";
import { useResource, useStored } from "../hooks";
import { ScoreRow } from "../parts/evidence";
import { LastRunCell, SessionCell } from "../parts/rows";
import { buttonClass, cn } from "../classes";
import {
  AiPill,
  Button,
  Count,
  Empty,
  Failure,
  Note,
  PageHeader,
  Panel,
  SkeletonRows,
  Tab,
  TabList,
  TabRoot,
  tableClass,
  tdClass,
  thClass,
} from "../ui";

const ExportButtons = ({ session }: { session: SessionSummary }) => {
  const [error, setError] = useState<string | null>(null);
  const run = async (format: "json" | "markdown") => {
    setError(null);
    try {
      const text = await interviewApi.exportEvaluation(session.id, format);
      downloadText(
        `evaluation-${session.id}.${format === "json" ? "json" : "md"}`,
        text,
        format === "json" ? "application/json" : "text/markdown",
      );
    } catch (failure) {
      setError(errorMessage(failure, "The export could not be made."));
    }
  };
  return (
    <span className="inline-flex items-center gap-1">
      {error && <Note tone="negative">{error}</Note>}
      <Button size="sm" variant="ghost" onClick={() => run("json")} aria-label={`Export ${session.title} as JSON`}>
        <Download className="size-3.5" aria-hidden />
        JSON
      </Button>
      <Button size="sm" variant="ghost" onClick={() => run("markdown")} aria-label={`Export ${session.title} as Markdown`}>
        <Download className="size-3.5" aria-hidden />
        Markdown
      </Button>
    </span>
  );
};

const Saved = ({ sessions, rubric }: { sessions: SessionSummary[]; rubric: Rubric | undefined }) => {
  const label = (value: string) => rubric?.recommendations.find((item) => item.value === value)?.label ?? value;
  return (
    <div className="relative overflow-x-auto">
      <table className={tableClass}>
        <thead>
          <tr>
            <th className={thClass}>Session</th>
            <th className={thClass}>AI</th>
            <th className={thClass} title="Clarification, verification, understanding, tool ownership">
              Evidence, 0 to 2
            </th>
            <th className={thClass}>Recommendation</th>
            <th className={thClass}>Saved</th>
            <th className={thClass}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <tr key={session.id}>
              <td className={cn(tdClass, "max-w-64")}>
                <SessionCell session={session} to={`/console/evaluations/${session.id}`} />
              </td>
              <td className={tdClass}>
                <AiPill policy={session.aiPolicy} />
              </td>
              <td className={tdClass}>
                <ScoreRow scores={session.evaluation!.scores} rubric={rubric} />
              </td>
              <td className={cn(tdClass, session.evaluation!.recommendation === "undecided" ? "text-faint" : "text-ink")}>
                {label(session.evaluation!.recommendation)}
              </td>
              <td className={cn(tdClass, "whitespace-nowrap text-faint")}>
                {dayAndTime(session.evaluation!.updatedAt)}
              </td>
              <td className={cn(tdClass, "text-right whitespace-nowrap")}>
                <ExportButtons session={session} />
                <Link to={`/console/evaluations/${session.id}`} className={buttonClass("secondary", "sm")}>
                  Open
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const ToWrite = ({ sessions }: { sessions: SessionSummary[] }) => (
  <div className="relative overflow-x-auto">
    <table className={tableClass}>
      <thead>
        <tr>
          <th className={thClass}>Session</th>
          <th className={thClass}>AI</th>
          <th className={thClass}>Ended</th>
          <th className={thClass}>Last run</th>
          <th className={thClass}>
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {sessions.map((session) => (
          <tr key={session.id}>
            <td className={cn(tdClass, "max-w-72")}>
              <SessionCell session={session} to={`/console/evaluations/${session.id}`} />
            </td>
            <td className={tdClass}>
              <AiPill policy={session.aiPolicy} />
            </td>
            <td className={cn(tdClass, "whitespace-nowrap text-muted")}>
              {session.endedAt ? timeAgo(session.endedAt) : "Not ended"}
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
);

const Evaluations = () => {
  const { sessions } = useConsole();
  const rubric = useResource("rubric", interviewApi.rubric);
  const [tab, setTab] = useStored<string>("tandemcode.console.evaluations.tab", "write");

  const all = sessions.data ?? [];
  const toWrite = all.filter(needsEvaluation);
  const saved = all
    .filter((session) => session.evaluation)
    .sort((a, b) => Date.parse(b.evaluation!.updatedAt) - Date.parse(a.evaluation!.updatedAt));

  return (
    <>
      <PageHeader
        title="Evaluations"
        finding={
          sessions.data
            ? `${toWrite.length} ended ${toWrite.length === 1 ? "session is" : "sessions are"} waiting for an evaluation, ${saved.length} saved.`
            : undefined
        }
      />
      <Panel>
        <TabRoot value={tab} onValueChange={(value) => setTab(String(value))}>
          <TabList>
            <Tab value="write">
              To write
              <Count>{toWrite.length}</Count>
            </Tab>
            <Tab value="saved">
              Saved
              <Count>{saved.length}</Count>
            </Tab>
          </TabList>
        </TabRoot>
        {sessions.error && !sessions.data ? (
          <Failure message={sessions.error} onRetry={sessions.reload} />
        ) : !sessions.data ? (
          <SkeletonRows rows={4} />
        ) : tab === "saved" ? (
          saved.length === 0 ? (
            <Empty>No evaluation has been saved yet.</Empty>
          ) : (
            <Saved sessions={saved} rubric={rubric.data} />
          )
        ) : toWrite.length === 0 ? (
          <Empty
            action={
              saved.length > 0 ? (
                <Button size="sm" onClick={() => setTab("saved")}>
                  See saved evaluations
                </Button>
              ) : undefined
            }
          >
            Nothing is waiting. An ended session appears here until its evaluation is saved.
          </Empty>
        ) : (
          <ToWrite sessions={toWrite} />
        )}
      </Panel>
      <p className="mt-4 max-w-[46rem] text-body text-pretty text-muted">
        Scores are evidence the interviewer observed, each from 0 to 2. A dash means there was no chance to observe it,
        which is not a zero. Test results are listed beside an evaluation and never produce a score or a recommendation.
      </p>
    </>
  );
};

export default Evaluations;
