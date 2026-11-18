// An edit Codex proposed, as a diff with Approve and Deny. See edits.ts.

import { useContext, useState } from "react";
import { Check, X } from "lucide-react";
import { useStored } from "../hooks";
import { cn } from "../classes";
import { Button, Note } from "../ui";
import { EditContext, parseEdit } from "./edits";
import type { Hunk } from "./edits";

/** One hunk as diff lines, by longest common subsequence: unchanged lines are context. */
const diffLines = ({ search, replace }: Hunk) => {
  const before = search === "" ? [] : search.split("\n");
  const after = replace === "" ? [] : replace.split("\n");
  const common = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      common[i][j] = before[i] === after[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
    }
  }
  const rows: { kind: "same" | "add" | "remove"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      rows.push({ kind: "same", line: before[i] });
      i += 1;
      j += 1;
    } else if (common[i + 1][j] >= common[i][j + 1]) {
      rows.push({ kind: "remove", line: before[i] });
      i += 1;
    } else {
      rows.push({ kind: "add", line: after[j] });
      j += 1;
    }
  }
  while (i < before.length) rows.push({ kind: "remove", line: before[i++] });
  while (j < after.length) rows.push({ kind: "add", line: after[j++] });
  return rows;
};

const hash = (text: string) => {
  let value = 0;
  for (let index = 0; index < text.length; index += 1) value = (value * 31 + text.charCodeAt(index)) | 0;
  return (value >>> 0).toString(36);
};

type Decision = "approved" | "denied" | null;

export const EditProposal = ({ text, turnId, live, mine }: { text: string; turnId: string; live: boolean; mine: boolean }) => {
  const actions = useContext(EditContext);
  const [decision, setDecision] = useStored<Decision>(`tandemcode.assistant.edit.${turnId}.${hash(text)}`, null);
  const [error, setError] = useState<string | null>(null);
  const parsed = live ? null : parseEdit(text);

  if (!parsed || "error" in parsed) {
    return (
      <pre>
        <code>{text}</code>
        {parsed && <span className="mt-1 block text-xs text-faint">{parsed.error}</span>}
      </pre>
    );
  }

  const offered = actions !== null && mine;
  const approve = () => {
    const failure = actions?.apply ? actions.apply(parsed.hunks) : "The editor is locked right now.";
    setError(failure);
    if (!failure) setDecision("approved");
  };

  return (
    <div className={cn("overflow-hidden rounded-md border border-line bg-ground", decision === "denied" && "opacity-60")}>
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5 text-xs">
        <span className="font-medium text-muted">Proposed change</span>
        {decision === "approved" && <span className="inline-flex items-center gap-1 text-positive"><Check className="size-3.5" aria-hidden />Applied</span>}
        {decision === "denied" && <span className="text-faint">Denied</span>}
      </div>
      <pre className="!m-0 !rounded-none !border-0">
        <code>
          {parsed.hunks.map((hunk, index) => (
            <span key={index} className={cn("block", index > 0 && "mt-2 border-t border-dashed border-line pt-2")}>
              {diffLines(hunk).map((row, line) => (
                <span key={line} className={cn("block", row.kind === "add" && "diff-add", row.kind === "remove" && "diff-remove")}>
                  {row.kind === "add" ? "+ " : row.kind === "remove" ? "- " : "  "}
                  {row.line}
                </span>
              ))}
            </span>
          ))}
        </code>
      </pre>
      {offered && decision === null && (
        <div className="flex items-center gap-2 border-t border-line px-3 py-2">
          <Button size="sm" variant="primary" onClick={approve} disabled={!actions?.apply}>
            <Check className="size-3.5" aria-hidden />
            Approve
          </Button>
          <Button size="sm" onClick={() => setDecision("denied")}>
            <X className="size-3.5" aria-hidden />
            Deny
          </Button>
          {!actions?.apply && <span className="text-xs text-faint">The editor is locked.</span>}
        </div>
      )}
      {error && <Note tone="negative" className="mx-3 mb-2">{error}</Note>}
    </div>
  );
};
