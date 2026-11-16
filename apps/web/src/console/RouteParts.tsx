// The components the interview routes render. The route table itself is in
// routes.tsx.

import type { ComponentType, ReactNode } from "react";
import { Outlet, useOutletContext, useParams } from "react-router-dom";
import { Shell } from "./Shell";
import { RoomScreen } from "./room/Room";

export type OperatorGate = ComponentType<{ children: (signOut: () => void) => ReactNode }>;
export type CandidateGate = ComponentType<{ inviteCode: string; children: (sessionId: string) => ReactNode }>;

/** One gate for every interviewer route, so moving between them does not sign in again. */
export const OperatorArea = ({ Gate }: { Gate: OperatorGate }) => <Gate>{(signOut) => <Outlet context={signOut} />}</Gate>;

export const Console = () => <Shell signOut={useOutletContext<() => void>()} />;

export const InterviewerRoom = () => {
  const { id = "" } = useParams();
  return <RoomScreen sessionId={id} exit={{ to: `/console/interviews/${id}`, label: "Console" }} />;
};

export const CandidateRoom = ({ Gate }: { Gate: CandidateGate }) => {
  const { inviteCode = "" } = useParams();
  return <Gate inviteCode={inviteCode}>{(sessionId) => <RoomScreen sessionId={sessionId} />}</Gate>;
};
