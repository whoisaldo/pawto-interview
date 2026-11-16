// The session's plan against its clock: the guide's phases laid along the
// session's length, with a line where the clock is now. It tells the
// interviewer which part of the plan they should be in, and what to listen
// for there. Only interviewers have a guide, so only they see this.

import type { Clock, GuidePhase } from "../api";
import { cn } from "../classes";
import { clockText } from "../format";
import { useLiveClock } from "../hooks";
import { Figure } from "../ui";

export const PlanStrip = ({
  clock,
  phases,
  compact = false,
}: {
  clock: Clock;
  phases: GuidePhase[];
  compact?: boolean;
}) => {
  const live = useLiveClock(clock);
  const planned = phases.reduce((total, phase) => total + phase.minutes, 0);
  if (planned === 0) return null;
  // The plan is written in minutes. A session of another length keeps the
  // plan's proportions.
  const scale = clock.durationSeconds / (planned * 60);
  let start = 0;
  const spans = phases.map((phase) => {
    const from = start;
    start += phase.minutes * 60 * scale;
    return { ...phase, from, to: start };
  });
  const elapsed = Math.min(live.elapsed, clock.durationSeconds);
  const begun = clock.status !== "scheduled";
  const current = begun && live.over === 0 ? spans.find((span) => elapsed >= span.from && elapsed < span.to) : undefined;

  return (
    <div>
      <div className="relative">
        <ol className="flex" aria-label="Plan for the session">
          {spans.map((span) => {
            const here = span === current;
            const past = begun && elapsed >= span.to;
            return (
              <li
                key={span.phase}
                aria-current={here ? "step" : undefined}
                style={{ flexGrow: span.to - span.from, flexBasis: 0 }}
                className="min-w-0 border-l border-control pt-1 pr-2 pb-2.5 pl-2 first:border-l-0 first:pl-0"
              >
                <Figure className="block text-xs text-faint">{clockText(span.from)}</Figure>
                <span
                  className={cn(
                    "line-clamp-2 text-balance",
                    compact ? "text-xs" : "text-body",
                    here ? "font-medium text-ink" : past ? "text-faint" : "text-muted",
                  )}
                  title={span.phase}
                >
                  {span.phase}
                </span>
              </li>
            );
          })}
        </ol>
        <div className="h-0.5 rounded-full bg-raised" aria-hidden>
          <div className="h-full rounded-full bg-muted" style={{ width: `${(begun ? live.fraction : 0) * 100}%` }} />
        </div>
        {/* A short mark on the track, so it never runs through a label. */}
        {begun && (
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-1 h-3 w-px bg-accent"
            style={{ left: `${live.fraction * 100}%` }}
          />
        )}
      </div>
      <p className={cn("mt-2 text-pretty text-muted", compact ? "text-xs" : "text-body")} aria-live="polite">
        {!begun ? (
          `The plan covers ${clockText(clock.durationSeconds)}. It starts with ${spans[0].phase.toLowerCase()}.`
        ) : live.over > 0 ? (
          "The planned time is used up."
        ) : current ? (
          <>
            <span className="text-ink">Now: {current.phase}.</span> {current.detail}
          </>
        ) : null}
      </p>
    </div>
  );
};
