// A problem as text: the brief a candidate reads, and the guide only an
// interviewer does.

import type { ReactNode } from "react";
import Markdown from "react-markdown";
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
      <li key={item.index} className="space-y-1.5 px-3 py-2.5">
        <span className="block text-body font-medium text-ink">{item.name}</span>
        <Figure className="block min-w-0 text-xs break-words whitespace-pre-wrap text-muted">
          <span className="mb-0.5 block font-app text-faint">Input</span>
          {shown(item.input)}
        </Figure>
        <Figure className="block min-w-0 text-xs break-words whitespace-pre-wrap text-ink">
          <span className="mb-0.5 block font-app text-faint">Expected</span>
          {item.expected}
        </Figure>
      </li>
    ))}
  </ul>
);

// Statements are plain text with the odd `code` span or list. A single
// newline stays a line break, as it was when they were shown as plain text.
const asMarkdown = (text: string) => text.replace(/([^\n])\n(?!\n)/g, "$1  \n");

/** Inline Markdown only: `code`, emphasis. For one-line items such as criteria. */
export const InlineText = ({ text }: { text: string }) => (
  <Markdown allowedElements={["p", "code", "em", "strong"]} unwrapDisallowed components={{ p: ({ children }) => <>{children}</> }}>
    {text}
  </Markdown>
);

export const Statement = ({ text, className }: { text: string | null; className?: string }) => (
  <div className={cn("prose-answer text-pretty text-ink", className)}>
    {text ? <Markdown>{asMarkdown(text)}</Markdown> : <p>This problem has no statement.</p>}
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
          <span className="prose-answer"><InlineText text={item} /></span>
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
  return (
    <div className="space-y-6 text-body">
      {guide?.timeline && (
        <section>
          <SectionTitle>Interview guide</SectionTitle>
          <ul className="divide-y divide-rule rounded-md border border-line">
            {guide.timeline.map((phase) => (
              <li key={phase.phase} className="px-3 py-2">
                <p className="font-medium text-ink">{phase.phase}</p>
                <p className="text-pretty text-muted">{phase.detail}</p>
              </li>
            ))}
          </ul>
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
