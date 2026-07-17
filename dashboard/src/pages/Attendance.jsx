import { useEffect, useState } from "react";
import {
  collection, query, where, getDocs,
  deleteDoc, doc,
} from "firebase/firestore";
import { db } from "../firebase";

export default function Attendance() {
  const [records,      setRecords]      = useState([]);
  const [employees,    setEmployees]    = useState({});
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
    snap.forEach((d) => { map[d.id] = d.data(); });
    setEmployees(map);
  }

  async function loadAttendance() {
    setLoading(true);
    setSelected(new Set());
    const q = query(collection(db, "attendance"), where("date", "==", selectedDate));
    const snap = await getDocs(q);
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
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
                  <th>Duration</th>
                  <th style={{ width: 60 }}></th>
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
                      </td>
                      <td>{fmt(r.in_time)}</td>
                      <td>{fmt(r.out_time)}</td>
                      <td>{duration(r.in_time, r.out_time)}</td>
                      <td>
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
    </div>
  );
}
