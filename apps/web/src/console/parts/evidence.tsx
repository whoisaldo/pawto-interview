// The interviewer's evidence notes. Four things that can be observed, each
// scored 0 to 2 or left unobserved, and a recommendation that only a person
// sets. Nothing on this form is filled in from a test result.

import { useId, useState } from "react";
import { Download } from "lucide-react";
import { DIMENSIONS, errorMessage, interviewApi } from "../api";
import type { Dimension, Evaluation, Recommendation, Rubric, Score } from "../api";
import { dayAndTime, downloadText } from "../format";
import { cn } from "../classes";
import {
  Button,
  Choice,
  Field,
  Note,
  textareaClass,
} from "../ui";

type Draft = Pick<Evaluation, "evidence" | "summary" | "recommendation">;

const draftOf = (evaluation: Evaluation): Draft => ({
  evidence: evaluation.evidence,
  summary: evaluation.summary,
  recommendation: evaluation.recommendation,
});

const same = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

const scoreText = (score: Score) => (score === null ? "–" : String(score));

/** The four scores in a row, for tables. A dash is unobserved, not zero. */
export const ScoreRow = ({ scores, rubric }: { scores: Record<Dimension, Score>; rubric?: Rubric }) => (
  <span className="inline-flex gap-3 font-figure">
    {DIMENSIONS.map((dimension) => {
      const label = rubric?.evidence.find((item) => item.key === dimension)?.label ?? dimension;
      const score = scores[dimension];
      return (
        <span
          key={dimension}
          title={`${label}: ${score === null ? "unobserved" : score}`}
          className={score === null ? "text-faint" : "text-ink"}
        >
          <span className="sr-only">{label} </span>
          {scoreText(score)}
        </span>
      );
    })}
  </span>
);

export const EvidenceForm = ({
  sessionId,
  rubric,
  evaluation,
  onSaved,
  compact = false,
}: {
  sessionId: string;
  rubric: Rubric;
  evaluation: Evaluation;
  onSaved: (evaluation: Evaluation) => void;
  /** In the room's sidebar, where there is a third of the width. */
  compact?: boolean;
}) => {
  const formId = useId();
  const [draft, setDraft] = useState<Draft>(() => draftOf(evaluation));
  const [saved, setSaved] = useState<Draft>(() => draftOf(evaluation));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const dirty = !same(draft, saved);

  // A save made elsewhere (the room, another tab) replaces a draft nobody has
  // touched, and never one somebody is in the middle of.
  const incoming = draftOf(evaluation);
  if (!same(incoming, saved) && !busy) {
    if (!dirty) setDraft(incoming);
    setSaved(incoming);
  }

  const setEvidence = (dimension: Dimension, change: Partial<{ score: Score; note: string }>) =>
    setDraft((current) => ({
      ...current,
      evidence: { ...current.evidence, [dimension]: { ...current.evidence[dimension], ...change } },
    }));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await interviewApi.saveEvaluation(sessionId, draft);
      setSaved(draftOf(next));
      setDraft(draftOf(next));
      onSaved(next);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const exportAs = async (format: "json" | "markdown") => {
    setExportError(null);
    try {
      const text = await interviewApi.exportEvaluation(sessionId, format);
      downloadText(
        `evaluation-${sessionId}.${format === "json" ? "json" : "md"}`,
        text,
        format === "json" ? "application/json" : "text/markdown",
      );
    } catch (failure) {
      setExportError(errorMessage(failure, "The export could not be made."));
    }
  };

  const scoreOptions = [
    { value: "unobserved", label: rubric.unobserved, hint: "There was no chance to see this. Not a zero." },
    ...rubric.scores.map((score) => ({ value: String(score.value), label: `${score.value} ${score.label}` })),
  ];

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="space-y-5"
    >
      {rubric.evidence.map((item) => {
        const entry = draft.evidence[item.key];
        return (
          <fieldset key={item.key} className={cn("grid gap-x-6 gap-y-2", !compact && "lg:grid-cols-[minmax(0,17rem)_1fr]")}>
            <div>
              <legend className="font-semibold text-ink">{item.label}</legend>
              <p className="mt-0.5 text-xs text-pretty text-faint">{item.prompt}</p>
            </div>
            <div className="space-y-2">
              <Choice
                name={`${formId}-${item.key}`}
                legend={`${item.label} score`}
                value={entry.score === null ? "unobserved" : String(entry.score)}
                options={scoreOptions}
                onChange={(value) =>
                  setEvidence(item.key, { score: value === "unobserved" ? null : (Number(value) as 0 | 1 | 2) })
                }
                className="-ml-2.5"
              />
              <textarea
                aria-label={`${item.label} note`}
                rows={compact ? 2 : 2}
                maxLength={4000}
                placeholder="What you saw or heard"
                value={entry.note}
                onChange={(event) => setEvidence(item.key, { note: event.target.value })}
                className={textareaClass}
              />
            </div>
          </fieldset>
        );
      })}

      <Field label="Summary" htmlFor={`${formId}-summary`}>
        <textarea
          id={`${formId}-summary`}
          rows={3}
          maxLength={8000}
          value={draft.summary}
          onChange={(event) => setDraft((current) => ({ ...current, summary: event.target.value }))}
          className={textareaClass}
        />
      </Field>

      <div className="space-y-1.5">
        <p className="font-medium text-ink">Recommendation</p>
        <Choice
          name={`${formId}-recommendation`}
          legend="Recommendation"
          value={draft.recommendation}
          options={rubric.recommendations}
          onChange={(value) => setDraft((current) => ({ ...current, recommendation: value as Recommendation }))}
          className="-ml-2.5"
        />
        <Note>Yours to set. Test results never fill this in or change it.</Note>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-t border-rule pt-4">
        <div className="space-y-1">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => exportAs("json")} disabled={!evaluation.saved}>
              <Download className="size-3.5" aria-hidden />
              Export JSON
            </Button>
            <Button size="sm" onClick={() => exportAs("markdown")} disabled={!evaluation.saved}>
              <Download className="size-3.5" aria-hidden />
              Export Markdown
            </Button>
          </div>
          {exportError ? (
            <Note tone="negative">{exportError}</Note>
          ) : !evaluation.saved ? (
            <Note>Save the evaluation to export it.</Note>
          ) : dirty ? (
            <Note>Exports use the last saved version.</Note>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          {error ? (
            <Note tone="negative">{error}</Note>
          ) : dirty ? (
            <Note tone="warning">Unsaved changes</Note>
          ) : evaluation.saved && evaluation.updatedAt ? (
            <Note>
              Saved {dayAndTime(evaluation.updatedAt)}
              {evaluation.updatedByName ? ` by ${evaluation.updatedByName}` : ""}
            </Note>
          ) : (
            <Note>Not saved yet</Note>
          )}
          <Button type="submit" variant="primary" disabled={busy || (!dirty && evaluation.saved)}>
            {busy ? "Saving" : "Save evaluation"}
          </Button>
        </div>
      </div>
    </form>
  );
};
