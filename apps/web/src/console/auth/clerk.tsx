// The same two gates as auth/demo.tsx, for a build that signs in with Clerk.
// An interviewer is a Clerk user the API lists in INTERVIEW_OPERATOR_IDS; a
// candidate is any signed-in user who opens an invite link.

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { SignInButton, useClerk } from "@clerk/clerk-react";
import { useSession } from "../../lib/auth";
import { errorMessage, errorStatus, interviewApi } from "../api";
import { buttonClass } from "../classes";
import { FullScreenNotice } from "./screens";

const SignInPrompt = ({ detail }: { detail: string }) => (
  <FullScreenNotice title="Sign in to continue" detail={detail}>
    <SignInButton mode="modal">
      <button type="button" className={buttonClass("primary")}>
        Sign in
      </button>
    </SignInButton>
  </FullScreenNotice>
);

type Access = { state: "checking" } | { state: "allowed" } | { state: "refused"; message: string };

export const ClerkOperatorGate = ({ children }: { children: (signOut: () => void) => ReactNode }) => {
  const { isLoaded, isSignedIn, userId } = useSession();
  const { signOut } = useClerk();
  const [access, setAccess] = useState<Access>({ state: "checking" });

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    let active = true;
    setAccess({ state: "checking" });
    interviewApi
      .system()
      .then(() => active && setAccess({ state: "allowed" }))
      .catch((error) => {
        if (!active) return;
        setAccess({
          state: "refused",
          message:
            errorStatus(error) === 403
              ? "This account is not set up to run interviews. Ask whoever runs this server to add it."
              : errorMessage(error),
        });
      });
    return () => {
      active = false;
    };
  }, [isLoaded, isSignedIn, userId]);

  if (!isLoaded) return <FullScreenNotice title="Loading" />;
  if (!isSignedIn) return <SignInPrompt detail="The interview console is for interviewers." />;
  if (access.state === "checking") return <FullScreenNotice title="Checking your access" />;
  if (access.state === "refused") return <FullScreenNotice title="No access to interviews" detail={access.message} />;
  return <>{children(() => void signOut())}</>;
};

type Seat = { state: "joining" } | { state: "seated"; sessionId: string } | { state: "failed"; message: string };

export const ClerkCandidateGate = ({
  inviteCode,
  children,
}: {
  inviteCode: string;
  children: (sessionId: string) => ReactNode;
}) => {
  const { isLoaded, isSignedIn, userId } = useSession();
  const [seat, setSeat] = useState<Seat>({ state: "joining" });

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    let active = true;
    setSeat({ state: "joining" });
    interviewApi
      .join(inviteCode)
      .then(({ sessionId }) => active && setSeat({ state: "seated", sessionId }))
      .catch((error) => active && setSeat({ state: "failed", message: errorMessage(error) }));
    return () => {
      active = false;
    };
  }, [inviteCode, isLoaded, isSignedIn, userId]);

  if (!isLoaded) return <FullScreenNotice title="Loading" />;
  if (!isSignedIn) return <SignInPrompt detail="Sign in to open your interview session." />;
  if (seat.state === "joining") return <FullScreenNotice title="Opening your session" />;
  if (seat.state === "failed") return <FullScreenNotice title="This link did not open a session" detail={seat.message} />;
  return <>{children(seat.sessionId)}</>;
};
