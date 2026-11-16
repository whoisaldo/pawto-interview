// What every console page shares: the session list and the system status,
// loaded once by the shell and read from here.

import { createContext, useContext } from "react";
import type { SessionSummary, SystemStatus } from "./api";
import type { Resource } from "./hooks";

interface Console {
  sessions: Resource<SessionSummary[]>;
  system: Resource<SystemStatus>;
  signOut: () => void;
}

export const ConsoleContext = createContext<Console | null>(null);

/** The session list and system status every console page shares, loaded once. */
export const useConsole = (): Console => {
  const value = useContext(ConsoleContext);
  if (!value) throw new Error("useConsole must be used inside the console shell");
  return value;
};

/** Ended sessions nobody has written up yet. The one queue the console has. */
export const needsEvaluation = (session: SessionSummary) => session.status === "ended" && !session.evaluation;
