// Cells that several session tables share, so a session reads the same on
// every page.

import { Link } from "react-router-dom";
import type { SessionSummary } from "../api";
import { Figure, SampleTag } from "../ui";

/** The identity cell: the session's title over its candidate. */
export const SessionCell = ({ session, to }: { session: SessionSummary; to?: string }) => (
  <div className="min-w-44 py-1.5">
    <div className="flex min-w-0 items-center gap-2">
      <Link
        to={to ?? `/console/interviews/${session.id}`}
        className="min-w-0 truncate rounded-sm font-medium text-ink hover:underline"
      >
        {session.title}
      </Link>
      {session.isSample && <SampleTag />}
    </div>
    <p className="truncate text-xs text-faint">{session.candidateName}</p>
  </div>
);

/** The last judged run, as counts. A session with no run says so in words. */
export const LastRunCell = ({ session }: { session: SessionSummary }) => {
  const last = session.runs.last;
  if (session.runs.count === 0) return <span className="text-faint">No runs</span>;
  if (!last) return <span className="text-muted">Judging</span>;
  return (
    <span className="whitespace-nowrap text-muted">
      <Figure className={last.publicPassed === last.publicTotal ? "text-positive" : "text-negative"}>
        {last.publicPassed}/{last.publicTotal}
      </Figure>{" "}
      public ·{" "}
      <Figure className={last.heldBackPassed === last.heldBackTotal ? "text-positive" : "text-negative"}>
        {last.heldBackPassed}/{last.heldBackTotal}
      </Figure>{" "}
      held back
    </span>
  );
};
