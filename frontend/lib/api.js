// API client. Plain fetch -- no axios dependency for a handful of calls.
//
// The token lives in localStorage. That is appropriate for a self-hosted
// internal tool and NOT appropriate for a public multi-tenant product, where it
// should be an httpOnly cookie. Noted here rather than left as a silent choice.

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE || "http://localhost:4000/api/v1";

const TOKEN_KEY = "ec_token";

export const getToken = () =>
  typeof window === "undefined" ? null : localStorage.getItem(TOKEN_KEY);

export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const request = async (method, path, body, opts = {}) => {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let payload = body;
  if (body && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${API_BASE}${path}`, { method, headers, body: payload });

  if (res.status === 401 && typeof window !== "undefined" && !opts.noRedirect) {
    clearToken();
    window.location.href = "/login";
    throw new ApiError("Session expired", 401);
  }

  if (opts.raw) return res;

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }

  if (!res.ok) throw new ApiError(data?.message || `Request failed (${res.status})`, res.status);
  return data;
};

export const api = {
  get: (p, o) => request("GET", p, null, o),
  post: (p, b, o) => request("POST", p, b, o),
  patch: (p, b, o) => request("PATCH", p, b, o),
  del: (p, o) => request("DELETE", p, null, o),
};

// Download a file (the activity export) without navigating away from the page,
// carrying the auth header a plain <a href> could not.
export const download = async (path, filename) => {
  const res = await request("GET", path, null, { raw: true });
  if (!res.ok) throw new ApiError("Export failed", res.status);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

export { ApiError };
