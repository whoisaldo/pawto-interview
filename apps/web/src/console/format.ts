// How figures are written on the interview screens, in one place so a clock
// in a table and the same clock in a header cannot disagree.

/** 402 -> "6:42". Used for clocks, so it never rounds up. */
export const clockText = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
};

/** 420 -> "7 min", 5400 -> "1 h 30 min". Used for lengths people chose. */
export const durationText = (seconds: number): string => {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${rest} min`;
};

export const bytesText = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

export const countText = (value: number): string => value.toLocaleString("en-US");

/** Assistant cost. Small on purpose: a question costs cents, and four places show which. */
export const usdText = (value: number): string => `$${value.toFixed(value < 0.1 ? 4 : 2)}`;

export const secondsText = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

export const timeAgo = (iso: string): string => {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)} min ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
};

export const timeOfDay = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export const dayAndTime = (iso: string): string =>
  new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export const STATUS_WORDS: Record<string, string> = {
  scheduled: "Scheduled",
  running: "Running",
  paused: "Paused",
  ended: "Ended",
};

/** A judge verdict in words a person would say. */
export const verdictText = (status: string | null | undefined): string => {
  switch (status) {
    case "passed":
      return "All passed";
    case "accepted":
      return "All passed";
    case "wrong_answer":
      return "Wrong answer";
    case "runtime_error":
      return "Runtime error";
    case "time_limit_exceeded":
      return "Time limit exceeded";
    case "pending":
      return "Queued";
    case "running":
      return "Running";
    default:
      return "Not judged";
  }
};

/** Copy text, including on a plain-http page, where the clipboard API is absent. */
export const copyText = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the selection-based copy.
  }
  const holder = document.createElement("textarea");
  holder.value = text;
  holder.setAttribute("readonly", "");
  holder.style.position = "fixed";
  holder.style.opacity = "0";
  document.body.appendChild(holder);
  holder.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  document.body.removeChild(holder);
  return copied;
};

/** Save text the server produced as a file, without leaving the page. */
export const downloadText = (filename: string, text: string, type: string) => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

/** Where the candidate goes. Built from this page's own origin. */
export const inviteUrl = (inviteCode: string) => `${window.location.origin}/c/${inviteCode}`;
