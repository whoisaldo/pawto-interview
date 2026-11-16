import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Clock } from "./api";
import { errorMessage } from "./api";

export interface Resource<T> {
  data: T | undefined;
  error: string | null;
  /** True only until the first answer. A refresh keeps showing what it has. */
  loading: boolean;
  reload: () => Promise<void>;
  setData: (next: T) => void;
}

/**
 * Load something from the API, and optionally keep it fresh.
 *
 * `key` identifies what is being loaded: when it changes, the old data is
 * dropped. Polling pauses while the tab is hidden, and a refresh that fails
 * keeps the last good data on screen beside the error.
 */
export const useResource = <T>(key: string, load: () => Promise<T>, pollMs?: number): Resource<T> => {
  const [state, setState] = useState<{ key: string; data?: T; error: string | null; loaded: boolean }>({
    key,
    error: null,
    loaded: false,
  });
  const loadRef = useRef(load);
  loadRef.current = load;
  const current = state.key === key ? state : { key, data: undefined, error: null, loaded: false };

  const reload = useCallback(async () => {
    try {
      const data = await loadRef.current();
      setState({ key, data, error: null, loaded: true });
    } catch (error) {
      setState((previous) => ({
        key,
        data: previous.key === key ? previous.data : undefined,
        error: errorMessage(error),
        loaded: true,
      }));
    }
  }, [key]);

  useEffect(() => {
    let active = true;
    const run = () => {
      if (active && !document.hidden) void reload();
    };
    void reload();
    if (!pollMs) return () => {
      active = false;
    };
    const timer = setInterval(run, pollMs);
    document.addEventListener("visibilitychange", run);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", run);
    };
  }, [reload, pollMs]);

  const setData = useCallback((data: T) => setState({ key, data, error: null, loaded: true }), [key]);

  return { data: current.data, error: current.error, loading: !current.loaded, reload, setData };
};

/** The current time, re-read on an interval, for anything that counts. */
export const useNow = (intervalMs = 500): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
};

export interface LiveClock {
  elapsed: number;
  remaining: number;
  /** Seconds past the planned length, or 0. */
  over: number;
  fraction: number;
}

/**
 * A session's clock, counted locally between answers from the server.
 *
 * The server sends how much time was used when it answered. While the
 * session runs, this adds the time since that answer arrived, so the display
 * does not depend on this machine's clock agreeing with the server's.
 */
export const useLiveClock = (clock: Clock | undefined): LiveClock => {
  const serverNow = clock?.serverNow;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const receivedAt = useMemo(() => Date.now(), [serverNow]);
  const now = useNow(clock?.status === "running" ? 250 : 2000);
  if (!clock) return { elapsed: 0, remaining: 0, over: 0, fraction: 0 };
  const since = clock.status === "running" ? Math.max(0, (now - receivedAt) / 1000) : 0;
  const elapsed = clock.elapsedSeconds + since;
  const remaining = clock.durationSeconds - elapsed;
  return {
    elapsed,
    remaining: Math.max(0, remaining),
    over: Math.max(0, -remaining),
    fraction: Math.min(1, elapsed / clock.durationSeconds),
  };
};

/** A value kept in localStorage, for small choices that should survive a reload. */
export const useStored = <T>(key: string, initial: T): [T, (next: T) => void] => {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const store = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Private mode or a full disk: the choice just does not persist.
      }
    },
    [key],
  );
  return [value, store];
};
