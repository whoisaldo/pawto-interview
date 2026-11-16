// The interview screens' routes. Which gate stands in front of them depends
// on how this build signs people in, so the caller passes the gates in.

import type { RouteObject } from "react-router-dom";
import { CandidateRoom, Console, InterviewerRoom, OperatorArea } from "./RouteParts";
import type { CandidateGate, OperatorGate } from "./RouteParts";
import EvaluationPage from "./pages/EvaluationPage";
import Evaluations from "./pages/Evaluations";
import InterviewDetail from "./pages/InterviewDetail";
import InterviewNew from "./pages/InterviewNew";
import Interviews from "./pages/Interviews";
import Overview from "./pages/Overview";
import Problems from "./pages/Problems";
import Sessions from "./pages/Sessions";
import Settings from "./pages/Settings";

export const interviewRoutes = (gates: { Operator: OperatorGate; Candidate: CandidateGate }): RouteObject[] => [
  {
    element: <OperatorArea Gate={gates.Operator} />,
    children: [
      {
        path: "/console",
        element: <Console />,
        children: [
          { index: true, element: <Overview /> },
          { path: "interviews", element: <Interviews /> },
          { path: "interviews/new", element: <InterviewNew /> },
          { path: "interviews/:id", element: <InterviewDetail /> },
          { path: "problems", element: <Problems /> },
          { path: "sessions", element: <Sessions /> },
          { path: "evaluations", element: <Evaluations /> },
          { path: "evaluations/:id", element: <EvaluationPage /> },
          { path: "settings", element: <Settings /> },
        ],
      },
      { path: "/console/interviews/:id/room", element: <InterviewerRoom /> },
    ],
  },
  { path: "/c/:inviteCode", element: <CandidateRoom Gate={gates.Candidate} /> },
];
