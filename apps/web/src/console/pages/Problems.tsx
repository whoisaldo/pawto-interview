// The problem library as an interviewer reads it: the brief, every case
// including the held-back ones, and the guide for running a session on it.

import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Plus, Search } from "lucide-react";
import { interviewApi } from "../api";
import type { LibraryProblem } from "../api";
import { durationText } from "../format";
import { useResource } from "../hooks";
import { CaseList, Criteria, GuideView, SectionTitle, Statement } from "../parts/brief";
import { buttonClass, cn } from "../classes";
import {
  Empty,
  Failure,
  PageHeader,
  Panel,
  Pill,
  Pre,
  SkeletonRows,
  Tab,
  TabList,
  TabPanel,
  TabRoot,
  inputClass,
} from "../ui";

const DIFFICULTY_TONE: Record<string, "positive" | "warning" | "negative"> = {
  easy: "positive",
  medium: "warning",
  hard: "negative",
};

const Detail = ({ problem }: { problem: LibraryProblem }) => (
  <Panel className="flex min-h-0 min-w-0 flex-col">
    <div className="flex flex-none flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-rule px-5 py-4 md:flex-nowrap">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h2 className="text-xl font-semibold text-balance text-ink">{problem.title}</h2>
          {problem.difficulty && <Pill tone={DIFFICULTY_TONE[problem.difficulty]}>{problem.difficulty}</Pill>}
          {!problem.hasGuide && <Pill>Practice problem</Pill>}
        </div>
        <p className="mt-1 text-body text-pretty text-muted">
          {problem.summary ?? "No interviewer guide. Usable as it is, with the wording edited per session."}
        </p>
        <p className="mt-1.5 text-xs text-faint">
          {problem.examples.length} public examples · {problem.heldBack.length} held-back cases ·{" "}
          {problem.recommendedDurationSeconds ? `${durationText(problem.recommendedDurationSeconds)} planned · ` : ""}
          used in {problem.sessionCount} {problem.sessionCount === 1 ? "session" : "sessions"}
        </p>
      </div>
      <Link to={`/console/interviews/new?problem=${problem.slug}`} className={buttonClass("primary")}>
        <Plus className="size-4" aria-hidden />
        New interview with this
      </Link>
    </div>

    <TabRoot defaultValue="brief" key={problem.id} className="flex min-h-0 flex-1 flex-col">
      <TabList className="flex-none">
        <Tab value="brief">Brief</Tab>
        <Tab value="cases">Cases</Tab>
        <Tab value="guide">Guide</Tab>
        <Tab value="code">Starter code</Tab>
      </TabList>
      <TabPanel value="brief" className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5 text-body">
        <section>
          <SectionTitle aside="Shown to the candidate">Brief</SectionTitle>
          <Statement text={problem.statement} className="max-w-[46rem] text-muted" />
        </section>
        <section>
          <SectionTitle aside="Shown to the candidate">Acceptance criteria</SectionTitle>
          <div className="max-w-[46rem] text-muted">
            <Criteria
              items={problem.acceptanceCriteria}
              empty="None written for this problem. You can add criteria for a session when you create it."
            />
          </div>
        </section>
        <p className="max-w-[46rem] text-xs text-pretty text-faint">
          The library's wording is the same for everyone. To change it for one interview, edit the wording when you
          create the interview or on its Setup tab. Limits: {problem.timeLimitMs} ms and {problem.memLimitMb} MB per case.
        </p>
      </TabPanel>
      <TabPanel value="cases" className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5 text-body">
        <section>
          <SectionTitle aside="Shown to the candidate, with their output">Public examples</SectionTitle>
          <CaseList cases={problem.examples} />
        </section>
        <section>
          <SectionTitle aside="Interviewer only until revealed in a session">Held-back cases</SectionTitle>
          {problem.heldBack.length > 0 ? (
            <CaseList cases={problem.heldBack} />
          ) : (
            <p className="text-faint">This problem holds nothing back.</p>
          )}
        </section>
      </TabPanel>
      <TabPanel value="guide" className="min-h-0 flex-1 overflow-y-auto p-5 text-body">
        <div className="max-w-[46rem]">
          <GuideView guide={problem.guide} provenance={problem.provenance} referenceCode={problem.referenceCode} />
        </div>
      </TabPanel>
      <TabPanel value="code" className="min-h-0 flex-1 overflow-y-auto p-5 text-body">
        <SectionTitle aside="What the editor starts with">Starter code</SectionTitle>
        <Pre className="whitespace-pre">{problem.starterCode ?? "No starter code."}</Pre>
      </TabPanel>
    </TabRoot>
  </Panel>
);

const Problems = () => {
  const library = useResource("library", interviewApi.library);
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [onlyGuided, setOnlyGuided] = useState(false);

  const all = library.data ?? [];
  const needle = query.trim().toLowerCase();
  const shown = all.filter(
    (problem) =>
      (!onlyGuided || problem.hasGuide) &&
      (needle === "" || problem.title.toLowerCase().includes(needle) || problem.slug.includes(needle)),
  );
  const selected = all.find((problem) => problem.slug === params.get("p")) ?? shown[0] ?? all[0];
  const guided = all.filter((problem) => problem.hasGuide).length;

  return (
    <>
      <PageHeader
        title="Problem library"
        finding={library.data ? `${all.length} problems, ${guided} with an interviewer guide.` : undefined}
      />
      {!library.data ? (
        <Panel>{library.error ? <Failure message={library.error} onRetry={library.reload} /> : <SkeletonRows rows={6} />}</Panel>
      ) : (
        // On a wide screen the two panes share one height and scroll inside
        // themselves, so the list stays beside whatever part of a problem is read.
        <div className="grid items-start gap-6 lg:h-[calc(100dvh-13.5rem)] lg:grid-cols-[18rem_minmax(0,1fr)] lg:items-stretch">
          <Panel className="flex min-h-0 flex-col">
            <div className="space-y-2.5 border-b border-rule p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
                <input
                  type="search"
                  aria-label="Search problems"
                  placeholder="Search problems"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className={cn(inputClass, "pl-9")}
                />
              </div>
              <label className="flex cursor-pointer items-center gap-2 px-1 text-body text-muted">
                <input
                  type="checkbox"
                  checked={onlyGuided}
                  onChange={(event) => setOnlyGuided(event.target.checked)}
                  className="size-3.5 accent-[var(--color-ink)]"
                />
                Only problems with a guide
              </label>
            </div>
            {shown.length === 0 ? (
              <Empty>No problem matches.</Empty>
            ) : (
              <ul aria-label="Problems" className="max-h-[60dvh] min-h-0 flex-1 overflow-y-auto py-1 lg:max-h-none">
                {shown.map((problem) => {
                  const current = problem.id === selected?.id;
                  return (
                    <li key={problem.id}>
                      <button
                        type="button"
                        aria-current={current}
                        onClick={() => setParams({ p: problem.slug }, { replace: true })}
                        className={cn(
                          "flex min-h-8.5 w-full items-center justify-between gap-3 px-4 py-1 text-left text-body",
                          current ? "bg-raised text-ink" : "text-muted hover:text-ink",
                        )}
                      >
                        <span className="min-w-0 truncate">{problem.title}</span>
                        {problem.hasGuide && <span className="flex-none text-xs text-faint">Guide</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
          {selected && <Detail problem={selected} />}
        </div>
      )}
    </>
  );
};

export default Problems;
