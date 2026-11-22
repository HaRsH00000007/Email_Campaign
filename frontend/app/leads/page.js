"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Shell from "@/components/Shell";
import { api, API_BASE, getToken } from "@/lib/api";
import {
  Badge,
  Banner,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  Progress,
  SectionTitle,
  Stat,
  TableSkeleton,
  useToast,
} from "@/components/ui";
import { File, Search, Trash, Upload, Users } from "@/components/icons";

function Leads() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");

  const [name, setName] = useState("");
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [toDelete, setToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const pollRef = useRef(null);
  const inputRef = useRef(null);
  const dragDepth = useRef(0);

  const load = useCallback(async () => {
    try {
      setRows((await api.get("/leads")).data);
      setErr("");
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
  const pollImport = useCallback(
    (id) => {
      clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const r = await api.get(`/leads/${id}/import-status`);
          setProgress(r.data);
          if (r.data.state !== "importing") {
            clearInterval(pollRef.current);
            setUploading(false);
            if (r.data.state === "failed") toast.error(`Import failed: ${r.data.error}`);
            else toast.ok(`Imported ${r.data.total.toLocaleString()} leads.`);
            await load();
            setTimeout(() => setProgress(null), 4000);
          }
        } catch {
          clearInterval(pollRef.current);
          setUploading(false);
        }
      }, 1000);
    },
    [load, toast]
  );

  const pickFile = (f) => {
    if (!f) return;
    setFile(f);
    // A sensible default list name from the filename, so the form is one click.
    if (!name.trim()) setName(f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim());
  };

  const submit = async (e) => {
    e.preventDefault();
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
      if (inputRef.current) inputRef.current.value = "";
    } catch (e2) {
      toast.error(e2.message);
      setUploading(false);
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    pickFile(e.dataTransfer.files?.[0]);
  };

  const totals = useMemo(() => {
    const biggest = rows.reduce((a, r) => ((r.leadCount || 0) > (a?.leadCount || 0) ? r : a), null);
    return {
      lists: rows.length,
      ready: rows.filter((r) => r.importState === "done").length,
      leads: rows.reduce((a, r) => a + (r.leadCount || 0), 0),
      largest: biggest?.leadCount || 0,
      largestName: biggest?.name || "",
    };
  }, [rows]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((l) => l.name.toLowerCase().includes(needle));
  }, [rows, q]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Lead lists</h1>
          <p className="sub">
            Upload a CSV or Excel file. Every column becomes a{" "}
            <span className="token">{"{{variable}}"}</span> you can drop into a template.
          </p>
        </div>
      </div>

      {err && <Banner kind="error" onClose={() => setErr("")}>{err}</Banner>}

      <div className="grid c3 stagger" style={{ marginBottom: 16 }}>
        <Stat label="Lists" value={totals.lists} icon={File} foot={`${totals.ready} ready to use`} />
        <Stat label="Total leads" value={totals.leads} icon={Users} accent />
        <Stat
          label="Largest list"
          value={totals.largest}
          icon={Search}
          foot={totals.largestName || "—"}
        />
      </div>

      <Card>
        <SectionTitle
          icon={Upload}
          title="Upload a list"
          hint="The file must have an email column. Invalid and duplicate addresses are skipped."
        />

        <form onSubmit={submit}>
          <div
            className={`dropzone ${dragging ? "over" : ""}`.trim()}
            onClick={() => inputRef.current?.click()}
            onDragEnter={(e) => {
              e.preventDefault();
              dragDepth.current += 1;
              setDragging(true);
            }}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={(e) => {
              e.preventDefault();
              dragDepth.current -= 1;
              if (dragDepth.current <= 0) setDragging(false);
            }}
            onDrop={onDrop}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
          >
            <span className="art">
              <Upload size={20} />
            </span>
            {file ? (
              <>
                <strong className="small">{file.name}</strong>
                <span className="tiny faint">
                  {(file.size / 1024).toFixed(0)} KB · click to choose a different file
                </span>
              </>
            ) : (
              <>
                <strong className="small">Drop a file here, or click to browse</strong>
                <span className="tiny faint">CSV, XLSX or XLS</span>
              </>
            )}
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={(e) => pickFile(e.target.files?.[0])}
              style={{ display: "none" }}
            />
          </div>

          <div className="row" style={{ marginTop: 14 }}>
            <Field label="List name" htmlFor="lname">
              <input
                id="lname"
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Q1 SaaS founders"
              />
            </Field>
            <div className="shrink">
              <Button
                type="submit"
                variant="primary"
                icon={Upload}
                loading={uploading}
                disabled={!file || !name.trim()}
              >
                {uploading ? "Importing…" : "Upload list"}
              </Button>
            </div>
          </div>
        </form>

        {progress && (
          <div style={{ marginTop: 6 }}>
            <div className="small" style={{ marginBottom: 7 }}>
              {progress.state === "done"
                ? `Imported ${progress.total.toLocaleString()} leads${
                    progress.skipped ? ` (${progress.skipped} skipped)` : ""
                  }.`
                : progress.state === "failed"
                  ? `Failed: ${progress.error}`
                  : `Importing ${progress.inserted.toLocaleString()} / ${progress.total.toLocaleString()}…`}
            </div>
            <Progress percent={progress.percent || 0} done={progress.state === "done"} />
          </div>
        )}
      </Card>

      {loading ? (
        <Card className="flush" style={{ marginTop: 14 }}>
          <TableSkeleton rows={4} cols={4} />
        </Card>
      ) : !rows.length ? (
        <Card style={{ marginTop: 14 }}>
          <EmptyState icon={Users} title="No lead lists yet">
            Upload your first CSV above. Column headers become the variables available to
            every template in a campaign.
          </EmptyState>
        </Card>
      ) : (
        <Card className="flush" style={{ marginTop: 14 }}>
          <div className="card-head">
            <h2>
              Your lists <span className="faint nums">({rows.length})</span>
            </h2>
            <div className="input-affix" style={{ width: 220, maxWidth: "100%" }}>
              <Search size={15} />
              <input
                type="search"
                placeholder="Search lists…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="Search lists"
              />
            </div>
          </div>

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
                {!shown.length && (
                  <tr>
                    <td colSpan={5}>
                      <EmptyState icon={Search} title="No list matches that search" />
                    </td>
                  </tr>
                )}

                {shown.map((l) => (
                  <tr key={l._id}>
                    <td className="strong">{l.name}</td>
                    <td className="num nums">{l.leadCount.toLocaleString()}</td>
                    <td style={{ maxWidth: 380 }}>
                      {(l.columns || []).slice(0, 8).map((col) => (
                        <span className="token" key={col}>
                          {`{{${col}}}`}
                        </span>
                      ))}
                      {(l.columns || []).length > 8 && (
                        <span className="tiny faint">+{l.columns.length - 8} more</span>
                      )}
                    </td>
                    <td>
                      {l.importState === "done" ? (
                        <Badge kind="ok">Ready</Badge>
                      ) : l.importState === "importing" ? (
                        <Badge kind="warn" live>
                          Importing
                        </Badge>
                      ) : (
                        <Badge kind="danger">Failed</Badge>
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <Button size="sm" variant="danger" icon={Trash} onClick={() => setToDelete(l)}>
                        Delete
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={!!toDelete}
        title="Delete this lead list?"
        body={
          toDelete && (
            <>
              <strong>{toDelete.name}</strong> and its{" "}
              {toDelete.leadCount.toLocaleString()} leads will be removed. Campaigns already
              using it keep their history.
            </>
          )
        }
        confirmLabel="Delete list"
        busy={deleting}
        onCancel={() => setToDelete(null)}
        onConfirm={async () => {
          setDeleting(true);
          try {
            await api.del(`/leads/${toDelete._id}`);
            toast.ok("Lead list deleted.");
            await load();
          } catch (e) {
            toast.error(e.message);
          } finally {
            setDeleting(false);
            setToDelete(null);
          }
        }}
      />
    </>
  );
}

export default function Page() {
  return (
    <Shell crumb="Lead lists">
      <Leads />
    </Shell>
  );
}
