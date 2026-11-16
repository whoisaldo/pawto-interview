// Sign-in for a local demonstration, when the build says VITE_AUTH_MODE=demo.
// The interviewer types an access code; a candidate's invite link is their
// way in. Both exchange it for a short-lived token from the API's /demo
// routes, which exist only while the API runs in demo mode.

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { UserContext } from "../../hooks/useUser";
import type { BackendUser } from "../../hooks/useUser";
import { SessionContext, setTokenSource, setUnauthorizedHandler } from "../../lib/auth";
import type { Session } from "../../lib/auth";
import { BACKEND_ORIGIN } from "../../lib/config";
import { Button, Field, Note, inputClass } from "../ui";
import { Brand, FullScreenNotice } from "./screens";

interface Stored {
  token: string;
  expiresAt: string;
  user: BackendUser;
  sessionId?: string;
}

const OPERATOR_KEY = "tandemcode.demo.operator";
const candidateKey = (inviteCode: string) => `tandemcode.demo.candidate.${inviteCode}`;

const read = (key: string): Stored | null => {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? "null") as Stored | null;
    // A minute of slack, so a token is not used in its last seconds.
    if (stored && Date.parse(stored.expiresAt) - Date.now() > 60_000) return stored;
  } catch {
    // Unreadable is the same as absent.
  }
  return null;
};

const write = (key: string, stored: Stored | null) => {
  try {
    if (stored) localStorage.setItem(key, JSON.stringify(stored));
    else localStorage.removeItem(key);
  } catch {
    // Without storage the session lasts until the tab reloads.
  }
};

const exchange = async (path: string, body: object): Promise<Stored> => {
  let response: Response;
  try {
    response = await fetch(`${BACKEND_ORIGIN}/demo/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Could not reach the server.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : response.status === 404
          ? "This server is not running in demo mode."
          : "Sign-in failed.",
    );
  }
  return data as Stored;
};

/** Publishes a demo token as the tab's session, before any child asks the API for anything. */
const DemoSession = ({ stored, onExpired, children }: { stored: Stored; onExpired: () => void; children: ReactNode }) => {
  const session = useMemo<Session>(
    () => ({
      isLoaded: true,
      isSignedIn: true,
      userId: stored.user.id,
      sessionId: stored.token.slice(-16),
      getToken: async () => stored.token,
    }),
    [stored],
  );

  // Layout effects run before any child's effect, so the first request a
  // page makes already has its token.
  useLayoutEffect(() => {
    setTokenSource(session.getToken);
    setUnauthorizedHandler(onExpired);
    return () => {
      setTokenSource(null);
      setUnauthorizedHandler(null);
    };
  }, [session, onExpired]);

  return (
    <SessionContext.Provider value={session}>
      <UserContext.Provider value={stored.user}>{children}</UserContext.Provider>
    </SessionContext.Provider>
  );
};

const OperatorSignIn = ({ expired, onSignedIn }: { expired: boolean; onSignedIn: (stored: Stored) => void }) => {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await exchange("operator-session", { accessCode: code }));
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className="console flex min-h-dvh items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-md border border-line bg-surface p-6">
        <Brand />
        <h1 className="mt-6 text-xl font-semibold text-balance text-ink">Interviewer sign-in</h1>
        <p className="mt-1.5 text-body text-pretty text-muted">
          This is a local demo. It runs on one machine for its tailnet, with a stand-in for real sign-in.
        </p>
        <Field
          label="Access code"
          htmlFor="access-code"
          className="mt-5"
          error={error}
          hint={expired ? "Your session ended. Sign in again to continue." : undefined}
        >
          <input
            id="access-code"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            value={code}
            onChange={(event) => setCode(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Button type="submit" variant="primary" className="mt-5 w-full" disabled={busy || !code}>
          {busy ? "Signing in" : "Sign in"}
        </Button>
        <Note className="mt-4">Candidates do not sign in here. They open the invite link for their session.</Note>
      </form>
    </main>
  );
};

/** Everything inside is the interviewer's, behind the access code. */
export const DemoOperatorGate = ({ children }: { children: (signOut: () => void) => ReactNode }) => {
  const [stored, setStored] = useState<Stored | null>(() => read(OPERATOR_KEY));
  const [expired, setExpired] = useState(false);

  const signOut = useCallback(() => {
    write(OPERATOR_KEY, null);
    setStored(null);
  }, []);
  const onExpired = useCallback(() => {
    setExpired(true);
    signOut();
  }, [signOut]);

  if (!stored) {
    return (
      <OperatorSignIn
        expired={expired}
        onSignedIn={(next) => {
          write(OPERATOR_KEY, next);
          setExpired(false);
          setStored(next);
        }}
      />
    );
  }
  return (
    <DemoSession stored={stored} onExpired={onExpired}>
      {children(signOut)}
    </DemoSession>
  );
};

type Seat = { state: "joining" } | { state: "seated"; stored: Stored } | { state: "failed"; message: string };

/** The candidate's side. The invite code in the link is the whole credential. */
export const DemoCandidateGate = ({
  inviteCode,
  children,
}: {
  inviteCode: string;
  children: (sessionId: string) => ReactNode;
}) => {
  const [seat, setSeat] = useState<Seat>({ state: "joining" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const cached = attempt === 0 ? read(candidateKey(inviteCode)) : null;
    if (cached?.sessionId) {
      setSeat({ state: "seated", stored: cached });
      return;
    }
    setSeat({ state: "joining" });
    exchange("candidate-session", { inviteCode })
      .then((stored) => {
        if (!active) return;
        write(candidateKey(inviteCode), stored);
        setSeat({ state: "seated", stored });
      })
      .catch((failure: Error) => {
        if (active) setSeat({ state: "failed", message: failure.message });
      });
    return () => {
      active = false;
    };
  }, [inviteCode, attempt]);

  // A refused token is redeemed again once. If that fails too, say so.
  const onExpired = useCallback(() => {
    write(candidateKey(inviteCode), null);
    setAttempt((count) => count + 1);
  }, [inviteCode]);

  if (seat.state === "joining") return <FullScreenNotice title="Opening your session" />;
  if (seat.state === "failed") {
    return (
      <FullScreenNotice title="This link did not open a session" detail={seat.message}>
        <Button onClick={() => setAttempt((count) => count + 1)}>Try again</Button>
      </FullScreenNotice>
    );
  }
  return (
    <DemoSession stored={seat.stored} onExpired={onExpired}>
      {children(seat.stored.sessionId!)}
    </DemoSession>
  );
};
