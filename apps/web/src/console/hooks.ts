import { useCallback, useEffect, useRef, useState } from "react";
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
