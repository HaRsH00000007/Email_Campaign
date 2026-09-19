"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* Polling that pauses while the tab is hidden.
 *
 * The old code set a bare setInterval, so a tab left open overnight kept
 * hammering the API for a screen nobody was looking at. This refetches
 * immediately on return to the tab and otherwise stays quiet. */
export function usePoll(fn, ms = 15000, deps = []) {
  const saved = useRef(fn);
  saved.current = fn;

  useEffect(() => {
    if (!ms) return;
    let timer = null;

    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      stop();
      timer = setInterval(() => saved.current(), ms);
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else {
        saved.current();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps]);
}

/* Theme: light / dark / system, persisted. The initial value is read from the
 * DOM attribute the boot script already set, so there is no second paint. */
const KEY = "ec_theme";

export function useTheme() {
  const [theme, setThemeState] = useState("system");

  useEffect(() => {
    setThemeState(localStorage.getItem(KEY) || "system");
  }, []);

  const apply = useCallback((next) => {
    const resolved =
      next === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : next;
    document.documentElement.dataset.theme = resolved;
    localStorage.setItem(KEY, next);
    setThemeState(next);
  }, []);

  // Follow the OS while the user has not pinned a preference.
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      document.documentElement.dataset.theme = mq.matches ? "dark" : "light";
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const resolved =
    typeof document !== "undefined" ? document.documentElement.dataset.theme : "light";

  return { theme, resolved, setTheme: apply };
}

/* Media query as a hook, SSR-safe. */
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    setMatches(mq.matches);
    const onChange = (e) => setMatches(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/* Small async-action helper: keeps the busy flag, surfaces the error. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, { onError } = {}) => {
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      onError?.(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return [busy, run];
}
