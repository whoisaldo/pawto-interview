// The interview room: the brief, the shared editor, the results of each run,
// and a sidebar for Claude, the room's chat and (for the interviewer) the
// session's controls and evidence notes. One component serves both seats;
// what each seat is shown is decided by the API.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent, ReactNode } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { ArrowLeft, PanelRightClose, PanelRightOpen, Play, Send } from "lucide-react";
import { Link } from "react-router-dom";
import { Group, Panel as SplitPanel, Separator, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import CollaborativeEditor from "../../components/CollaborativeEditor";
import useWebSocket from "../../hooks/UseWebSocket";
import type { ChatMessage, RoomMember } from "../../hooks/UseWebSocket";
import { useUser } from "../../hooks/useUser";
import { submissionApi } from "../../lib/api";
import { personColor } from "../../lib/ui";
import { errorMessage, interviewApi } from "../api";
import type { Role, RunView, SessionView } from "../api";
import { FullScreenNotice } from "../auth/screens";
import { clockText, durationText, timeOfDay } from "../format";
import { useLiveClock, useResource } from "../hooks";
import { CaseList, Criteria, GuideView, SectionTitle, Statement } from "../parts/brief";
import { EvidenceForm } from "../parts/evidence";
import { PlanStrip } from "../parts/PlanStrip";
import { RevealControl, RunDetail } from "../parts/runs";
import { ClockReadout, InviteLink, SessionControls } from "../parts/session";
import { buttonClass, cn } from "../classes";
import {
  AiPill,
  Button,
  ConfirmButton,
  Failure,
  Figure,
  IconButton,
  Note,
  Pill,
  SkeletonRows,
  StatusPill,
  Tab,
  TabList,
  inputClass,
} from "../ui";
import { AssistantPane } from "./AssistantPane";

const WIDE = "(min-width: 1024px)";

const useWide = () =>
  useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(WIDE);
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => window.matchMedia(WIDE).matches,
  );

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable);

// Panes

const PaneTitle = ({ children, actions }: { children: ReactNode; actions?: ReactNode }) => (
  <div className="flex h-10 flex-none items-center justify-between gap-3 border-b border-rule px-4">
    <h2 className="truncate text-sm font-semibold text-ink">{children}</h2>
    {actions && <div className="flex flex-none items-center gap-2">{actions}</div>}
  </div>
);

const BriefPane = ({ view, role }: { view: SessionView; role: Role }) => {
  const { problem } = view;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneTitle>{problem.title}</PaneTitle>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4 text-sm leading-6">
        <section>
          <SectionTitle>Session</SectionTitle>
          <ul className="space-y-1 text-muted">
            <li>
              <span className="text-ink">{durationText(view.durationSeconds)}</span>, including follow-up questions.
            </li>
            <li className="text-pretty">
              {view.aiPolicy === "allowed" ? (
                <>
                  <span className="text-ink">AI assistance is allowed.</span>{" "}
                  {role === "candidate"
                    ? "Say what you want from it, check what it tells you, and be ready to explain the code you keep. Your interviewer can read what you ask."
                    : "The candidate may ask Claude in the sidebar. You can read every question."}
                </>
              ) : (
                <>
                  <span className="text-ink">AI assistance is off</span> for this session.
                </>
              )}
            </li>
          </ul>
        </section>
        <section>
          <SectionTitle>Brief</SectionTitle>
          <Statement text={problem.statement} />
        </section>
        <section>
          <SectionTitle>Acceptance criteria</SectionTitle>
          <Criteria items={problem.acceptanceCriteria} empty="None were written for this session." />
        </section>
        <section>
          <SectionTitle aside="Input, then the expected output">Public examples</SectionTitle>
          <CaseList cases={problem.examples} />
        </section>
        {problem.heldBackCount > 0 && (
          <section>
            <SectionTitle
              aside={
                view.heldBack
                  ? view.heldBackRevealed
                    ? "Revealed to the candidate"
                    : "Only you can see these"
                  : undefined
              }
            >
              Held-back cases
            </SectionTitle>
            {view.heldBack ? (
              <CaseList cases={view.heldBack} />
            ) : (
              <p className="text-pretty text-muted">
                {problem.heldBackCount} more cases are judged with every run and kept from you for now. Passing the
                examples does not mean they pass, so reason about the contract and not only about what you can see.
              </p>
            )}
          </section>
        )}
        <p className="text-xs text-faint">
          Python 3.11. Each case gets {problem.timeLimitMs} ms and {problem.memLimitMb} MB.
        </p>
      </div>
    </div>
  );
};

const ResultsPane = ({
  view,
  role,
  runs,
  error,
  onChanged,
}: {
  view: SessionView;
  role: Role;
  runs: RunView[] | undefined;
  error: string | null;
  onChanged: () => Promise<void>;
}) => {
  const [chosen, setChosen] = useState<string | null>(null);
  const selected = runs?.find((run) => run.id === chosen) ?? runs?.[0];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneTitle
        actions={
          runs && runs.length > 1 ? (
            <select
              aria-label="Which run to show"
              value={selected?.id}
              onChange={(event) => setChosen(event.target.value)}
              className={cn(inputClass, "h-7 w-auto py-0 text-xs")}
            >
              {runs.map((run, index) => (
                <option key={run.id} value={run.id}>
                  {index === 0 ? "Latest: " : ""}
                  {timeOfDay(run.createdAt)} {run.userName ?? ""}
                </option>
              ))}
            </select>
          ) : undefined
        }
      >
        Results
        {runs && runs.length > 0 && (
          <span className="ml-2 font-normal text-faint">
            {runs.length} {runs.length === 1 ? "run" : "runs"}
          </span>
        )}
      </PaneTitle>
      <div className="min-h-0 flex-1 overflow-y-auto text-sm">
        {error && !runs ? (
          <Failure message={error} />
        ) : !runs ? (
          <SkeletonRows rows={2} />
        ) : !selected ? (
          <p className="px-4 py-4 text-pretty text-muted">
            No runs yet. Run tests judges the code against the public examples
            {view.problem.heldBackCount > 0 ? ` and ${view.problem.heldBackCount} held-back cases` : ""}, each in its own
            sandbox.
          </p>
        ) : (
          <RunDetail run={selected} role={role} />
        )}
        {role === "interviewer" && view.problem.heldBackCount > 0 && (
          <div className="px-4 py-3.5">
            <RevealControl
              sessionId={view.id}
              revealed={view.heldBackRevealed}
              canReveal={view.interviewer?.canRevealHeldBack ?? false}
              onChanged={onChanged}
            />
          </div>
        )}
      </div>
    </div>
  );
};

const ChatPane = ({
  messages,
  connected,
  send,
}: {
  messages: ChatMessage[];
  connected: boolean;
  send: (text: string) => void;
}) => {
  const [draft, setDraft] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !connected) return;
    send(text);
    setDraft("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <p className="text-pretty text-muted">No messages. This chat is between the people in the room.</p>
        )}
        {messages.map((message) => (
          <div key={message.id}>
            <p className="text-xs text-faint">
              <span className="text-muted">{message.username}</span> ·{" "}
              <Figure>{message.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Figure>
            </p>
            <p className="text-pretty break-words whitespace-pre-wrap text-ink">{message.text}</p>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form onSubmit={submit} className="flex flex-none gap-2 border-t border-line px-4 py-3">
        <input
          aria-label="Message"
          value={draft}
          maxLength={2000}
          disabled={!connected}
          placeholder={connected ? "Message the room" : "Reconnecting"}
          onChange={(event) => setDraft(event.target.value)}
          className={inputClass}
        />
        <IconButton label="Send message" type="submit" disabled={!draft.trim() || !connected}>
          <Send className="size-4" aria-hidden />
        </IconButton>
      </form>
    </div>
  );
};

/** The interviewer's own tab: the clock, the invite, evidence notes and the guide. */
const SessionPane = ({ view, onChanged }: { view: SessionView; onChanged: () => Promise<void> }) => {
  const rubric = useResource("rubric", interviewApi.rubric);
  const evaluation = useResource(`evaluation:${view.id}`, () => interviewApi.evaluation(view.id));
  return (
    <div className="h-full min-h-0 space-y-6 overflow-y-auto px-4 py-4 text-sm">
      <section className="space-y-3">
        <ClockReadout clock={view} size="md" />
        <SessionControls session={view} onChanged={onChanged} size="sm" />
        {!view.interviewer?.candidateJoined && (
          <Note tone="warning">The candidate has not opened the invite link yet.</Note>
        )}
      </section>
      {view.interviewer?.guide?.timeline && (
        <section>
          <SectionTitle>Plan</SectionTitle>
          <PlanStrip clock={view} phases={view.interviewer.guide.timeline} compact />
        </section>
      )}
      {view.interviewer && (
        <section>
          <SectionTitle>Candidate invite link</SectionTitle>
          <InviteLink inviteCode={view.interviewer.inviteCode} />
        </section>
      )}
      <section>
        <SectionTitle aside="Saved to the session">Evidence</SectionTitle>
        {rubric.data && evaluation.data ? (
          <EvidenceForm
            compact
            sessionId={view.id}
            rubric={rubric.data}
            evaluation={evaluation.data}
            onSaved={evaluation.setData}
          />
        ) : (rubric.error ?? evaluation.error) ? (
          <Failure message={(rubric.error ?? evaluation.error)!} onRetry={evaluation.reload} />
        ) : (
          <SkeletonRows rows={3} />
        )}
      </section>
      <section>
        <details>
          <summary className="cursor-pointer rounded-sm font-semibold text-ink">Guide for this problem</summary>
          <div className="mt-3">
            <GuideView
              guide={view.interviewer?.guide ?? null}
              provenance={view.interviewer?.provenance ?? null}
              referenceCode={view.interviewer?.referenceCode ?? null}
            />
          </div>
        </details>
      </section>
    </div>
  );
};

// Header

const Members = ({ members, colorOf, selfId }: { members: RoomMember[]; colorOf: (id: string) => string; selfId: string }) => (
  <ul aria-label="In the room" className="flex items-center gap-1.5">
    {members.map((member) => (
      <li
        key={member.userId}
        title={`${member.name ?? "Someone"}${member.userId === selfId ? " (you)" : ""}`}
        className="flex size-6 items-center justify-center rounded-full border text-xs font-medium text-ink"
        style={{ borderColor: colorOf(member.userId) }}
      >
        <span aria-hidden>{(member.name ?? "?").charAt(0).toUpperCase()}</span>
        <span className="sr-only">
          {member.name ?? "Someone"}
          {member.userId === selfId ? " (you)" : ""}
        </span>
      </li>
    ))}
  </ul>
);

const statusNotice = (view: SessionView, role: Role, over: boolean): string | null => {
  if (view.status === "scheduled") {
    return role === "candidate"
      ? "The session has not started. You can read the brief; the editor unlocks when your interviewer starts the clock."
      : "Not started. The candidate can read the brief, and their editor unlocks when you start the clock.";
  }
  if (view.status === "paused") {
    return role === "candidate"
      ? "The session is paused. The editor is locked until it resumes."
      : "Paused. The candidate's editor, runs and assistant are locked until you resume.";
  }
  if (view.status === "ended") {
    return role === "candidate"
      ? "The session has ended. Your code and runs are saved. Thank you."
      : "Ended. Nothing more can be edited or run by the candidate. Write the evaluation while it is fresh.";
  }
  if (over) {
    return role === "candidate"
      ? "Time is up. Finish your sentence; your interviewer will close the session."
      : "Time is up. The session keeps running until you end it.";
  }
  return null;
};

export const RoomScreen = ({
  sessionId,
  exit,
}: {
  sessionId: string;
  /** Where the interviewer goes back to. A candidate has nowhere else to go. */
  exit?: { to: string; label: string };
}) => {
  const user = useUser();
  const wide = useWide();
  const view = useResource(`view:${sessionId}`, () => interviewApi.view(sessionId), 5000);
  const runs = useResource(`runs:${sessionId}`, () => interviewApi.runs(sessionId), 6000);
  const roomId = view.data?.roomId ?? "";
  const { isConnected, connectionState, messages, members, submissions, interviewChange, sendMessage } =
    useWebSocket(roomId);

  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [restoreToken, setRestoreToken] = useState(0);
  const [sideOpen, setSideOpen] = useState(true);
  const [sideTab, setSideTab] = useState("claude");
  const [narrowTab, setNarrowTab] = useState("code");
  const sideRef = usePanelRef();
  const clock = useLiveClock(view.data);

  // The socket says that something changed; the API says what, for this seat.
  const reloadView = view.reload;
  const reloadRuns = runs.reload;
  useEffect(() => {
    if (interviewChange) void reloadView();
  }, [interviewChange, reloadView]);
  useEffect(() => {
    if (submissions.length > 0) void reloadRuns();
  }, [submissions, reloadRuns]);
  useEffect(() => {
    if (!isConnected) return;
    void reloadView();
    void reloadRuns();
  }, [isConnected, reloadView, reloadRuns]);

  const role = view.data?.role;
  const status = view.data?.status;
  const selfId = user?.id ?? "";
  const rosterKey = members.map((member) => member.userId).join(" ");
  const colorOf = useCallback(
    (userId: string) => personColor(userId, selfId, rosterKey.split(" ")),
    [selfId, rosterKey],
  );

  const mine = runs.data?.some((run) => run.userId === selfId && run.state !== "judged") ?? false;
  const running = submitting || mine;
  const canRun = Boolean(view.data) && (role === "interviewer" || status === "running");
  const problemId = view.data?.problem.id;

  const run = useCallback(async () => {
    if (!problemId || running || !canRun) return;
    setSubmitting(true);
    setRunError(null);
    try {
      await submissionApi.submit({ roomId, problemId, language: "python", code });
      await reloadRuns();
    } catch (failure) {
      setRunError(errorMessage(failure, "The run could not be submitted."));
    } finally {
      setSubmitting(false);
    }
  }, [problemId, running, canRun, roomId, code, reloadRuns]);

  const toggleSide = useCallback(() => {
    const panel = sideRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  }, [sideRef]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "Enter" && !typing(event.target)) {
        event.preventDefault();
        void run();
      } else if (event.key.toLowerCase() === "j") {
        event.preventDefault();
        toggleSide();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run, toggleSide]);

  const outer = useDefaultLayout({ id: `tandemcode.room.columns.${role ?? "seat"}`, storage: localStorage });
  const inner = useDefaultLayout({ id: `tandemcode.room.rows.${role ?? "seat"}`, storage: localStorage });

  if (!view.data || !role || !user) {
    return view.error ? (
      <FullScreenNotice title="This session could not be opened" detail={view.error}>
        <Button onClick={() => void view.reload()}>Try again</Button>
        {exit && (
          <Link to={exit.to} className={buttonClass("ghost")}>
            {exit.label}
          </Link>
        )}
      </FullScreenNotice>
    ) : (
      <FullScreenNotice title="Opening the room" />
    );
  }

  const session = view.data;
  const refresh = async () => {
    await Promise.all([view.reload(), runs.reload()]);
  };
  const locked = session.status === "ended" || (role === "candidate" && session.status !== "running");
  const ownerPresent = members.some((member) => member.role === "owner");
  const isOwner = members.find((member) => member.userId === selfId)?.role === "owner";
  const lowest = members.map((member) => member.userId).sort()[0];
  const notice = statusNotice(session, role, clock.over > 0);
  const latestJudged = runs.data?.find((item) => item.state === "judged");

  const editor = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-10 flex-none flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-rule px-4 py-1">
        <p className="text-xs text-faint">
          Python 3.11{locked ? " · read-only" : ""}
          {members.length > 1 && " · shared with everyone in the room"}
        </p>
        <div className="flex items-center gap-2">
          {runError && <Note tone="negative">{runError}</Note>}
          {role === "interviewer" && (
            <ConfirmButton
              size="sm"
              variant="ghost"
              label="Restore starter"
              title="Replace the code with the starter?"
              description="Everything in the editor is replaced by this session's starter code, for everyone in the room. Runs already recorded are kept."
              confirmLabel="Replace the code"
              onConfirm={() => setRestoreToken((token) => token + 1)}
            />
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={run}
            disabled={running || !canRun}
            title={canRun ? "Ctrl or Cmd with Enter" : "Runs are open while the session is running"}
          >
            <Play className="size-3.5" aria-hidden />
            {running ? "Running" : "Run tests"}
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <CollaborativeEditor
          roomId={session.roomId}
          user={{ id: user.id, name: user.name || "Someone" }}
          problemId={session.problem.id}
          starterCode={session.problem.starterCode}
          replacesOnProblemChange={role === "interviewer"}
          writesStarter={ownerPresent ? isOwner : lowest === user.id}
          onCodeChange={setCode}
          colorOf={colorOf}
          height="100%"
          readOnly={locked}
          draftKey={`tandemcode.draft.${session.id}.${session.problem.id}.${user.id}`}
          restoreToken={restoreToken}
          onRunShortcut={run}
        />
      </div>
    </div>
  );

  const brief = <BriefPane view={session} role={role} />;
  const results = <ResultsPane view={session} role={role} runs={runs.data} error={runs.error} onChanged={refresh} />;
  const assistant = (
    <AssistantPane
      view={session}
      role={role}
      code={code}
      latestRunAt={latestJudged?.createdAt ?? null}
      changed={interviewChange}
      onAvailabilityStale={() => void view.reload()}
    />
  );
  const chat = <ChatPane messages={messages} connected={isConnected} send={sendMessage} />;

  const side = (
    <Tabs.Root value={sideTab} onValueChange={(value) => setSideTab(String(value))} className="flex h-full min-h-0 flex-col">
      <TabList className="flex-none px-4">
        <Tab value="claude">Claude</Tab>
        <Tab value="chat">Chat</Tab>
        {role === "interviewer" && <Tab value="session">Session</Tab>}
      </TabList>
      <Tabs.Panel value="claude" keepMounted className="min-h-0 flex-1 data-hidden:hidden">
        {assistant}
      </Tabs.Panel>
      <Tabs.Panel value="chat" className="min-h-0 flex-1">
        {chat}
      </Tabs.Panel>
      {role === "interviewer" && (
        <Tabs.Panel value="session" className="min-h-0 flex-1">
          <SessionPane view={session} onChanged={refresh} />
        </Tabs.Panel>
      )}
    </Tabs.Root>
  );

  const divider =
    "relative flex-none bg-line outline-none data-[separator=active]:bg-accent data-[separator=hover]:bg-accent focus-visible:bg-accent";

  return (
    <div className="console flex h-dvh flex-col overflow-hidden">
      <header className="flex min-h-12 flex-none flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-1.5">
        {exit ? (
          <Link to={exit.to} className="flex flex-none items-center gap-1.5 rounded-sm text-sm text-muted hover:text-ink">
            <ArrowLeft className="size-3.5" aria-hidden />
            {exit.label}
          </Link>
        ) : (
          <img src="/mascot.png" alt="TandemCode" className="pixelated size-6 flex-none" />
        )}
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
          {session.title}
          <span className="ml-2 font-normal text-faint">
            {role === "candidate" ? session.candidateName : `with ${session.candidateName}`}
          </span>
        </h1>

        <div className="flex flex-none items-center gap-3">
          <Figure
            className={cn(
              "text-xl leading-none font-medium",
              clock.over > 0 ? "text-negative" : session.status === "running" ? "text-ink" : "text-muted",
            )}
          >
            <span className="sr-only">{clock.over > 0 ? "Over time by " : "Time left "}</span>
            {clock.over > 0 ? `+${clockText(clock.over)}` : clockText(clock.remaining)}
          </Figure>
          <StatusPill status={session.status} />
          <AiPill policy={session.aiPolicy} />
          {session.isSample && <Pill>Sample</Pill>}
        </div>

        <div className="flex flex-none items-center gap-3">
          <Members members={members} colorOf={colorOf} selfId={selfId} />
          <span className="flex items-center gap-1.5 text-xs text-muted" role="status">
            <span
              aria-hidden
              className={cn("size-1.5 rounded-full", isConnected ? "bg-positive" : "bg-warning")}
            />
            {isConnected ? "Live" : connectionState === "connecting" ? "Connecting" : "Reconnecting"}
          </span>
          {wide && (
            <IconButton
              label={sideOpen ? "Hide the sidebar (Ctrl or Cmd with J)" : "Show the sidebar (Ctrl or Cmd with J)"}
              aria-pressed={sideOpen}
              onClick={toggleSide}
            >
              {sideOpen ? <PanelRightClose className="size-4" aria-hidden /> : <PanelRightOpen className="size-4" aria-hidden />}
            </IconButton>
          )}
        </div>
      </header>

      {notice && (
        <p role="status" className="flex-none border-b border-line bg-raised px-4 py-1.5 text-sm text-pretty text-ink">
          {notice}
        </p>
      )}

      {wide ? (
        <Group
          orientation="horizontal"
          className="min-h-0 flex-1"
          defaultLayout={outer.defaultLayout}
          onLayoutChanged={outer.onLayoutChanged}
        >
          <SplitPanel id="brief" defaultSize="27%" minSize="16%" collapsible collapsedSize={0} className="bg-surface">
            {brief}
          </SplitPanel>
          <Separator className={cn(divider, "w-px")} aria-label="Resize the brief" />
          <SplitPanel id="work" minSize="28%">
            <Group
              orientation="vertical"
              className="h-full"
              defaultLayout={inner.defaultLayout}
              onLayoutChanged={inner.onLayoutChanged}
            >
              <SplitPanel id="editor" defaultSize="60%" minSize="20%">
                {editor}
              </SplitPanel>
              <Separator className={cn(divider, "h-px")} aria-label="Resize the results" />
              <SplitPanel id="results" defaultSize="40%" minSize="12%" className="bg-surface">
                {results}
              </SplitPanel>
            </Group>
          </SplitPanel>
          <Separator className={cn(divider, "w-px")} aria-label="Resize the sidebar" />
          <SplitPanel
            id="side"
            panelRef={sideRef}
            defaultSize="30%"
            minSize="20%"
            collapsible
            collapsedSize={0}
            onResize={(size) => setSideOpen(size.asPercentage > 0.5)}
            className="bg-surface"
          >
            {/* Collapsed, it stays mounted so an answer in progress is kept,
                and is hidden so focus cannot land on controls nobody can see. */}
            <div className={cn("h-full", !sideOpen && "invisible")}>{side}</div>
          </SplitPanel>
        </Group>
      ) : (
        // On a narrow screen: one pane at a time. The editor stays mounted so
        // the shared document is not dropped by looking at something else.
        <Tabs.Root value={narrowTab} onValueChange={(value) => setNarrowTab(String(value))} className="flex min-h-0 flex-1 flex-col">
          <TabList className="flex-none px-4">
            <Tab value="brief">Brief</Tab>
            <Tab value="code">Code</Tab>
            <Tab value="results">Results</Tab>
            <Tab value="side">Claude and chat</Tab>
          </TabList>
          <Tabs.Panel value="brief" className="min-h-0 flex-1 bg-surface">
            {brief}
          </Tabs.Panel>
          <Tabs.Panel value="code" keepMounted className="min-h-0 flex-1 data-hidden:hidden">
            {editor}
          </Tabs.Panel>
          <Tabs.Panel value="results" className="min-h-0 flex-1 bg-surface">
            {results}
          </Tabs.Panel>
          <Tabs.Panel value="side" keepMounted className="min-h-0 flex-1 bg-surface data-hidden:hidden">
            {side}
          </Tabs.Panel>
        </Tabs.Root>
      )}
    </div>
  );
};
