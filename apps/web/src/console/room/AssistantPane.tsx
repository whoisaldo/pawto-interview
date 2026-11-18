import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { ArrowUp, Plus, Square } from "lucide-react";
import { AskRefused, askAssistant, interviewApi } from "../api";
import type { Role, SessionView, Turn } from "../api";
import { bytesText } from "../format";
import { useResource, useStored } from "../hooks";
import { TurnBlock } from "../parts/transcript";
import { cn } from "../classes";
import { Button, Failure, IconButton, Note } from "../ui";

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
    if (!text || abort.current || answering || !ready || codeTooLarge) return;
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
          context: { prompt: selection.prompt, code: selection.code && Boolean(code.trim()), tests: selection.tests && Boolean(latestRunAt) },
          // The editor's text leaves the browser only when its box is ticked.
          ...(selection.code && code.trim() ? { code } : {}),
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
        setError("Connection lost. Try again.");
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
  const statusLine = answering ? (stopping ? "Stopping…" : "Working…") : ready ? "Ready" : assistant.detail;
  const attachments = [
    { key: "prompt", label: "Problem", disabled: false },
    { key: "code", label: "Code", disabled: !code.trim() },
    { key: "tests", label: "Tests", disabled: !latestRunAt },
  ] as const;

  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <header className="flex min-h-9 flex-none items-center justify-between gap-2 bg-ground px-3">
        <p className="flex items-center gap-1.5 text-xs text-muted" role="status">
          <span aria-hidden className={cn("size-1.5 flex-none rounded-full", answering ? "bg-accent" : STATE_DOT[assistant.state])} />
          {statusLine}
          <span className="sr-only">{ready ? assistant.model : null}</span>
        </p>
        {ready && (
          <IconButton
            label="New conversation"
            className="size-7"
            disabled={answering || conversationId === null}
            onClick={() => setConversationId(null)}
          >
            <Plus className="size-4" aria-hidden />
          </IconButton>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto" aria-label="Conversation">
        {view.aiPolicy === "allowed" && (turns.error && !turns.data ? (
          <Failure message={turns.error} onRetry={turns.reload} />
        ) : shown.length === 0 && !answering ? null : (
          <div className="divide-y divide-rule">
            {shown.filter((turn) => turn.id !== liveId).map((turn) => (
              <TurnBlock key={turn.id} turn={turn} viewer={role} configuredModel={assistant.model} compact />
            ))}
            {stream?.turn && (
              <TurnBlock
                turn={stream.turn}
                viewer={role}
                configuredModel={assistant.model}
                streamingText={stream.text}
                thinking={stream.thinking}
                compact
              />
            )}
          </div>
        ))}
        <div ref={end} />
      </div>

      {view.aiPolicy === "allowed" && (ready || answering) && (
        <form onSubmit={ask} className="flex-none border-t border-line bg-surface p-3">
          <fieldset className="mb-2 flex flex-wrap items-center gap-1.5" disabled={answering || !ready}>
            <legend className="sr-only">Attach context</legend>
            {attachments.map((item) => (
              <label
                key={item.key}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-muted has-checked:border-control has-checked:bg-raised has-checked:text-ink has-disabled:cursor-not-allowed has-disabled:opacity-50"
              >
                <input
                  type="checkbox"
                  checked={selection[item.key] && !item.disabled}
                  disabled={item.disabled}
                  onChange={(event) => setSelection({ ...selection, [item.key]: event.target.checked })}
                  className="size-3 accent-[var(--color-ink)]"
                />
                {item.label}
              </label>
            ))}
          </fieldset>
          <div className="flex items-end gap-1.5 rounded-lg border border-control bg-ground p-1.5 focus-within:border-faint">
            <textarea
              aria-label="Ask Codex"
              aria-describedby={role === "candidate" ? "codex-visibility" : undefined}
              rows={2}
              maxLength={4000}
              placeholder="Ask Codex"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={onKeyDown}
              className="min-w-0 flex-1 resize-none bg-transparent px-1.5 py-1 text-sm text-ink placeholder:text-faint"
            />
            {answering ? (
              <Button size="sm" variant="primary" aria-label="Stop" className="size-8 p-0" onClick={stop} disabled={stopping}>
                <Square className="size-3.5" aria-hidden />
              </Button>
            ) : (
              <Button size="sm" variant="primary" aria-label="Send to Codex" className="size-8 p-0" type="submit" disabled={!ready || !question.trim() || codeTooLarge}>
                <ArrowUp className="size-4" aria-hidden />
              </Button>
            )}
          </div>
          {role === "candidate" && <p id="codex-visibility" className="mt-1.5 text-xs text-faint">Visible to your interviewer</p>}
          {codeTooLarge && <Note tone="negative">Code exceeds {bytesText(assistant.limits.codeBytes)}. Remove the attachment to send.</Note>}
          {error && <Note tone="negative">{error}</Note>}
        </form>
      )}
    </div>
  );
};
