// One session, from the interviewer's side: its clock and controls, the
// candidate's runs with every case, what was asked of the assistant, the
// evidence notes, and the session's setup.

import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, DoorOpen } from "lucide-react";
import { useConsole } from "../context";
import { errorMessage, interviewApi } from "../api";
import type { AiPolicy, BriefEdit, LibraryProblem, RunView, SessionSummary, SessionView, Turn } from "../api";
import { useResource } from "../hooks";
import { CaseList, Criteria, GuideView, SectionTitle, Statement } from "../parts/brief";
import { EvidenceForm } from "../parts/evidence";
import { RevealControl, RunDetail, RunLine } from "../parts/runs";
import { InviteLink, SessionControls } from "../parts/session";
import { TurnBlock, UsageTotal } from "../parts/transcript";
import { buttonClass, cn } from "../classes";
import {
  AiPill,
  Button,
  Choice,
  Count,
  Empty,
  Failure,
  Field,
  Note,
  Panel,
  Pre,
  SampleTag,
  SkeletonRows,
  StatusPill,
  Tab,
  TabList,
  TabPanel,
  TabRoot,
  inputClass,
  textareaClass,
} from "../ui";
import { AI_OPTIONS } from "../options";

const RunsTab = ({
  sessionId,
  view,
  runs,
  error,
  onChanged,
}: {
  sessionId: string;
  view: SessionView;
  runs: RunView[] | undefined;
  error: string | null;
  onChanged: () => Promise<void>;
}) => {
  const [chosen, setChosen] = useState<string | null>(null);
  const selected = runs?.find((run) => run.id === chosen) ?? runs?.[0];
  const detail = useResource(`run:${selected?.id ?? "none"}`, async () =>
    selected ? interviewApi.run(sessionId, selected.id) : null,
  );

  return (
    <div>
      <div className="border-b border-rule px-5 py-3.5">
        <RevealControl
          sessionId={sessionId}
          revealed={view.heldBackRevealed}
          canReveal={view.interviewer?.canRevealHeldBack ?? false}
          onChanged={onChanged}
        />
      </div>
      {error && !runs ? (
        <Failure message={error} />
      ) : !runs ? (
        <SkeletonRows />
      ) : runs.length === 0 ? (
        <Empty>
          No runs yet. Each time the candidate runs their code, every case is judged and listed here.
        </Empty>
      ) : (
        <div className="grid lg:grid-cols-[minmax(0,21rem)_1fr]">
          <ul aria-label="Runs, newest first" className="max-h-[34rem] overflow-y-auto border-b border-rule lg:border-r lg:border-b-0">
            {runs.map((run) => (
              <li key={run.id} className="border-b border-rule last:border-b-0">
                <button
                  type="button"
                  aria-current={run.id === selected?.id}
                  onClick={() => setChosen(run.id)}
                  className={cn(
                    "flex min-h-12 w-full items-center px-5 text-left hover:bg-raised/60",
                    run.id === selected?.id && "bg-raised",
                  )}
                >
                  <RunLine run={run} role="interviewer" />
                </button>
              </li>
            ))}
          </ul>
          <div className="min-w-0">
            {selected && <RunDetail run={selected} role="interviewer" />}
            {detail.data?.code && (
              <details className="group border-t border-rule px-4 py-3">
                <summary className="cursor-pointer rounded-sm text-muted hover:text-ink">The code this run judged</summary>
                <Pre className="mt-2 max-h-96 overflow-y-auto whitespace-pre">{detail.data.code}</Pre>
              </details>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const AssistantTab = ({ view, turns, error }: { view: SessionView; turns: Turn[] | undefined; error: string | null }) => {
  const { assistant } = view;
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-rule px-5 py-3">
        <p className={cn("text-pretty", assistant.state === "ready" ? "text-muted" : "text-ink")}>
          {view.aiPolicy === "disabled"
            ? "AI assistance is off for this session. The candidate is not offered the assistant and cannot reach it."
            : assistant.state === "ready" || assistant.state === "not_running" || assistant.state === "ended"
              ? `The candidate can ask Codex (${assistant.model}${assistant.effort ? `, ${assistant.effort} effort` : ""}) while the session runs. Only what they tick is attached.`
              : assistant.detail}
        </p>
        {turns && turns.length > 0 && <UsageTotal turns={turns} />}
      </div>
      {error && !turns ? (
        <Failure message={error} />
      ) : !turns ? (
        <SkeletonRows />
      ) : turns.length === 0 ? (
        <Empty>
          {view.aiPolicy === "disabled"
            ? "No questions, because AI is off."
            : "No questions have been asked in this session."}
        </Empty>
      ) : (
        <div className="divide-y divide-rule">
          {turns.map((turn) => (
            <TurnBlock key={turn.id} turn={turn} viewer="interviewer" configuredModel={assistant.model} />
          ))}
        </div>
      )}
    </div>
  );
};

const SetupTab = ({
  summary,
  view,
  library,
  onSaved,
}: {
  summary: SessionSummary;
  view: SessionView;
  library: LibraryProblem[];
  onSaved: () => Promise<void>;
}) => {
  const lib = view.interviewer!.library;
  const [title, setTitle] = useState(summary.title);
  const [candidateName, setCandidateName] = useState(summary.candidateName);
  const [candidateEmail, setCandidateEmail] = useState(summary.candidateEmail ?? "");
  const [aiPolicy, setAiPolicy] = useState<AiPolicy>(summary.aiPolicy);
  const [problemId, setProblemId] = useState(summary.problemId);
  const [statement, setStatement] = useState(view.problem.statement ?? "");
  const [criteria, setCriteria] = useState(view.problem.acceptanceCriteria.join("\n"));
  const [starter, setStarter] = useState(view.problem.starterCode ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const ended = summary.status === "ended";
  const problemLocked = summary.status !== "scheduled" || summary.runs.count > 0;
  const problemChanged = problemId !== summary.problemId;

  const useLibrary = () => {
    setStatement(lib.statement ?? "");
    setCriteria(lib.acceptanceCriteria.join("\n"));
    setStarter(lib.starterCode ?? "");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const lines = criteria.split("\n").map((line) => line.trim()).filter(Boolean);
    // Text equal to the library's is stored as "use the library's", so a
    // later fix to the library still reaches this session.
    const brief: BriefEdit = {
      statement: statement.trim() === (lib.statement ?? "").trim() ? null : statement,
      acceptanceCriteria: lines.join("\n") === lib.acceptanceCriteria.join("\n") ? null : lines,
      starterCode: starter === (lib.starterCode ?? "") ? null : starter,
    };
    try {
      await interviewApi.update(summary.id, {
        title,
        candidateName,
        candidateEmail: candidateEmail.trim() || null,
        ...(ended
          ? {}
          : {
              aiPolicy,
              ...(problemChanged ? { problemId } : { brief }),
            }),
      });
      await onSaved();
      setSavedAt(Date.now());
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="grid gap-x-8 gap-y-5 p-5 xl:grid-cols-[minmax(0,24rem)_1fr]">
        <div className="space-y-4">
          <Field label="Title" htmlFor="setup-title">
            <input id="setup-title" required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} className={inputClass} />
          </Field>
          <Field label="Candidate name" htmlFor="setup-candidate">
            <input id="setup-candidate" required maxLength={80} value={candidateName} onChange={(event) => setCandidateName(event.target.value)} className={inputClass} />
          </Field>
          <Field label="Candidate email" htmlFor="setup-email">
            <input id="setup-email" type="email" maxLength={254} value={candidateEmail} onChange={(event) => setCandidateEmail(event.target.value)} className={inputClass} />
          </Field>
          <div className="space-y-1.5">
            <p className="text-body font-medium text-ink">AI assistance</p>
            <Choice name="setup-ai" legend="AI assistance" value={aiPolicy} options={AI_OPTIONS} onChange={setAiPolicy} disabled={ended} className="-ml-2.5" />
            <Note>
              {aiPolicy !== summary.aiPolicy
                ? "Takes effect for the candidate as soon as you save."
                : AI_OPTIONS.find((option) => option.value === aiPolicy)!.hint}
            </Note>
          </div>
          <Field
            label="Problem"
            htmlFor="setup-problem"
            hint={
              problemLocked
                ? "The problem is fixed once the session has started or has a run. Create a new interview to use another."
                : problemChanged
                  ? "Saving switches the problem and drops this session's wording edits."
                  : undefined
            }
          >
            <select id="setup-problem" disabled={problemLocked} value={problemId} onChange={(event) => setProblemId(event.target.value)} className={inputClass}>
              {library.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <fieldset disabled={ended || problemChanged} className="min-w-0 space-y-4 disabled:opacity-60">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <legend className="text-body font-medium text-ink">Wording for this session</legend>
            <Button size="sm" variant="ghost" onClick={useLibrary}>
              Use the library wording
            </Button>
          </div>
          <Field label="Brief" htmlFor="setup-statement" hint="Edits apply to this session only.">
            <textarea id="setup-statement" rows={9} maxLength={8000} value={statement} onChange={(event) => setStatement(event.target.value)} className={textareaClass} />
          </Field>
          <Field label="Acceptance criteria" htmlFor="setup-criteria" hint="One per line. Shown to the candidate.">
            <textarea id="setup-criteria" rows={6} value={criteria} onChange={(event) => setCriteria(event.target.value)} className={textareaClass} />
          </Field>
          <Field label="Starter code" htmlFor="setup-starter" hint="What the editor starts with. The judge's cases do not change.">
            <textarea id="setup-starter" rows={8} spellCheck={false} value={starter} onChange={(event) => setStarter(event.target.value)} className={`${textareaClass} font-figure text-xs whitespace-pre`} />
          </Field>
        </fieldset>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-rule px-5 py-3">
        {error ? (
          <Note tone="negative">{error}</Note>
        ) : ended ? (
          <Note>The session has ended. Only its title and candidate details can change.</Note>
        ) : savedAt ? (
          <Note tone="positive">Saved</Note>
        ) : null}
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Saving" : "Save changes"}
        </Button>
      </div>
    </form>
  );
};

const GuideTab = ({ view }: { view: SessionView }) => (
  <div className="grid gap-x-10 gap-y-6 p-5 text-body xl:grid-cols-2">
    <GuideView
      guide={view.interviewer?.guide ?? null}
      provenance={view.interviewer?.provenance ?? null}
      referenceCode={view.interviewer?.referenceCode ?? null}
    />
    <div className="space-y-6">
      <section>
        <SectionTitle aside={view.problem.edited.statement ? "Edited for this session" : undefined}>
          Brief the candidate sees
        </SectionTitle>
        <Statement text={view.problem.statement} className="text-muted" />
      </section>
      <section>
        <SectionTitle aside={view.problem.edited.acceptanceCriteria ? "Edited for this session" : undefined}>
          Acceptance criteria
        </SectionTitle>
        <div className="text-muted">
          <Criteria items={view.problem.acceptanceCriteria} />
        </div>
      </section>
      <section>
        <SectionTitle aside="Shown to the candidate">Public examples</SectionTitle>
        <CaseList cases={view.problem.examples} />
      </section>
      {view.heldBack && view.heldBack.length > 0 && (
        <section>
          <SectionTitle aside={view.heldBackRevealed ? "Revealed to the candidate" : "Interviewer only"}>
            Held-back cases
          </SectionTitle>
          <CaseList cases={view.heldBack} />
        </section>
      )}
    </div>
  </div>
);

const InterviewDetail = () => {
  const { id = "" } = useParams();
  const { sessions } = useConsole();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "runs";

  const summary = useResource(`summary:${id}`, () => interviewApi.summary(id), 3000);
  const view = useResource(`view:${id}`, () => interviewApi.view(id), 4000);
  const runs = useResource(`runs:${id}`, () => interviewApi.runs(id), 3000);
  const turns = useResource(`turns:${id}`, () => interviewApi.turns(id), 3000);
  const evaluation = useResource(`evaluation:${id}`, () => interviewApi.evaluation(id));
  const rubric = useResource("rubric", interviewApi.rubric);
  const library = useResource("library", interviewApi.library);

  const refresh = async () => {
    await Promise.all([summary.reload(), view.reload(), runs.reload(), sessions.reload()]);
  };

  const back = (
    <Link to="/console/interviews" className="mb-4 inline-flex items-center gap-1.5 rounded-sm text-body text-muted hover:text-ink">
      <ArrowLeft className="size-3.5" aria-hidden />
      Interviews
    </Link>
  );

  if (!summary.data || !view.data) {
    const failed = summary.error ?? view.error;
    return (
      <>
        {back}
        <Panel>
          {failed ? (
            <Failure
              message={failed}
              onRetry={() => {
                void summary.reload();
                void view.reload();
              }}
            />
          ) : (
            <SkeletonRows rows={5} />
          )}
        </Panel>
      </>
    );
  }

  const session = summary.data;
  const details = view.data;

  return (
    <>
      {back}
      <Panel className="mb-6">
        <div className="grid gap-x-8 gap-y-5 p-5 xl:grid-cols-[1fr_minmax(0,24rem)]">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h1 className="text-2xl font-semibold text-balance text-ink">{session.title}</h1>
              <StatusPill status={session.status} />
              <AiPill policy={session.aiPolicy} />
              {session.isSample && <SampleTag />}
            </div>
            <p className="mt-1.5 text-sm text-muted">
              {session.candidateName}
              {session.candidateEmail ? `, ${session.candidateEmail}` : ""} · {session.problemTitle} ·{" "}
              <span className={session.candidateJoined ? undefined : "text-warning"}>
                {session.candidateJoined ? "candidate has opened the link" : "candidate has not opened the link"}
              </span>
            </p>
            <div className="mt-5 flex flex-wrap items-end gap-x-8 gap-y-4">
              <SessionControls session={session} onChanged={refresh} />
            </div>
          </div>
          <div className="min-w-0 space-y-3">
            <div>
              <p className="mb-1.5 text-xs text-faint">Candidate invite link</p>
              <InviteLink inviteCode={session.inviteCode} />
            </div>
            <Link to={`/console/interviews/${session.id}/room`} className={buttonClass("secondary")}>
              <DoorOpen className="size-4" aria-hidden />
              Open room
            </Link>
          </div>
        </div>
      </Panel>

      <Panel>
        <TabRoot value={tab} onValueChange={(value) => setParams({ tab: String(value) }, { replace: true })}>
          <TabList>
            <Tab value="runs">
              Runs
              {runs.data && runs.data.length > 0 && <Count>{runs.data.length}</Count>}
            </Tab>
            <Tab value="assistant">
              Assistant
              {turns.data && turns.data.length > 0 && <Count>{turns.data.length}</Count>}
            </Tab>
            <Tab value="evidence">Evidence</Tab>
            <Tab value="setup">Setup</Tab>
            <Tab value="guide">Guide</Tab>
          </TabList>
          <TabPanel value="runs" className="text-body">
            <RunsTab sessionId={id} view={details} runs={runs.data} error={runs.error} onChanged={refresh} />
          </TabPanel>
          <TabPanel value="assistant" className="text-body">
            <AssistantTab view={details} turns={turns.data} error={turns.error} />
          </TabPanel>
          <TabPanel value="evidence" className="p-5 text-body">
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
              <SkeletonRows rows={4} />
            )}
          </TabPanel>
          <TabPanel value="setup" className="text-body">
            {library.data ? (
              <SetupTab
                key={`${session.problemId}:${session.status === "ended"}`}
                summary={session}
                view={details}
                library={library.data}
                onSaved={refresh}
              />
            ) : library.error ? (
              <Failure message={library.error} onRetry={library.reload} />
            ) : (
              <SkeletonRows rows={5} />
            )}
          </TabPanel>
          <TabPanel value="guide">
            <GuideTab view={details} />
          </TabPanel>
        </TabRoot>
      </Panel>
    </>
  );
};

export default InterviewDetail;
