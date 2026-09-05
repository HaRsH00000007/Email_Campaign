"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Shell from "@/components/Shell";
import { api, API_BASE, getToken } from "@/lib/api";

function Leads() {
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState("");
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(null);
  const pollRef = useRef(null);

  const load = useCallback(async () => {
    try {
      setRows((await api.get("/leads")).data);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    return () => clearInterval(pollRef.current);
  }, [load]);

  // The upload returns 202 and imports in the background, so progress comes
  // from polling rather than from the upload response.
  const pollImport = (id) => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const r = await api.get(`/leads/${id}/import-status`);
        setProgress(r.data);
        if (r.data.state !== "importing") {
          clearInterval(pollRef.current);
          setUploading(false);
          if (r.data.state === "failed") setErr(`Import failed: ${r.data.error}`);
          await load();
          setTimeout(() => setProgress(null), 4000);
        }
      } catch {
        clearInterval(pollRef.current);
        setUploading(false);
      }
    }, 1000);
  };

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    if (!file || !name.trim()) return;

    setUploading(true);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("name", name.trim());

    try {
      // FormData needs the browser to set its own multipart boundary, so this
      // one call bypasses the JSON helper.
      const res = await fetch(`${API_BASE}/leads/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${getToken()}` },
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Upload failed");

      setProgress({ state: "importing", inserted: 0, total: data.data.total, percent: 0 });
      pollImport(data.data._id);
      setName("");
      setFile(null);
      e.target.reset();
    } catch (e2) {
      setErr(e2.message);
      setUploading(false);
    }
  };

  const remove = async (row) => {
    if (!confirm(`Delete "${row.name}" and its ${row.leadCount} leads?`)) return;
    try {
      await api.del(`/leads/${row._id}`);
      await load();
    } catch (e) {
      setErr(e.message);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Lead lists</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Upload a CSV or Excel file. Every column becomes a{" "}
            <code className="mono">{"{{variable}}"}</code> you can use in templates.
          </p>
        </div>
      </div>

      {err && <div className="banner error">{err}</div>}

      <div className="card">
        <h2>Upload a list</h2>
        <form onSubmit={submit}>
          <div className="row">
            <div>
              <label htmlFor="lname">List name</label>
              <input
                id="lname"
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Q1 SaaS founders"
              />
            </div>
            <div>
              <label htmlFor="lfile">File</label>
              <input
                id="lfile"
                type="file"
                required
                accept=".csv,.xlsx,.xls"
                onChange={(e) => setFile(e.target.files[0])}
              />
            </div>
            <div style={{ flex: "0 0 auto", minWidth: 0 }}>
              <button className="primary" type="submit" disabled={uploading}>
                {uploading ? "Importing..." : "Upload"}
              </button>
            </div>
          </div>
          <div className="tiny muted">
            The file must have an <strong>email</strong> column. Rows with a missing or
            invalid address, and addresses repeated within the file, are skipped.
          </div>
        </form>

        {progress && (
          <div style={{ marginTop: 14 }}>
            <div className="small" style={{ marginBottom: 5 }}>
              {progress.state === "done"
                ? `Imported ${progress.total} leads${progress.skipped ? ` (${progress.skipped} skipped)` : ""}.`
                : progress.state === "failed"
                  ? `Failed: ${progress.error}`
                  : `Importing ${progress.inserted} / ${progress.total}...`}
            </div>
            <div className="progress">
              <div style={{ width: `${progress.percent || 0}%` }} />
            </div>
          </div>
        )}
      </div>

      {loading ? (
        <div className="card empty">Loading...</div>
      ) : !rows.length ? (
        <div className="card empty">No lead lists yet.</div>
      ) : (
        <div className="card pad0">
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="num">Leads</th>
                  <th>Columns</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l._id}>
                    <td>
                      <strong>{l.name}</strong>
                    </td>
                    <td className="num">{l.leadCount.toLocaleString()}</td>
                    <td className="tiny mono muted">{(l.columns || []).join(", ")}</td>
                    <td>
                      {l.importState === "done" ? (
                        <span className="pill ok">ready</span>
                      ) : l.importState === "importing" ? (
                        <span className="pill warn">importing</span>
                      ) : (
                        <span className="pill danger">failed</span>
                      )}
                    </td>
                    <td>
                      <button className="sm danger" onClick={() => remove(l)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Shell>
      <Leads />
    </Shell>
  );
}
