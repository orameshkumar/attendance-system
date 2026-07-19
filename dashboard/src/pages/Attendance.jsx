import { useEffect, useState } from "react";
import {
  collection, query, where, getDocs,
  deleteDoc, doc, updateDoc, arrayUnion, writeBatch, getDoc,
} from "firebase/firestore";
import { db } from "../firebase";
import FrameCropModal from "../components/FrameCropModal";

export default function Attendance() {
  const [records,      setRecords]      = useState([]);
  const [employees,    setEmployees]    = useState({});
  const [convertModal, setConvertModal] = useState(null); // emp object for unknown
  const [selectedDate, setSelectedDate] = useState(today());
  const [loading,      setLoading]      = useState(true);
  const [selected,     setSelected]     = useState(new Set()); // record IDs chosen for bulk delete
  const [deleting,     setDeleting]     = useState(false);

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  useEffect(() => { loadEmployees(); }, []);

  useEffect(() => {
    if (Object.keys(employees).length > 0) loadAttendance();
  }, [selectedDate, employees]);

  async function loadEmployees() {
    const snap = await getDocs(collection(db, "employees"));
    const map = {};
    snap.forEach((d) => { map[d.id] = { id: d.id, ...d.data() }; });
    setEmployees(map);
  }

  async function loadAttendance() {
    setLoading(true);
    setSelected(new Set());
    const q = query(collection(db, "attendance"), where("date", "==", selectedDate));
    const snap = await getDocs(q);
    const raw = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    // Consolidate multiple sessions per employee into one row:
    // earliest in_time → Start Time, latest out_time → End Time
    const byEmp = {};
    raw.forEach((r) => {
      const key = r.emp_id;
      if (!byEmp[key]) {
        byEmp[key] = { ...r, _ids: [r.id] };
      } else {
        byEmp[key]._ids.push(r.id);
        if (r.in_time && (!byEmp[key].in_time || r.in_time < byEmp[key].in_time))
          byEmp[key].in_time = r.in_time;
        if (r.out_time && (!byEmp[key].out_time || r.out_time > byEmp[key].out_time))
          byEmp[key].out_time = r.out_time;
      }
    });

    const rows = Object.values(byEmp);
    rows.sort((a, b) => (a.in_time > b.in_time ? 1 : -1));
    setRecords(rows);
    setLoading(false);
  }

  function toggleOne(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === records.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(records.map((r) => r.id)));
    }
  }

  async function handleDelete(ids) {
    if (!window.confirm(`Delete ${ids.size ?? ids.length} record(s)? This cannot be undone.`)) return;
    setDeleting(true);
    const idsArr = ids instanceof Set ? [...ids] : ids;
    await Promise.all(idsArr.map((id) => deleteDoc(doc(db, "attendance", id))));
    setDeleting(false);
    loadAttendance();
  }

  const present  = records.filter((r) => !employees[r.emp_id]?.is_unknown).length;
  const unknowns = records.filter((r) =>  employees[r.emp_id]?.is_unknown).length;

  function fmt(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function duration(inT, outT) {
    if (!inT || !outT) return "—";
    const diff = new Date(outT) - new Date(inT);
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    return `${h}h ${m}m`;
  }

  function latestPhoto(emp) {
    const f = emp.capture_frames; if (f?.length) return f[f.length - 1];
    const t = emp.training_photos; if (t?.length) return t[t.length - 1];
    return emp.detection_frame || null;
  }

  function empAvatar(emp) {
    const src = latestPhoto(emp);
    return src
      ? <img className="avatar" src={`data:image/jpeg;base64,${src}`} alt="" />
      : <div className="avatar" style={{ background: "#e2e8f0" }} />;
  }

  const allSelected = records.length > 0 && selected.size === records.length;

  return (
    <div>
      <div className="page-header">
        <h1>Attendance</h1>
        <p>Daily first-in and last-out records</p>
      </div>

      <div className="stats-row">
        <div className="stat-card blue">
          <div className="label">Total Detected</div>
          <div className="value">{records.length}</div>
        </div>
        <div className="stat-card green">
          <div className="label">Known Employees</div>
          <div className="value">{present}</div>
        </div>
        <div className="stat-card orange">
          <div className="label">Unknowns</div>
          <div className="value">{unknowns}</div>
        </div>
      </div>

      <div className="card">
        <div className="toolbar">
          <input
            type="date"
            className="input"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
          />
          {selected.size > 0 && (
            <button
              className="btn btn-sm"
              style={{ background: "#dc2626", color: "#fff" }}
              onClick={() => handleDelete(selected)}
              disabled={deleting}
            >
              {deleting ? "Deleting…" : `Delete ${selected.size} selected`}
            </button>
          )}
        </div>

        {loading ? (
          <div className="loading">Loading…</div>
        ) : records.length === 0 ? (
          <div className="empty">No attendance records for this date.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      style={{ cursor: "pointer" }}
                    />
                  </th>
                  <th>Employee</th>
                  <th>Status</th>
                  <th>Start Time</th>
                  <th>End Time</th>
                  <th className="col-hide-mobile">Duration</th>
                  <th className="col-action-sticky" style={{ width: 60 }}></th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => {
                  const emp = employees[r.emp_id] || {};
                  const isUnknown = emp.is_unknown;
                  return (
                    <tr key={r.id} style={{ background: selected.has(r.id) ? "#eff6ff" : undefined }}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(r.id)}
                          onChange={() => toggleOne(r.id)}
                          style={{ cursor: "pointer" }}
                        />
                      </td>
                      <td>
                        <div className="emp-cell">
                          {empAvatar(emp)}
                          <span>{emp.name || r.emp_id}</span>
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${isUnknown ? "unknown" : "present"}`}>
                          {isUnknown ? "Unknown" : "Present"}
                        </span>
                        {isUnknown && emp.id && (
                          <button
                            className="btn btn-sm btn-outline"
                            style={{ marginLeft: 8, color: "#2563eb", borderColor: "#bfdbfe" }}
                            onClick={() => setConvertModal(emp)}
                            title="Identify this person"
                          >
                            Identify →
                          </button>
                        )}
                      </td>
                      <td>{fmt(r.in_time)}</td>
                      <td>{fmt(r.out_time)}</td>
                      <td className="col-hide-mobile">{duration(r.in_time, r.out_time)}</td>
                      <td className="col-action-sticky">
                        <button
                          className="btn btn-sm btn-outline"
                          style={{ color: "#dc2626", borderColor: "#fca5a5" }}
                          onClick={() => handleDelete([r.id])}
                          title="Delete this record"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {convertModal && (
        <QuickConvertModal
          emp={convertModal}
          allEmployees={Object.values(employees).filter((e) => !e.is_unknown)}
          onClose={() => { setConvertModal(null); loadEmployees(); loadAttendance(); }}
        />
      )}
    </div>
  );
}

function QuickConvertModal({ emp, allEmployees, onClose }) {
  const TRAINING_TARGET = 10;
  const [mode,        setMode]        = useState("new");   // "new" | "merge"
  const [name,        setName]        = useState("");
  const [dept,        setDept]        = useState("");
  const [search,      setSearch]      = useState("");
  const [mergeTarget, setMergeTarget] = useState(null);
  const [cropB64,     setCropB64]     = useState(null);
  const [showCrop,    setShowCrop]    = useState(false);
  const [saving,      setSaving]      = useState(false);
  const [error,       setError]       = useState("");

  const detectionFrame = emp.detection_frame || null;
  const filtered = allEmployees.filter((e) =>
    e.name?.toLowerCase().includes(search.toLowerCase())
  );

  async function handleSave() {
    setError("");
    if (mode === "new" && !name.trim()) { setError("Name is required."); return; }
    if (mode === "merge" && !mergeTarget) { setError("Select an employee to merge into."); return; }
    setSaving(true);
    // Use cropped image if available, otherwise fall back to the raw detection frame
    const photoToAdd = cropB64 || detectionFrame;
    try {
      if (mode === "new") {
        const fields = {
          name: name.trim(),
          department: dept.trim(),
          is_unknown: false,
          needs_capture: true,   // trigger backend to collect more training frames
          capture_ready: false,
          capture_frames: [],
        };
        if (photoToAdd) {
          const existing = (await getDoc(doc(db, "employees", emp.id))).data()?.training_photos || [];
          if (existing.length < TRAINING_TARGET) {
            fields.training_photos  = arrayUnion(photoToAdd);
            fields.needs_retraining = true;
          }
        }
        await updateDoc(doc(db, "employees", emp.id), fields);
      } else {
        const targetSnap = await getDoc(doc(db, "employees", mergeTarget.id));
        const existing = targetSnap.data()?.training_photos || [];
        const mergeFields = {
          needs_retraining: true,
          needs_capture: true,
          capture_ready: false,
          capture_frames: [],
        };
        if (photoToAdd && existing.length < TRAINING_TARGET) {
          mergeFields.training_photos = arrayUnion(photoToAdd);
        }
        await updateDoc(doc(db, "employees", mergeTarget.id), mergeFields);

        const attSnap = await getDocs(
          query(collection(db, "attendance"), where("emp_id", "==", emp.id))
        );
        const batch = writeBatch(db);
        attSnap.docs.forEach((d) => batch.update(d.ref, { emp_id: mergeTarget.id }));
        await batch.commit();
        await deleteDoc(doc(db, "employees", emp.id));
      }
      onClose();
    } catch (e) {
      setError("Save failed: " + e.message);
      setSaving(false);
    }
  }

  if (showCrop && detectionFrame) {
    return (
      <FrameCropModal
        index={0}
        b64={detectionFrame}
        onConfirm={(_, b64) => { setCropB64(b64); setShowCrop(false); }}
        onCancel={() => setShowCrop(false)}
      />
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <h2 style={{ marginBottom: 4 }}>Identify Unknown Person</h2>
        <p className="hint" style={{ marginBottom: 16 }}>
          Current ID: <strong>{emp.id}</strong>
        </p>

        {detectionFrame && (
          <div style={{ marginBottom: 16, textAlign: "center" }}>
            <div style={{ position: "relative", display: "inline-block" }}>
              <img
                src={`data:image/jpeg;base64,${cropB64 || detectionFrame}`}
                alt="detection"
                style={{ maxWidth: "100%", maxHeight: 200, borderRadius: 8, border: "1px solid #e2e8f0" }}
              />
              {cropB64 && (
                <span style={{ position: "absolute", top: 4, right: 4, background: "#16a34a",
                  color: "#fff", fontSize: 11, padding: "2px 6px", borderRadius: 4 }}>
                  ✓ cropped
                </span>
              )}
            </div>
            <div style={{ marginTop: 8 }}>
              <button className="btn btn-sm btn-outline" onClick={() => setShowCrop(true)}>
                ✂ {cropB64 ? "Re-crop" : "Crop person"}
              </button>
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <button
            className={`btn btn-sm ${mode === "new" ? "btn-primary" : "btn-outline"}`}
            onClick={() => setMode("new")}
          >
            New Employee
          </button>
          <button
            className={`btn btn-sm ${mode === "merge" ? "btn-primary" : "btn-outline"}`}
            onClick={() => setMode("merge")}
          >
            Merge into Existing
          </button>
        </div>

        {mode === "new" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="field">
              <label htmlFor="qc-name">Full Name *</label>
              <input id="qc-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ramesh Kumar" />
            </div>
            <div className="field">
              <label htmlFor="qc-dept">Department</label>
              <input id="qc-dept" className="input" value={dept} onChange={(e) => setDept(e.target.value)} placeholder="e.g. Shop" />
            </div>
          </div>
        )}

        {mode === "merge" && (
          <div>
            <div className="field" style={{ marginBottom: 8 }}>
              <label htmlFor="qc-search">Search employee</label>
              <input id="qc-search" className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Type name…" />
            </div>
            <div style={{ maxHeight: 180, overflowY: "auto", border: "1px solid #e2e8f0", borderRadius: 8 }}>
              {filtered.length === 0
                ? <div className="empty" style={{ padding: "12px 16px" }}>No employees found</div>
                : filtered.map((e) => (
                  <div
                    key={e.id}
                    onClick={() => setMergeTarget(e)}
                    style={{
                      padding: "10px 16px", cursor: "pointer", fontSize: 14,
                      background: mergeTarget?.id === e.id ? "#eff6ff" : undefined,
                      borderBottom: "1px solid #f1f5f9",
                    }}
                  >
                    <strong>{e.name}</strong>
                    {e.department && <span style={{ color: "#64748b", marginLeft: 8 }}>{e.department}</span>}
                    {mergeTarget?.id === e.id && <span style={{ float: "right", color: "#2563eb" }}>✓</span>}
                  </div>
                ))
              }
            </div>
          </div>
        )}

        {error && (
          <div style={{ marginTop: 12, color: "#dc2626", fontSize: 13 }}>{error}</div>
        )}

        <div className="modal-actions">
          <button
            className="btn btn-outline"
            style={{ color: "#64748b", borderColor: "#cbd5e1", marginRight: "auto" }}
            disabled={saving}
            onClick={async () => {
              if (!window.confirm("Ignore this unknown? It will be hidden from the employee list and removed from attendance.")) return;
              setSaving(true);
              try {
                await updateDoc(doc(db, "employees", emp.id), { is_ignored: true });
                const attSnap = await getDocs(
                  query(collection(db, "attendance"), where("emp_id", "==", emp.id))
                );
                const batch = writeBatch(db);
                attSnap.docs.forEach((d) => batch.delete(d.ref));
                await batch.commit();
                onClose();
              } catch (e) {
                setError("Failed: " + e.message);
                setSaving(false);
              }
            }}
          >
            Ignore
          </button>
          <button className="btn btn-outline" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : mode === "merge" ? "Merge" : "Create Employee"}
          </button>
        </div>
      </div>
    </div>
  );
}
