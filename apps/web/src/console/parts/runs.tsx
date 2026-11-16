// Runs, case by case. The same parts serve the console and the room; what a
// run carries about held-back cases is decided by the API, not here.

import { useState } from "react";
import { errorMessage, interviewApi } from "../api";
import type { Role, RunCase, RunView } from "../api";
import { timeOfDay, verdictText } from "../format";
import { cn } from "../classes";
import { Figure, Note, Pill, Pre } from "../ui";

const outcome = (item: RunCase) => (!item.ran ? "Not run" : item.passed ? "Passed" : "Failed");
const tone = (item: RunCase) => (!item.ran ? "neutral" : item.passed ? "positive" : "negative");
const printed = (item: RunCase) => (item.stdout ?? "").trim();

const CaseRow = ({ item, detailed }: { item: RunCase; detailed: boolean }) => (
  <details className="group border-t border-rule first:border-t-0">
    <summary className="grid cursor-pointer list-none grid-cols-[1fr_auto] items-center gap-x-3 px-4 py-2 hover:bg-raised/50 sm:grid-cols-[minmax(0,1.2fr)_5rem_minmax(0,1fr)_minmax(0,1fr)] [&::-webkit-details-marker]:hidden">
      <span className="min-w-0 truncate text-ink">{item.name}</span>
      <Pill tone={tone(item)} className="justify-self-start">
        {outcome(item)}
      </Pill>
      <Figure className="hidden min-w-0 truncate text-muted sm:block">
        <span className="text-faint">expected </span>
        {item.expected}
      </Figure>
      <Figure
        className={cn(
          "hidden min-w-0 truncate sm:block",
          item.ran && item.passed === false ? "text-negative" : "text-muted",
        )}
      >
        {detailed && item.ran ? (
          <>
            <span className="text-faint">printed </span>
            {printed(item) || (item.stderr?.trim() ? "an error" : "nothing")}
          </>
        ) : null}
      </Figure>
    </summary>
    <div className="space-y-2 border-t border-rule bg-ground/60 px-4 py-3">
      <div>
        <p className="mb-1 text-xs text-faint">Input</p>
        <Pre>{item.input.trim() === "" ? "(no input)" : item.input.trimEnd()}</Pre>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <p className="mb-1 text-xs text-faint">Expected</p>
          <Pre>{item.expected}</Pre>
        </div>
        {detailed && (
          <div>
            <p className="mb-1 text-xs text-faint">Printed</p>
            <Pre>{item.ran ? printed(item) || "(nothing)" : "(not run)"}</Pre>
          </div>
        )}
      </div>
      {detailed && item.stderr?.trim() && (
        <div>
          <p className="mb-1 text-xs text-faint">Error output</p>
          <Pre className="max-h-48 overflow-y-auto text-negative">{item.stderr.trimEnd()}</Pre>
        </div>
      )}
      {!detailed && item.ran && (
        <Note>Output is not kept for held-back cases, only whether each one passed.</Note>
      )}
    </div>
  </details>
);

/** One run's cases: the public examples, then the held-back ones if this reader may see them. */
export const RunDetail = ({ run, role }: { run: RunView; role: Role }) => {
  if (run.state !== "judged") {
    return (
      <p className="px-4 py-4 text-muted" aria-live="polite">
        {run.state === "pending" ? "Waiting for the judge." : "Running every case in a sandbox."}
      </p>
    );
  }
  if (run.judgeFailed) {
    return (
      <p role="alert" className="px-4 py-4 text-negative">
        The judge could not run this submission. Nothing about the code was tested. Run it again.
      </p>
    );
  }
  const all = run.public.passed === run.public.total;
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 pt-3 pb-2">
        <h3 className="font-semibold text-ink">Public examples</h3>
        <span className={all ? "text-positive" : "text-negative"}>
          <Figure>
            {run.public.passed}/{run.public.total}
          </Figure>{" "}
          passed
        </span>
        {!all && <span className="text-xs text-faint">{verdictText(run.public.status)}</span>}
      </div>
      <div className="border-y border-rule">
        {run.public.cases.map((item) => (
          <CaseRow key={item.index} item={item} detailed />
        ))}
      </div>

      {run.heldBackCount > 0 && (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 pt-4 pb-2">
            <h3 className="font-semibold text-ink">Held-back cases</h3>
            {run.heldBack ? (
              <span className={run.heldBack.passed === run.heldBack.total ? "text-positive" : "text-negative"}>
                <Figure>
                  {run.heldBack.passed}/{run.heldBack.total}
                </Figure>{" "}
                passed
              </span>
            ) : (
              <span className="text-xs text-faint">{run.heldBackCount} judged, not shown</span>
            )}
          </div>
          {run.heldBack ? (
            <div className="border-y border-rule">
              {run.heldBack.cases.map((item) => (
                <CaseRow key={item.index} item={item} detailed={false} />
              ))}
            </div>
          ) : (
            <p className="border-y border-rule px-4 py-3 text-pretty text-muted">
              {role === "candidate"
                ? "Every run is also judged against these. Your interviewer has the results and can reveal them. Passing the examples does not mean these pass."
                : "Held-back results are hidden for this run."}
            </p>
          )}
        </>
      )}
    </div>
  );
};

/** A run as one line: who, when, and how it went. */
export const RunLine = ({ run, role }: { run: RunView; role: Role }) => (
  <span className="flex min-w-0 flex-1 items-center justify-between gap-3 py-1.5">
    <span className="min-w-0">
      <span className="block truncate text-ink">{run.userName ?? "Someone"}</span>
      <Figure className="block text-xs text-faint">{timeOfDay(run.createdAt)}</Figure>
    </span>
    {run.state !== "judged" ? (
      <Pill tone="warning">{verdictText(run.state)}</Pill>
    ) : run.judgeFailed ? (
      <Pill tone="negative">Judge failed</Pill>
    ) : (
      <span className="flex-none text-right text-muted">
        <span className="block whitespace-nowrap">
          <Figure className={run.public.passed === run.public.total ? "text-positive" : "text-negative"}>
            {run.public.passed}/{run.public.total}
          </Figure>{" "}
          public
        </span>
        {run.heldBack && (
          <span className="block whitespace-nowrap">
            <Figure className={run.heldBack.passed === run.heldBack.total ? "text-positive" : "text-negative"}>
              {run.heldBack.passed}/{run.heldBack.total}
            </Figure>{" "}
            held back
          </span>
        )}
        {!run.heldBack && role === "candidate" && run.heldBackCount > 0 && (
          <span className="block whitespace-nowrap text-faint">held back not shown</span>
        )}
      </span>
    )}
  </span>
);

/** The switch that shows held-back cases to the candidate. Interviewer only. */
export const RevealControl = ({
  sessionId,
  revealed,
  canReveal,
  onChanged,
}: {
  sessionId: string;
  revealed: boolean;
  canReveal: boolean;
  onChanged: () => void | Promise<void>;
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await interviewApi.reveal(sessionId, !revealed);
      await onChanged();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const disabled = busy || (!revealed && !canReveal);
  return (
    <div className="space-y-1.5">
      <label className={cn("flex items-center gap-3", disabled ? "cursor-not-allowed" : "cursor-pointer")}>
        <input
          type="checkbox"
          role="switch"
          checked={revealed}
          disabled={disabled}
          onChange={toggle}
          className="peer sr-only"
        />
        <span
          aria-hidden
          className={cn(
            "relative h-4.5 w-8 flex-none rounded-full border transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent",
            revealed ? "border-positive bg-positive-soft" : "border-control bg-ground",
            disabled && "opacity-50",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 size-3 rounded-full transition-transform",
              revealed ? "translate-x-4 bg-positive" : "translate-x-0.5 bg-faint",
            )}
          />
        </span>
        <span className="text-ink">
          {revealed ? "Held-back cases are shown to the candidate" : "Show held-back cases to the candidate"}
        </span>
      </label>
      {error ? (
        <Note tone="negative">{error}</Note>
      ) : !revealed && !canReveal ? (
        <Note>Available after the first judged run, so the reveal follows an attempt.</Note>
      ) : null}
    </div>
  );
};
