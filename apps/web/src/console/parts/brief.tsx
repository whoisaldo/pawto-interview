// A problem as text: the brief a candidate reads, and the guide only an
// interviewer does.

import type { ReactNode } from "react";
import type { Case, Guide } from "../api";
import { cn } from "../classes";
import { Figure, Pre } from "../ui";

export const SectionTitle = ({ children, aside }: { children: ReactNode; aside?: ReactNode }) => (
  <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
    <h3 className="text-sm font-semibold text-ink">{children}</h3>
    {aside && <span className="text-xs text-faint">{aside}</span>}
  </div>
);

const shown = (text: string) => (text.trim() === "" ? "(no input)" : text.trim());

/** Cases as input and expected output. For examples, and for held-back cases where they may be seen. */
export const CaseList = ({ cases, className }: { cases: Case[]; className?: string }) => (
  <ul className={cn("divide-y divide-rule rounded-md border border-line", className)}>
    {cases.map((item) => (
      <li key={item.index} className="grid gap-x-4 gap-y-1 px-3 py-2 sm:grid-cols-[minmax(0,11rem)_1fr_auto] sm:items-baseline">
        <span className="text-body text-ink">{item.name}</span>
        <Figure className="min-w-0 text-xs break-all text-muted">{shown(item.input)}</Figure>
        <Figure className="text-xs text-ink">
          <span className="sr-only">expected </span>
          {item.expected}
        </Figure>
      </li>
    ))}
  </ul>
);

export const Statement = ({ text, className }: { text: string | null; className?: string }) => (
  <div className={cn("space-y-3 text-pretty whitespace-pre-line text-ink", className)}>
    {text ?? "This problem has no statement."}
  </div>
);

export const Criteria = ({ items, empty }: { items: string[]; empty?: ReactNode }) =>
  items.length === 0 ? (
    <p className="text-body text-faint">{empty ?? "No acceptance criteria are written for this problem."}</p>
  ) : (
    <ul className="space-y-1.5">
      {items.map((item, index) => (
        <li key={index} className="flex gap-2.5 text-pretty">
          <span aria-hidden className="mt-2 size-1 flex-none rounded-full bg-faint" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );

/** The interviewer's plan for the session. Never rendered on the candidate's side. */
export const GuideView = ({
  guide,
  provenance,
  referenceCode,
}: {
  guide: Guide | null;
  provenance: string | null;
  referenceCode: string | null;
}) => {
  if (!guide && !provenance && !referenceCode) {
    return (
      <p className="text-body text-pretty text-faint">
        No interviewer guide is written for this problem. Its statement, examples and held-back cases are all there is.
      </p>
    );
  }
  let minute = 0;
  return (
    <div className="space-y-6 text-body">
      {guide?.timeline && (
        <section>
          <SectionTitle aside={`${guide.timeline.reduce((total, phase) => total + phase.minutes, 0)} minutes in all`}>
            Plan
          </SectionTitle>
          <ol className="divide-y divide-rule rounded-md border border-line">
            {guide.timeline.map((phase) => {
              const from = minute;
              minute += phase.minutes;
              return (
                <li key={phase.phase} className="grid gap-x-4 gap-y-0.5 px-3 py-2 sm:grid-cols-[5.5rem_1fr]">
                  <Figure className="text-xs text-faint">
                    {from}:00 to {minute}:00
                  </Figure>
                  <div>
                    <p className="font-medium text-ink">{phase.phase}</p>
                    <p className="text-pretty text-muted">{phase.detail}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      )}
      {guide?.changeRequest && (
        <section>
          <SectionTitle>Change request</SectionTitle>
          <p className="text-pretty text-ink">{guide.changeRequest.prompt}</p>
          <p className="mt-3 mb-1.5 text-xs text-faint">Listen for</p>
          <ul className="space-y-1.5 text-muted">
            {guide.changeRequest.listenFor.map((item, index) => (
              <li key={index} className="flex gap-2.5 text-pretty">
                <span aria-hidden className="mt-2 size-1 flex-none rounded-full bg-faint" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {(guide?.heldBackNote || guide?.extension) && (
        <section className="space-y-2 text-pretty text-muted">
          <SectionTitle>Notes</SectionTitle>
          {guide.heldBackNote && <p>{guide.heldBackNote}</p>}
          {guide.extension && <p>{guide.extension}</p>}
        </section>
      )}
      {provenance && (
        <section>
          <SectionTitle>Provenance</SectionTitle>
          <p className="text-pretty break-words whitespace-pre-line text-muted">{provenance}</p>
        </section>
      )}
      {referenceCode && (
        <section>
          <SectionTitle aside="Interviewer only">Reference answer</SectionTitle>
          <details className="group">
            <summary className="cursor-pointer rounded-sm text-muted hover:text-ink">
              <span className="group-open:hidden">Show the reference answer</span>
              <span className="hidden group-open:inline">Hide the reference answer</span>
            </summary>
            <Pre className="mt-2 max-h-96 overflow-y-auto whitespace-pre">{referenceCode}</Pre>
          </details>
        </section>
      )}
    </div>
  );
};
