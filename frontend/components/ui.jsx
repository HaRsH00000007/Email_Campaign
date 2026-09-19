"use client";

// Shared UI primitives. One module because they are small and always imported
// together; splitting them across a dozen files would buy nothing here.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Alert, CheckCircle, Info, X } from "@/components/icons";

/* --- Button -------------------------------------------------------------- */

export function Button({
  variant = "",
  size = "",
  loading = false,
  icon: Icon,
  className = "",
  children,
  disabled,
  ...rest
}) {
  return (
    <button
      type="button"
      className={`btn ${variant} ${size} ${className}`.trim()}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <span className="spinner" /> : Icon ? <Icon size={size === "sm" ? 14 : 16} /> : null}
      {children}
    </button>
  );
}

export function IconButton({ icon: Icon, label, size = 18, className = "", ...rest }) {
  return (
    <button type="button" className={`iconbtn ${className}`.trim()} aria-label={label} title={label} {...rest}>
      <Icon size={size} />
    </button>
  );
}

/* --- Surfaces ------------------------------------------------------------ */

export function Card({ className = "", children, ...rest }) {
  return (
    <div className={`card ${className}`.trim()} {...rest}>
      {children}
    </div>
  );
}

export function SectionTitle({ icon: Icon, title, hint, right }) {
  return (
    <div className="card-head" style={{ padding: 0, border: "none", marginBottom: hint ? 14 : 12 }}>
      <div className="section-title">
        {Icon && (
          <span className="ico">
            <Icon size={15} />
          </span>
        )}
        <div>
          <h2>{title}</h2>
          {hint && <div className="hint" style={{ marginTop: 1 }}>{hint}</div>}
        </div>
      </div>
      {right}
    </div>
  );
}

/* --- Feedback ------------------------------------------------------------ */

const BANNER_ICON = { error: Alert, ok: CheckCircle, warn: Alert, info: Info };

export function Banner({ kind = "info", children, onClose }) {
  const Icon = BANNER_ICON[kind] || Info;
  return (
    <div className={`banner ${kind === "info" ? "" : kind}`.trim()} role={kind === "error" ? "alert" : "status"}>
      <Icon size={17} />
      <div className="grow">{children}</div>
      {onClose && <IconButton icon={X} label="Dismiss" size={15} onClick={onClose} />}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, children, action }) {
  return (
    <div className="empty">
      {Icon && (
        <span className="art">
          <Icon size={24} />
        </span>
      )}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}

export function Skeleton({ h = 14, w = "100%", r, style }) {
  return <div className="skel" style={{ height: h, width: w, borderRadius: r, ...style }} />;
}

export function TableSkeleton({ rows = 5, cols = 4 }) {
  return (
    <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ display: "flex", gap: 14, alignItems: "center" }}>
          {Array.from({ length: cols }).map((_, j) => (
            <Skeleton key={j} h={13} w={j === 0 ? "26%" : `${Math.round(60 / cols)}%`} />
          ))}
        </div>
      ))}
    </div>
  );
}

// `dot` is opt-out: a badge that already carries its own glyph does not want a
// status dot next to it.
export function Badge({ kind = "", live = false, dot = true, children }) {
  return (
    <span className={`badge ${kind} ${live ? "live" : ""}`.trim()}>
      {dot && (kind || live) && <span className="dot" />}
      {children}
    </span>
  );
}

export function Progress({ percent = 0, done = false }) {
  return (
    <div className={`progress ${done ? "done" : ""}`.trim()}>
      <i style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
    </div>
  );
}

export function Meter({ percent = 0, kind = "" }) {
  return (
    <div className={`meter ${kind}`.trim()}>
      <i style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
    </div>
  );
}

export function Ring({ percent = 0, size = 54, color }) {
  const p = Math.max(0, Math.min(100, percent));
  return (
    <div className="ring" style={{ "--p": p, "--sz": `${size}px`, "--ring-c": color }}>
      <span>{Math.round(p)}%</span>
    </div>
  );
}

/* --- Animated number ----------------------------------------------------- */

// Counts from the previous value to the new one with rAF. Only used on the
// handful of headline numbers -- everything else renders the value directly.
export function CountUp({ value = 0, duration = 650, format = (n) => n.toLocaleString() }) {
  const [shown, setShown] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    const to = Number(value) || 0;
    if (from === to) return;

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      fromRef.current = to;
      setShown(to);
      return;
    }

    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(from + (to - from) * eased);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = to;
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value, duration]);

  return <>{format(Math.round(shown))}</>;
}

export function Stat({ label, value, unit, foot, icon: Icon, accent = false, animate = true }) {
  return (
    <div className={`stat ${accent ? "accent" : ""}`.trim()}>
      <div className="k">
        {Icon && <Icon size={13} />}
        {label}
      </div>
      <div className="v">
        {animate && typeof value === "number" ? <CountUp value={value} /> : value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      {foot && <div className="foot">{foot}</div>}
    </div>
  );
}

/* --- Overlays ------------------------------------------------------------ */

function useLockedBody(active) {
  useEffect(() => {
    if (!active) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [active]);
}

function useEscape(active, onEscape) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e) => e.key === "Escape" && onEscape?.();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onEscape]);
}

function Portal({ children }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? createPortal(children, document.body) : null;
}

export function Drawer({ open, onClose, title, subtitle, children }) {
  useLockedBody(open);
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <Portal>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <div className="d-head">
          <div style={{ minWidth: 0, flex: "1 1 auto" }}>
            <div className="mono strong truncate" style={{ fontSize: 14 }}>
              {title}
            </div>
            {subtitle && <div className="tiny faint truncate">{subtitle}</div>}
          </div>
          <IconButton icon={X} label="Close" onClick={onClose} />
        </div>
        <div className="d-body">{children}</div>
      </aside>
    </Portal>
  );
}

// Replaces window.confirm -- a native dialog in a product like this looks
// unfinished, and it cannot carry the destructive styling.
export function ConfirmDialog({ open, title, body, confirmLabel = "Confirm", danger = true, busy, onConfirm, onCancel }) {
  useLockedBody(open);
  useEscape(open, onCancel);
  if (!open) return null;
  return (
    <Portal>
      <div className="scrim" onClick={onCancel} />
      <div className="modal" role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="m-body">
          {danger && (
            <div className="m-icon">
              <Alert size={20} />
            </div>
          )}
          <h2 style={{ fontSize: 17, marginBottom: 7 }}>{title}</h2>
          <div className="muted small">{body}</div>
        </div>
        <div className="m-foot">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant={danger ? "solid-danger" : "primary"} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Portal>
  );
}

/* --- Toasts -------------------------------------------------------------- */

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

const TOAST_ICON = { ok: CheckCircle, error: Alert, info: Info };

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setItems((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    const t = setTimeout(() => setItems((list) => list.filter((x) => x.id !== id)), 200);
    timers.current.set(`${id}-out`, t);
  }, []);

  const push = useCallback(
    (message, kind = "ok", ttl = 4200) => {
      const id = Math.random().toString(36).slice(2);
      setItems((list) => [...list.slice(-3), { id, message, kind }]);
      timers.current.set(id, setTimeout(() => dismiss(id), ttl));
      return id;
    },
    [dismiss]
  );

  useEffect(() => {
    const map = timers.current;
    return () => map.forEach(clearTimeout);
  }, []);

  const api = useMemo(() => {
    const fn = (m, k, ttl) => push(m, k, ttl);
    fn.ok = (m) => push(m, "ok");
    fn.error = (m) => push(m, "error", 6500);
    fn.info = (m) => push(m, "info");
    return fn;
  }, [push]);

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="toaster" aria-live="polite">
        {items.map((t) => {
          const Icon = TOAST_ICON[t.kind] || Info;
          return (
            <div key={t.id} className={`toast ${t.kind} ${t.leaving ? "leaving" : ""}`.trim()}>
              <Icon size={17} />
              <div className="grow">{t.message}</div>
              <IconButton icon={X} label="Dismiss" size={14} onClick={() => dismiss(t.id)} />
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

/* --- Form helpers -------------------------------------------------------- */

export function Field({ label, hint, htmlFor, children, className = "" }) {
  return (
    <div className={`field ${className}`.trim()}>
      {label && <label htmlFor={htmlFor}>{label}</label>}
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function CheckRow({ checked, onChange, title, children }) {
  return (
    <label className={`check ${checked ? "on" : ""}`.trim()}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span style={{ minWidth: 0 }}>
        <span className="ctitle">{title}</span>
        {children && <div className="tiny muted" style={{ marginTop: 3 }}>{children}</div>}
      </span>
    </label>
  );
}

export function Switch({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      onClick={() => onChange(!checked)}
    />
  );
}

/* --- Stepper ------------------------------------------------------------- */

export function Stepper({ steps, current, onJump }) {
  return (
    <div className="stepper" role="list">
      {steps.map((label, i) => (
        <div key={label} style={{ display: "contents" }}>
          {i > 0 && (
            <div className={`step-line ${i <= current ? "filled" : ""}`.trim()}>
              <i />
            </div>
          )}
          <button
            type="button"
            role="listitem"
            className={`step ${i === current ? "on" : i < current ? "done" : ""} ${
              onJump && i < current ? "clickable" : ""
            }`.trim()}
            onClick={() => onJump && i < current && onJump(i)}
            disabled={!onJump || i >= current}
          >
            <span className="n">{i < current ? <CheckMark /> : i + 1}</span>
            <span className="hide-sm">{label}</span>
          </button>
        </div>
      ))}
    </div>
  );
}

const CheckMark = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);
