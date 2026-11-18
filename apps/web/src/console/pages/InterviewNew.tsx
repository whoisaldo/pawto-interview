// Set up a session: who, which problem, how long, and whether AI is allowed.

import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useConsole } from "../context";
import { errorMessage, interviewApi } from "../api";
import type { AiPolicy, BriefEdit, LibraryProblem } from "../api";
import { AI_OPTIONS } from "../options";
import { useResource } from "../hooks";
import { Criteria, SectionTitle, Statement } from "../parts/brief";
import { buttonClass } from "../classes";
import {
  Button,
  Choice,
  Failure,
  Field,
  Note,
  PageHeader,
  Panel,
  PanelHeader,
  SkeletonRows,
  inputClass,
  textareaClass,
} from "../ui";

const Form = ({
  library,
  defaults,
}: {
  library: LibraryProblem[];
  defaults: { durationSeconds: number; aiPolicy: AiPolicy };
}) => {
  const navigate = useNavigate();
  const { sessions } = useConsole();
  const [params] = useSearchParams();
  const initial = library.find((problem) => problem.slug === params.get("problem")) ?? library.find((problem) => problem.slug === "tasks-api") ?? library[0];

  const [problemId, setProblemId] = useState(initial.id);
  const problem = library.find((item) => item.id === problemId) ?? initial;
  const [title, setTitle] = useState("");
  const [candidateName, setCandidateName] = useState("");
  const [candidateEmail, setCandidateEmail] = useState("");
  const [aiPolicy, setAiPolicy] = useState<AiPolicy>(defaults.aiPolicy);
  const [statement, setStatement] = useState("");
  const [criteria, setCriteria] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = (id: string) => {
    setProblemId(id);
    // Wording written for one problem does not carry to another.
    setStatement("");
    setCriteria("");
    setEditing(false);
  };

  const startEditing = () => {
    setStatement(problem.statement ?? "");
    setCriteria(problem.acceptanceCriteria.join("\n"));
    setEditing(true);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const brief: BriefEdit = {};
    if (editing) {
      const lines = criteria.split("\n").map((line) => line.trim()).filter(Boolean);
      if (statement.trim() !== (problem.statement ?? "").trim()) brief.statement = statement;
      if (lines.join("\n") !== problem.acceptanceCriteria.join("\n")) brief.acceptanceCriteria = lines;
    }
    try {
      const created = await interviewApi.create({
        title: title.trim() || problem.title,
        candidateName,
        candidateEmail: candidateEmail.trim() || null,
        problemId,
        durationSeconds: defaults.durationSeconds,
        aiPolicy,
        ...(Object.keys(brief).length > 0 ? { brief } : {}),
      });
      await sessions.reload();
      navigate(`/console/interviews/${created.id}`);
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid items-start gap-6 xl:grid-cols-[minmax(0,26rem)_1fr]">
      <Panel>
        <PanelHeader title="Session" />
        <div className="space-y-4 p-5">
          <Field label="Candidate name" htmlFor="candidate-name">
            <input
              id="candidate-name"
              required
              maxLength={80}
              autoFocus
              autoComplete="off"
              value={candidateName}
              onChange={(event) => setCandidateName(event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Candidate email (optional)" htmlFor="candidate-email">
            <input
              id="candidate-email"
              type="email"
              maxLength={254}
              autoComplete="off"
              value={candidateEmail}
              onChange={(event) => setCandidateEmail(event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Title (optional)" htmlFor="session-title" >
            <input
              id="session-title"
              placeholder={problem.title}
              maxLength={120}
              autoComplete="off"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Problem" htmlFor="session-problem">
            <select
              id="session-problem"
              value={problemId}
              onChange={(event) => pick(event.target.value)}
              className={inputClass}
            >
              <optgroup label="With an interviewer guide">
                {library.filter((item) => item.hasGuide).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Practice problems">
                {library.filter((item) => !item.hasGuide).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </optgroup>
            </select>
          </Field>
          <div className="space-y-1.5">
            <p className="text-body font-medium text-ink">AI assistance</p>
            <Choice
              name="ai-policy"
              legend="AI assistance"
              value={aiPolicy}
              options={AI_OPTIONS}
              onChange={setAiPolicy}
              className="-ml-2.5"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-rule px-5 py-3">
          {error && <Note tone="negative">{error}</Note>}
          <Link to="/console/interviews" className={buttonClass("ghost")}>
            Cancel
          </Link>
          <Button type="submit" variant="primary" disabled={busy || !candidateName.trim()}>
            {busy ? "Creating" : "Create interview"}
          </Button>
        </div>
      </Panel>

      <Panel>
        <PanelHeader
          title={problem.title}
          detail={problem.summary ?? "Practice problem, no interviewer guide"}
          actions={
            editing ? (
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Use the library wording
              </Button>
            ) : (
              <Button size="sm" onClick={startEditing}>
                Edit wording for this session
              </Button>
            )
          }
        />
        <div className="space-y-5 p-5 text-body">
          {editing ? (
            <>
              <Field
                label="Brief"
                htmlFor="brief-statement"
                hint="Changes apply to this session only. The library keeps its own wording."
              >
                <textarea
                  id="brief-statement"
                  rows={10}
                  maxLength={8000}
                  value={statement}
                  onChange={(event) => setStatement(event.target.value)}
                  className={textareaClass}
                />
              </Field>
              <Field label="Acceptance criteria" htmlFor="brief-criteria" hint="One per line.">
                <textarea
                  id="brief-criteria"
                  rows={7}
                  value={criteria}
                  onChange={(event) => setCriteria(event.target.value)}
                  className={textareaClass}
                />
              </Field>
            </>
          ) : (
            <>
              <section>
                <SectionTitle>Brief</SectionTitle>
                <Statement text={problem.statement} className="text-muted" />
              </section>
              <section>
                <SectionTitle>Acceptance criteria</SectionTitle>
                <div className="text-muted">
                  <Criteria items={problem.acceptanceCriteria} empty="None written. Edit the wording to add some for this session." />
                </div>
              </section>
            </>
          )}
          <p className="text-xs text-faint">
            {problem.examples.length} public examples and {problem.heldBack.length} held-back cases are judged on every run.
          </p>
        </div>
      </Panel>
    </form>
  );
};

const InterviewNew = () => {
  const library = useResource("library", interviewApi.library);
  const settings = useResource("settings", interviewApi.settings);
  const failed = library.error ?? settings.error;

  return (
    <>
      <PageHeader title="New interview" />
      {library.data && settings.data ? (
        <Form
          library={library.data}
          defaults={{
            durationSeconds: settings.data.defaultDurationSeconds,
            aiPolicy: settings.data.defaultAiPolicy,
          }}
        />
      ) : (
        <Panel>
          {failed ? (
            <Failure
              message={failed}
              onRetry={() => {
                void library.reload();
                void settings.reload();
              }}
            />
          ) : (
            <SkeletonRows rows={6} />
          )}
        </Panel>
      )}
    </>
  );
};

export default InterviewNew;
