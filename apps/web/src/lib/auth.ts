import { useAuth } from "@clerk/clerk-react";
import { createContext, useContext, useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { createElement } from "react";

// The axios instance in lib/api.ts is module scope and has no hooks available,
// so whoever holds the signed-in session publishes a token getter here. With
// Clerk that is the bridge below; in demo mode it is the gate that signed the
// person in.
let tokenGetter: (() => Promise<string | null>) | null = null;
let unauthorizedHandler: (() => void) | null = null;

export const getSessionToken = async (): Promise<string | null> =>
  tokenGetter ? tokenGetter() : null;

export const setTokenSource = (getter: (() => Promise<string | null>) | null) => {
  tokenGetter = getter;
};

/** Called when the API refuses the current token, so its holder can sign in again. */
export const setUnauthorizedHandler = (handler: (() => void) | null) => {
  unauthorizedHandler = handler;
};

export const reportUnauthorized = () => unauthorizedHandler?.();

/** Who is signed in, however they signed in. */
export interface Session {
  isLoaded: boolean;
  isSignedIn: boolean;
  userId: string | null;
  // Changes when a different session takes over the tab.
  sessionId: string | null;
  getToken: () => Promise<string | null>;
}

const SIGNED_OUT: Session = {
  isLoaded: true,
  isSignedIn: false,
  userId: null,
  sessionId: null,
  getToken: async () => null,
};

export const SessionContext = createContext<Session>(SIGNED_OUT);

/** The current session. Works the same under Clerk and in demo mode. */
export const useSession = () => useContext(SessionContext);

/** Publishes Clerk's session to the rest of the app. Must be inside ClerkProvider. */
export const ClerkSessionProvider = ({ children }: { children: ReactNode }) => {
  const { getToken, isLoaded, isSignedIn, userId, sessionId } = useAuth();

  useEffect(() => {
    tokenGetter = getToken;
    return () => {
      tokenGetter = null;
    };
  }, [getToken]);

  const session = useMemo<Session>(
    () => ({
      isLoaded,
      isSignedIn: Boolean(isSignedIn),
      userId: userId ?? null,
      sessionId: sessionId ?? null,
      getToken,
    }),
    [getToken, isLoaded, isSignedIn, userId, sessionId],
  );

  return createElement(SessionContext.Provider, { value: session }, children);
};
