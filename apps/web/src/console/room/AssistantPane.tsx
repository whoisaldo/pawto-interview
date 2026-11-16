// The Claude sidebar. It asks the real CLI through the API and shows what
// comes back as it is written. Nothing is attached to a question unless its
// box is ticked, every answer shows what it used, and when the assistant
// cannot answer, the reason is what is shown.

import { Fragment, useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { Square } from "lucide-react";
import { AskRefused, askAssistant, interviewApi } from "../api";
import type { Role, SessionView, Turn } from "../api";
import { bytesText } from "../format";
import { useResource, useStored } from "../hooks";
import { TurnBlock, UsageTotal } from "../parts/transcript";
import { cn } from "../classes";
import { Button, Failure, Note, textareaClass } from "../ui";

interface Stream {
  turn: Turn | null;
  text: string;
  thinking: boolean;
}

const EMPTY_SELECTION = { prompt: false, code: false, tests: false };

const STATE_DOT: Record<string, string> = {
  ready: "bg-positive",
  policy_off: "border border-faint",
  not_running: "bg-warning",
  ended: "bg-faint",
  limit_reached: "bg-warning",
  not_configured: "bg-negative",
  misconfigured: "bg-negative",
};

const byteLength = (text: string) => new TextEncoder().encode(text).length;

export const AssistantPane = ({
  view,
  role,
  code,
  latestRunAt,
  changed,
  onAvailabilityStale,
}: {
  view: SessionView;
  role: Role;
  /** The editor's text right now. Sent only when "My code" is ticked. */
  code: string;
  latestRunAt: string | null;
  /** Changes when the room hears that a question finished somewhere. */
  changed: unknown;
  onAvailabilityStale: () => void;
}) => {
  const sessionId = view.id;
  const { assistant } = view;
  const turns = useResource(`turns:${sessionId}`, () => interviewApi.turns(sessionId), 15000);
  const [selection, setSelection] = useStored(`tandemcode.assistant.attach.${sessionId}`, EMPTY_SELECTION);
  const [conversationId, setConversationId] = useStored<string | null>(
    `tandemcode.assistant.conversation.${sessionId}.${role}`,
    null,
  );
  const [question, setQuestion] = useState("");
  const [stream, setStream] = useState<Stream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);

  const reloadTurns = turns.reload;
  useEffect(() => {
    if (changed) void reloadTurns();
  }, [changed, reloadTurns]);

  // Stop reading if the pane goes away. The server treats a reader that has
  // gone as a cancel, so the CLI does not keep running for nobody.
  useEffect(() => () => abort.current?.abort(), []);

  const answering = stream !== null;
  const streamedLength = stream?.text.length ?? 0;
  const count = turns.data?.length ?? 0;
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [count, streamedLength, answering]);

  const ready = assistant.state === "ready";
  const codeBytes = byteLength(code);
  const codeTooLarge = selection.code && codeBytes > assistant.limits.codeBytes;

  const ask = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = question.trim();
    if (!text || answering || !ready || codeTooLarge) return;
    const controller = new AbortController();
    abort.current = controller;
    setError(null);
    setStopping(false);
    setStream({ turn: null, text: "", thinking: false });
    setQuestion("");
    try {
      await askAssistant(
        sessionId,
        {
          question: text,
          context: selection,
          // The editor's text leaves the browser only when its box is ticked.
          ...(selection.code ? { code } : {}),
          ...(conversationId ? { conversationId } : {}),
        },
        {
          onTurn: (turn) => {
            setConversationId(turn.conversationId);
            setStream((current) => current && { ...current, turn });
          },
          onStarted: () => undefined,
          onThinking: () => setStream((current) => current && { ...current, thinking: true }),
          onDelta: (delta) => setStream((current) => current && { ...current, text: current.text + delta }),
          onDone: () => undefined,
        },
        controller.signal,
      );
    } catch (failure) {
      if (failure instanceof AskRefused) {
        // Never sent: give the question back, and say why.
        setQuestion(text);
        setError(failure.message);
        onAvailabilityStale();
      } else if (!controller.signal.aborted) {
        setError("The connection dropped before the answer finished. What arrived is kept below if the server recorded it.");
      }
    } finally {
      abort.current = null;
      await reloadTurns();
      setStream(null);
      setStopping(false);
    }
  };

  const stop = async () => {
    const turnId = stream?.turn?.id;
    setStopping(true);
    try {
      if (!turnId) throw new Error("not started");
      // The server stops the CLI and the stream then ends by itself, with
      // the turn recorded as stopped.
      await interviewApi.cancelTurn(sessionId, turnId);
    } catch {
      abort.current?.abort();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void ask();
    } else if (event.key === "Escape" && answering) {
      event.preventDefault();
      void stop();
    }
  };

  const shown = turns.data ?? [];
  const liveId = stream?.turn?.id;
  const statusLine = answering
    ? stopping
      ? "Stopping"
      : stream.text
        ? "Claude is answering"
        : stream.thinking
          ? "Claude is thinking"
          : "Waiting for Claude"
    : ready
      ? "Claude is available"
      : assistant.detail;

  const attach: { key: keyof typeof EMPTY_SELECTION; label: string; detail: string }[] = [
    { key: "prompt", label: "Problem", detail: "the brief, criteria and public examples" },
    { key: "code", label: role === "candidate" ? "My code" : "The code", detail: bytesText(codeBytes) },
    {
      key: "tests",
      label: "Latest test results",
      detail: latestRunAt ? "the last judged run" : "no run judged yet",
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <div className="flex-none space-y-1 border-b border-rule px-4 py-3">
        <p className="flex items-center gap-2 text-ink" role="status">
          <span aria-hidden className={cn("size-2 flex-none rounded-full", answering ? "bg-accent" : STATE_DOT[assistant.state])} />
          <span className="text-pretty">{statusLine}</span>
        </p>
        {assistant.model && view.aiPolicy === "allowed" && (
          <p className="text-xs text-faint">
            <span className="font-figure">{assistant.model}</span>
            {assistant.effort ? `, ${assistant.effort} effort` : ""} · {assistant.turnsUsed} of{" "}
            {assistant.limits.turnsPerSession} questions used in this session
          </p>
        )}
        {view.aiPolicy === "allowed" && (
          <p className="text-xs text-pretty text-faint">
            {role === "candidate"
              ? "Your interviewer can read this conversation. Only what you tick below is sent with a question."
              : "You see every question asked in this session. The candidate sees only their own."}
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" aria-label="Conversation">
        {view.aiPolicy !== "allowed" ? (
          <p className="px-4 py-4 text-pretty text-muted">
            AI assistance is off for this session, so there is no assistant to ask.
            {role === "interviewer" && " You can allow it on the session's Setup tab."}
          </p>
        ) : turns.error && !turns.data ? (
          <Failure message={turns.error} onRetry={turns.reload} />
        ) : shown.length === 0 && !answering ? (
          <p className="px-4 py-4 text-pretty text-muted">
            {role === "candidate"
              ? "No questions yet. Ask about the problem, your code or a failing case, and tick what Claude should see."
              : "No questions have been asked in this session."}
          </p>
        ) : (
          <div className="divide-y divide-rule">
            {shown.map((turn, index) => (
              <Fragment key={turn.id}>
                {index > 0 && shown[index - 1].conversationId !== turn.conversationId && (
                  <p className="bg-ground px-4 py-1 text-xs text-faint">New conversation</p>
                )}
                {turn.id === liveId ? null : (
                  <TurnBlock
                    turn={turn}
                    viewer={role}
                    configuredModel={assistant.model}
                    streamingText={turn.status === "running" ? "" : undefined}
                  />
                )}
              </Fragment>
            ))}
            {stream?.turn && (
              <TurnBlock
                turn={stream.turn}
                viewer={role}
                configuredModel={assistant.model}
                streamingText={stream.text}
                thinking={stream.thinking}
              />
            )}
            {stream && !stream.turn && <p className="px-4 py-3.5 text-muted">Sending your question.</p>}
          </div>
        )}
        <div ref={end} />
      </div>

      {view.aiPolicy === "allowed" && (
        <form onSubmit={ask} className="flex-none space-y-2.5 border-t border-line px-4 py-3">
          {shown.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <UsageTotal turns={shown} />
              <Button
                size="sm"
                variant="ghost"
                disabled={answering || conversationId === null}
                onClick={() => setConversationId(null)}
                title="The next question starts fresh, without the earlier ones"
              >
                New conversation
              </Button>
            </div>
          )}
          <fieldset className="space-y-1" disabled={answering || !ready}>
            <legend className="mb-1 text-xs text-faint">Attach to this question</legend>
            {attach.map((item) => (
              <label key={item.key} className="flex cursor-pointer items-baseline gap-2 has-disabled:cursor-not-allowed">
                <input
                  type="checkbox"
                  checked={selection[item.key]}
                  onChange={(event) => setSelection({ ...selection, [item.key]: event.target.checked })}
                  className="size-3.5 translate-y-0.5 accent-[var(--color-ink)]"
                />
                <span className={selection[item.key] ? "text-ink" : "text-muted"}>{item.label}</span>
                <span className="text-xs text-faint">{item.detail}</span>
              </label>
            ))}
          </fieldset>
          {codeTooLarge && (
            <Note tone="negative">
              The code is {bytesText(codeBytes)}. The assistant accepts {bytesText(assistant.limits.codeBytes)}. Shorten
              it or untick it.
            </Note>
          )}
          <textarea
            aria-label="Question for Claude"
            rows={3}
            maxLength={4000}
            disabled={!ready && !answering}
            placeholder={ready ? "Ask Claude. Enter sends, Shift+Enter adds a line." : assistant.detail}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={onKeyDown}
            className={textareaClass}
          />
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">{error && <Note tone="negative">{error}</Note>}</div>
            {answering ? (
              <Button onClick={stop} disabled={stopping || !stream.turn}>
                <Square className="size-3.5" aria-hidden />
                {stopping ? "Stopping" : "Stop"}
              </Button>
            ) : (
              <Button type="submit" disabled={!ready || !question.trim() || Boolean(codeTooLarge)}>
                Ask Claude
              </Button>
            )}
          </div>
        </form>
      )}
    </div>
  );
};
