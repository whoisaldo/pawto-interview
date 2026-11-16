// Defaults for new interviews, and the state of what a session depends on:
// the assistant's CLI, the judge, and how people sign in.

import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useConsole } from "../context";
import { errorMessage, interviewApi } from "../api";
import type { AiPolicy, AssistantTest, InterviewSettings, SystemStatus } from "../api";
import { bytesText, countText, durationText, secondsText, timeAgo, usdText } from "../format";
import { cn } from "../classes";
import { useResource } from "../hooks";
import {
  Button,
  Choice,
  Failure,
  Field,
  Figure,
  Note,
  PageHeader,
  Panel,
  SkeletonRows,
  inputClass,
} from "../ui";
import { AI_OPTIONS } from "../options";

const Section = ({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) => (
  <section className="grid gap-x-10 gap-y-4 border-b border-line py-7 first:pt-0 last:border-b-0 lg:grid-cols-[minmax(0,19rem)_1fr]">
    <div>
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      <div className="mt-1 space-y-2 text-body text-pretty text-muted">{description}</div>
    </div>
    <Panel className="min-w-0">{children}</Panel>
  </section>
);

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="grid gap-x-4 gap-y-0.5 border-t border-rule px-5 py-2.5 first:border-t-0 sm:grid-cols-[11rem_1fr]">
    <dt className="text-faint">{label}</dt>
    <dd className="min-w-0 text-ink">{children}</dd>
  </div>
);

const Defaults = ({ settings, onSaved }: { settings: InterviewSettings; onSaved: (next: InterviewSettings) => void }) => {
  const [minutes, setMinutes] = useState(String(Math.round(settings.defaultDurationSeconds / 60)));
  const [aiPolicy, setAiPolicy] = useState<AiPolicy>(settings.defaultAiPolicy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const length = Number(minutes);
  const lengthError = !Number.isFinite(length) || length < 1 || length > 240 ? "Between 1 and 240 minutes." : null;
  const dirty =
    Math.round(length * 60) !== settings.defaultDurationSeconds || aiPolicy !== settings.defaultAiPolicy;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (lengthError) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await interviewApi.saveSettings({ defaultDurationSeconds: Math.round(length * 60), defaultAiPolicy: aiPolicy }));
      setSaved(true);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="space-y-4 p-5">
        <Field label="Length in minutes" htmlFor="default-minutes" error={lengthError}>
          <input
            id="default-minutes"
            inputMode="numeric"
            value={minutes}
            onChange={(event) => {
              setMinutes(event.target.value.replace(/[^0-9]/g, ""));
              setSaved(false);
            }}
            className={cn(inputClass, "w-24 font-figure")}
          />
        </Field>
        <div className="space-y-1.5">
          <p className="text-body font-medium text-ink">AI assistance</p>
          <Choice
            name="default-ai"
            legend="Default AI assistance"
            value={aiPolicy}
            options={AI_OPTIONS}
            onChange={(value) => {
              setAiPolicy(value);
              setSaved(false);
            }}
            className="-ml-2.5"
          />
        </div>
        <p className="rounded-md bg-ground px-3 py-2 text-body text-pretty text-muted">
          A new interview will start at{" "}
          <span className="text-ink">{lengthError ? "a length you still need to set" : durationText(Math.round(length * 60))}</span>{" "}
          with <span className="text-ink">{aiPolicy === "allowed" ? "AI allowed" : "AI off"}</span>, unless its problem's
          guide plans a different length. Both can be changed on each interview.
        </p>
      </div>
      <div className="flex items-center justify-end gap-3 border-t border-rule px-5 py-3">
        {error ? <Note tone="negative">{error}</Note> : saved && !dirty ? <Note tone="positive">Saved</Note> : null}
        <Button type="submit" variant="primary" disabled={busy || !dirty || Boolean(lengthError)}>
          {busy ? "Saving" : "Save defaults"}
        </Button>
      </div>
    </form>
  );
};

const Assistant = ({ assistant }: { assistant: SystemStatus["assistant"] }) => {
  const [result, setResult] = useState<AssistantTest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { system } = useConsole();

  const test = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await interviewApi.testAssistant());
      await system.reload();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <dl className="text-body">
        <Row label="State">
          <span className={assistant.ready ? "text-positive" : assistant.problem ? "text-negative" : "text-muted"}>
            {assistant.ready ? "Ready" : assistant.problem ? "Misconfigured" : "Not set up"}
          </span>
          {assistant.problem && <p className="mt-0.5 text-pretty text-muted">{assistant.problem}</p>}
          {!assistant.configured && (
            <p className="mt-0.5 text-pretty text-muted">
              No Claude CLI is configured on the server. Sessions with AI allowed tell the candidate the assistant is
              unavailable. Nothing answers in its place.
            </p>
          )}
        </Row>
        {assistant.ready && (
          <>
            <Row label="Model">
              <Figure>{assistant.model}</Figure>
              {assistant.effort && <span className="text-muted">, {assistant.effort} effort</span>}
              <p className="mt-0.5 text-pretty text-muted">The only model asked. If it cannot answer, the question fails.</p>
            </Row>
            <Row label="Launcher and profile">
              <Figure>{assistant.launcher}</Figure> <span className="text-muted">with profile</span>{" "}
              <Figure>{assistant.profile}</Figure>
            </Row>
            <Row label="Per question">
              <span className="text-muted">
                Up to {bytesText(assistant.limits.promptBytes)} sent, {bytesText(assistant.limits.outputBytes)} back,{" "}
                {assistant.limits.timeoutSeconds} s to answer. Code attached up to {bytesText(assistant.limits.codeBytes)}.
              </span>
            </Row>
            <Row label="Per session">
              <span className="text-muted">
                {assistant.limits.turnsPerSession} questions, one at a time per person.{" "}
                {assistant.running} of {assistant.maxRunning} running now across all sessions.
              </span>
            </Row>
            <Row label="What it can do">
              <span className="text-pretty text-muted">
                Answer in text. It runs with no tools, no saved session and none of the profile's own instructions, so it
                cannot read files or run commands on this machine.
              </span>
            </Row>
          </>
        )}
      </dl>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rule px-5 py-3">
        <div className="min-w-0 text-body" aria-live="polite">
          {error ? (
            <Note tone="negative">{error}</Note>
          ) : busy ? (
            <span className="text-muted">Asking Claude one small question.</span>
          ) : result ? (
            result.ok ? (
              <span className="text-positive">
                Answered "{result.answer.trim()}"
                {result.usage && (
                  <span className="text-muted">
                    {" "}
                    · <Figure>{result.usage.model}</Figure>
                    {result.usage.durationMs !== null && ` · ${secondsText(result.usage.durationMs)}`}
                    {result.usage.inputTokens !== null &&
                      ` · ${countText(result.usage.inputTokens)} in, ${countText(result.usage.outputTokens ?? 0)} out tokens`}
                    {result.usage.costUsd !== null && ` · ${usdText(result.usage.costUsd)}`}
                  </span>
                )}
              </span>
            ) : (
              <span className="text-negative">
                No answer ({result.status.replace("_", " ")}). {result.error}
              </span>
            )
          ) : (
            <span className="text-faint">A test asks the real model for one word and reports what it used.</span>
          )}
        </div>
        <Button onClick={test} disabled={busy}>
          {busy ? "Testing" : "Test the connection"}
        </Button>
      </div>
    </>
  );
};

const Settings = () => {
  const { system, signOut } = useConsole();
  const settings = useResource("settings", interviewApi.settings);
  const status = system.data;

  return (
    <>
      <PageHeader title="Settings" />
      <div>
        <Section
          title="New interviews"
          description="What the new-interview form starts with. Whether AI is allowed is always shown on the form and is never decided silently."
        >
          {settings.data ? (
            <Defaults settings={settings.data} onSaved={settings.setData} />
          ) : settings.error ? (
            <Failure message={settings.error} onRetry={settings.reload} />
          ) : (
            <SkeletonRows rows={3} />
          )}
        </Section>

        <Section
          title="Assistant"
          description={
            <>
              <p>The Claude Code CLI on this server that answers in rooms where AI is allowed.</p>
              <p>It is set in the server's environment, not here, so nobody using the console can point it elsewhere.</p>
            </>
          }
        >
          {status ? (
            <Assistant assistant={status.assistant} />
          ) : system.error ? (
            <Failure message={system.error} onRetry={system.reload} />
          ) : (
            <SkeletonRows rows={4} />
          )}
        </Section>

        <Section
          title="Judge"
          description="Runs are queued for a separate runner. Each one is judged in its own container with no network, a read-only file system and a memory cap."
        >
          {status ? (
            <dl className="text-body">
              <Row label="Queue">
                {status.judge.waiting === 0 ? (
                  <span className="text-positive">Empty</span>
                ) : (
                  <span className={(status.judge.oldestWaitingSeconds ?? 0) > 20 ? "text-negative" : "text-ink"}>
                    {status.judge.waiting} waiting, the oldest for {status.judge.oldestWaitingSeconds} s
                  </span>
                )}
                {(status.judge.oldestWaitingSeconds ?? 0) > 20 && (
                  <p className="mt-0.5 text-pretty text-muted">
                    Runs are not being picked up. The runner process is probably not running.
                  </p>
                )}
              </Row>
              <Row label="Last verdict">
                <span className="text-muted">
                  {status.judge.lastJudgedAt ? timeAgo(status.judge.lastJudgedAt) : "No run has been judged yet"}
                </span>
              </Row>
            </dl>
          ) : (
            <SkeletonRows rows={2} />
          )}
        </Section>

        <Section
          title="Sign-in"
          description="How interviewers and candidates prove who they are on this server."
        >
          {status ? (
            <>
              <dl className="text-body">
                <Row label="Mode">
                  {status.authMode === "demo" ? (
                    <>
                      <span className="text-warning">Local demo</span>
                      <p className="mt-0.5 text-pretty text-muted">
                        A stand-in for real sign-in, for a demonstration. One interviewer holds the access code, each
                        candidate holds an invite link, and the server answers only this machine and its tailnet. It
                        refuses to start next to Clerk credentials, so it cannot replace real sign-in on a deployment.
                      </p>
                    </>
                  ) : (
                    <>
                      Clerk
                      <p className="mt-0.5 text-pretty text-muted">
                        Interviewers are the accounts the server lists. Anyone else who signs in can only be a candidate.
                      </p>
                    </>
                  )}
                </Row>
              </dl>
              <div className="flex justify-end border-t border-rule px-5 py-3">
                <Button onClick={signOut}>Sign out</Button>
              </div>
            </>
          ) : (
            <SkeletonRows rows={1} />
          )}
        </Section>
      </div>
    </>
  );
};

export default Settings;
