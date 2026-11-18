// Write up one session: the evidence form, with the facts of the session
// beside it. The facts are there to jog memory. They fill in nothing.

import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { useConsole } from "../context";
import { interviewApi } from "../api";
import { timeOfDay } from "../format";
import { useResource } from "../hooks";
import { EvidenceForm } from "../parts/evidence";
import { RunLine } from "../parts/runs";
import { buttonClass } from "../classes";
import {
  AiPill,
  Empty,
  Failure,
  Figure,
  Panel,
  PanelHeader,
  SampleTag,
  SkeletonRows,
  StatusPill,
} from "../ui";

const EvaluationPage = () => {
  const { id = "" } = useParams();
  const { sessions } = useConsole();
  const summary = useResource(`summary:${id}`, () => interviewApi.summary(id));
  const evaluation = useResource(`evaluation:${id}`, () => interviewApi.evaluation(id));
  const rubric = useResource("rubric", interviewApi.rubric);
  const runs = useResource(`runs:${id}`, () => interviewApi.runs(id));
  const turns = useResource(`turns:${id}`, () => interviewApi.turns(id));

  const back = (
    <Link to="/console/evaluations" className="mb-4 inline-flex items-center gap-1.5 rounded-sm text-body text-muted hover:text-ink">
      <ArrowLeft className="size-3.5" aria-hidden />
      Evaluations
    </Link>
  );

  const session = summary.data;
  if (!session) {
    return (
      <>
        {back}
        <Panel>{summary.error ? <Failure message={summary.error} onRetry={summary.reload} /> : <SkeletonRows rows={5} />}</Panel>
      </>
    );
  }

  const asked = turns.data?.filter((turn) => turn.askedAs === "candidate") ?? [];

  return (
    <>
      {back}
      <header className="mb-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-2xl font-semibold text-balance text-ink">{session.title}</h1>
          <StatusPill status={session.status} />
          <AiPill policy={session.aiPolicy} />
          {session.isSample && <SampleTag />}
        </div>
        <p className="mt-1.5 text-sm text-muted">
          {session.candidateName} · {session.problemTitle}
        </p>
      </header>

      <div className="grid items-start gap-6 xl:grid-cols-[1fr_minmax(0,24rem)]">
        <Panel>
          <PanelHeader title="Evidence" />
          <div className="p-5 text-body">
            {rubric.data && evaluation.data ? (
              <EvidenceForm
                sessionId={id}
                rubric={rubric.data}
                evaluation={evaluation.data}
                onSaved={(next) => {
                  evaluation.setData(next);
                  void sessions.reload();
                }}
              />
            ) : (rubric.error ?? evaluation.error) ? (
              <Failure message={(rubric.error ?? evaluation.error)!} onRetry={evaluation.reload} />
            ) : (
              <SkeletonRows rows={5} />
            )}
          </div>
        </Panel>

        <div className="space-y-6">
          <Panel>
            <PanelHeader
              title="Runs"
              detail={runs.data ? `${runs.data.length} recorded` : undefined}
              actions={
                <Link to={`/console/interviews/${id}?tab=runs`} className={buttonClass("ghost", "sm")}>
                  Every case
                </Link>
              }
            />
            {!runs.data ? (
              runs.error ? <Failure message={runs.error} onRetry={runs.reload} /> : <SkeletonRows rows={2} />
            ) : runs.data.length === 0 ? (
              <Empty>The candidate did not run their code.</Empty>
            ) : (
              <ul className="divide-y divide-rule text-body">
                {runs.data.slice(0, 6).map((run) => (
                  <li key={run.id} className="flex min-h-12 items-center px-5">
                    <RunLine run={run} role="interviewer" />
                  </li>
                ))}
              </ul>
            )}
            <p className="border-t border-rule px-5 py-2.5 text-xs text-pretty text-faint">
              A run that passes every case is a fact about the code. It does not score anything on this page.
            </p>
          </Panel>

          <Panel>
            <PanelHeader
              title="Assistant"
              detail={
                session.aiPolicy === "disabled"
                  ? "Off for this session"
                  : `${asked.length} asked by the candidate`
              }
              actions={
                <Link to={`/console/interviews/${id}?tab=assistant`} className={buttonClass("ghost", "sm")}>
                  Full transcript
                </Link>
              }
            />
            {session.aiPolicy === "disabled" ? (
              <Empty>AI assistance was off, so there is nothing to review here.</Empty>
            ) : !turns.data ? (
              turns.error ? <Failure message={turns.error} onRetry={turns.reload} /> : <SkeletonRows rows={2} />
            ) : asked.length === 0 ? (
              <Empty>The candidate did not ask the assistant anything.</Empty>
            ) : (
              <ul className="divide-y divide-rule text-body">
                {asked.slice(0, 6).map((turn) => (
                  <li key={turn.id} className="px-5 py-2.5">
                    <p className="line-clamp-2 text-pretty text-ink">{turn.question}</p>
                    <p className="mt-0.5 text-xs text-faint">
                      <Figure>{timeOfDay(turn.createdAt)}</Figure> ·{" "}
                      {turn.context.length === 0
                        ? "nothing attached"
                        : `attached ${turn.context.map((item) => item.kind.replace("-", " ")).join(", ")}`}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
};

export default EvaluationPage;
