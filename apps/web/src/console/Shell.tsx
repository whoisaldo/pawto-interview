import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  CalendarDays,
  ClipboardCheck,
  Gauge,
  History,
  Library,
  LogOut,
  Menu,
  Settings as SettingsIcon,
  X,
} from "lucide-react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { useUser } from "../hooks/useUser";
import { AUTH_MODE } from "../lib/config";
import { interviewApi } from "./api";
import type { SystemStatus } from "./api";
import { Brand } from "./auth/screens";
import { useResource } from "./hooks";
import type { Resource } from "./hooks";
import { ConsoleContext, needsEvaluation } from "./context";
import { cn } from "./classes";
import {
  Count,
  IconButton,
} from "./ui";

const NAV = [
  { to: "/console", label: "Overview", icon: Gauge, end: true },
  { to: "/console/interviews", label: "Interviews", icon: CalendarDays },
  { to: "/console/problems", label: "Problem library", icon: Library },
  { to: "/console/sessions", label: "Sessions", icon: History },
  { to: "/console/evaluations", label: "Evaluations", icon: ClipboardCheck },
];

const NavItem = ({
  to,
  label,
  icon: Icon,
  end,
  count,
  onNavigate,
}: {
  to: string;
  label: string;
  icon: typeof Gauge;
  end?: boolean;
  count?: number;
  onNavigate?: () => void;
}) => (
  <NavLink
    to={to}
    end={end}
    onClick={onNavigate}
    className={({ isActive }) =>
      cn(
        "group flex h-8.5 items-center gap-2.5 rounded-sm px-3 text-sm",
        isActive ? "bg-raised font-medium text-ink" : "text-muted hover:bg-raised hover:text-ink",
      )
    }
  >
    <>
        <Icon className="size-4 flex-none" strokeWidth={1.5} aria-hidden />
        <span>{label}</span>
        {count ? (
          <span className="ml-auto">
            <Count>{count}</Count>
            <span className="sr-only"> to write</span>
          </span>
        ) : null}
    </>
  </NavLink>
);

const Navigation = ({ toWrite, onNavigate }: { toWrite: number; onNavigate?: () => void }) => (
  <nav aria-label="Console" className="flex flex-1 flex-col gap-0.5 px-2 py-3">
    {NAV.map((item) => (
      <NavItem
        key={item.to}
        {...item}
        count={item.label === "Evaluations" ? toWrite : undefined}
        onNavigate={onNavigate}
      />
    ))}
    <div className="mt-auto">
      <NavItem to="/console/settings" label="Settings" icon={SettingsIcon} onNavigate={onNavigate} />
    </div>
  </nav>
);

const Dot = ({ tone }: { tone: "positive" | "warning" | "negative" | "faint" }) => (
  <span
    aria-hidden
    className={cn(
      "size-1.5 flex-none rounded-full",
      { positive: "bg-positive", warning: "bg-warning", negative: "bg-negative", faint: "bg-faint" }[tone],
    )}
  />
);

/** Whether the two things a live session leans on are up, in a few words each. */
const Readiness = ({ system }: { system: Resource<SystemStatus> }) => {
  const status = system.data;
  if (!status) {
    return <span className="text-xs text-faint">{system.error ? "Status unavailable" : "Checking status"}</span>;
  }
  const stuck = status.judge.waiting > 0 && (status.judge.oldestWaitingSeconds ?? 0) > 20;
  const assistant = status.assistant;
  return (
    <Link
      to="/console/settings"
      className="flex flex-col gap-2 rounded-sm text-xs text-muted hover:text-ink"
      title="Open settings for details"
    >
      <span className="flex items-center gap-1.5">
        <Dot tone={stuck ? "negative" : "positive"} />
        {stuck ? `Judge not answering, ${status.judge.waiting} waiting` : "Judge ready"}
      </span>
      <span className="flex items-center gap-1.5">
        <Dot tone={assistant.ready ? "positive" : assistant.problem ? "negative" : "faint"} />
        {assistant.ready
          ? "Codex ready"
          : assistant.problem
            ? "Codex unavailable"
            : "Codex not configured"}
      </span>
    </Link>
  );
};

export const Shell = ({ signOut }: { signOut: () => void }) => {
  const user = useUser();
  const sessions = useResource("sessions", interviewApi.list, 5000);
  const system = useResource("system", interviewApi.system, 15000);
  const [menuOpen, setMenuOpen] = useState(false);
  const toWrite = sessions.data?.filter(needsEvaluation).length ?? 0;

  return (
    <ConsoleContext.Provider value={{ sessions, system, signOut }}>
      <div className="console grid min-h-dvh grid-cols-[minmax(0,1fr)] lg:grid-cols-[15rem_minmax(0,1fr)]">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-sm focus:bg-ink focus:px-3 focus:py-1.5 focus:text-body focus:text-ground"
        >
          Skip to content
        </a>

        <aside className="sticky top-0 hidden h-dvh flex-col border-r border-line lg:flex">
          <Link to="/console" className="flex h-14 flex-none items-center border-b border-line px-5" aria-label="PawtoInterview overview">
            <Brand />
          </Link>
          <Navigation toWrite={toWrite} />
          <div className="border-t border-line px-5 py-3"><Readiness system={system} /></div>
          <div className="flex items-center gap-2 border-t border-line px-3 py-2.5">
            <div className="min-w-0 flex-1 px-2">
              <p className="truncate text-body text-ink">{user?.name ?? "Interviewer"}</p>
              <p className="truncate text-xs text-faint">
                {AUTH_MODE === "demo" ? "Local demo sign-in" : user?.email}
              </p>
            </div>
            <IconButton label="Sign out" onClick={signOut}>
              <LogOut className="size-4" strokeWidth={1.5} aria-hidden />
            </IconButton>
          </div>
        </aside>

        <div className="flex min-w-0 flex-col">
          <header className="sticky top-0 z-10 flex h-12 flex-none items-center gap-3 border-b border-line bg-ground px-3 lg:hidden">
            <Dialog.Root open={menuOpen} onOpenChange={setMenuOpen}>
              <Dialog.Trigger
                aria-label="Open navigation"
                className="inline-flex size-8 flex-none items-center justify-center rounded-full text-muted hover:bg-raised hover:text-ink lg:hidden"
              >
                <Menu className="size-4" aria-hidden />
              </Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/60" />
                <Dialog.Popup className="console fixed inset-y-0 left-0 z-50 flex w-64 max-w-[85vw] flex-col border-r border-line">
                  <div className="flex h-14 flex-none items-center justify-between border-b border-line px-4">
                    <Dialog.Title className="sr-only">Navigation</Dialog.Title>
                    <Brand />
                    <Dialog.Close
                      aria-label="Close navigation"
                      className="inline-flex size-8 items-center justify-center rounded-full text-muted hover:bg-raised hover:text-ink"
                    >
                      <X className="size-4" aria-hidden />
                    </Dialog.Close>
                  </div>
                  <Navigation toWrite={toWrite} onNavigate={() => setMenuOpen(false)} />
                  <button
                    type="button"
                    onClick={signOut}
                    className="flex h-11 items-center gap-2.5 border-t border-line px-5 text-sm text-muted hover:text-ink"
                  >
                    <LogOut className="size-4" strokeWidth={1.5} aria-hidden />
                    Sign out
                  </button>
                </Dialog.Popup>
              </Dialog.Portal>
            </Dialog.Root>

            <Brand />
          </header>

          <main id="main" className="mx-auto w-full max-w-[88rem] flex-1 px-4 py-7 lg:px-8 lg:py-8">
            <Outlet />
          </main>
        </div>
      </div>
    </ConsoleContext.Provider>
  );
};
