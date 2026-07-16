import { useEffect, useState } from "react";
import { collection, query, where, getDocs } from "firebase/firestore";
import { db } from "../firebase";

export default function Reports() {
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo]     = useState(today());
  const [rows, setRows] = useState([]);
  const [employees, setEmployees] = useState({});
  const [loading, setLoading] = useState(false);

  function today() { return new Date().toISOString().slice(0, 10); }
  function firstOfMonth() {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
  }

  useEffect(() => {
    loadEmployees();
  }, []);

  async function loadEmployees() {
    const snap = await getDocs(collection(db, "employees"));
    const map = {};
    snap.forEach((d) => { map[d.id] = d.data(); });
    setEmployees(map);
  }

  async function runReport() {
    setLoading(true);
    const q = query(
      collection(db, "attendance"),
      where("date", ">=", from),
      where("date", "<=", to)
    );
    const snap = await getDocs(q);
    const raw = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    // Group by emp_id + date, keep first-in and last-out
    const grouped = {};
    raw.forEach((r) => {
      const key = `${r.emp_id}_${r.date}`;
      if (!grouped[key]) {
        grouped[key] = { ...r };
      } else {
        if (r.in_time  < grouped[key].in_time)  grouped[key].in_time  = r.in_time;
        if (r.out_time > grouped[key].out_time) grouped[key].out_time = r.out_time;
      }
    });

    const result = Object.values(grouped);
    result.sort((a, b) => a.date > b.date ? 1 : a.date < b.date ? -1 : 0);
    setRows(result);
    setLoading(false);
  }

  function fmt(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function hours(inT, outT) {
    if (!inT || !outT) return "—";
    const h = (new Date(outT) - new Date(inT)) / 3600000;
    return `${h.toFixed(1)}h`;
  }

  function exportCSV() {
    const header = "Date,Employee ID,Name,Department,First In,Last Out,Hours\n";
    const body = rows.map((r) => {
      const emp = employees[r.emp_id] || {};
      return [
        r.date,
        r.emp_id,
        emp.name || r.emp_id,
        emp.department || "",
        fmt(r.in_time),
        fmt(r.out_time),
        hours(r.in_time, r.out_time),
      ].join(",");
    }).join("\n");

    const blob = new Blob([header + body], { type: "text/csv" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `attendance_${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="page-header">
        <h1>Reports</h1>
        <p>First-in / last-out summary by date range</p>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="toolbar">
          <label style={{ fontSize: 13, color: "#64748b" }}>From</label>
          <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
          <label style={{ fontSize: 13, color: "#64748b" }}>To</label>
          <input type="date" className="input" value={to}   onChange={(e) => setTo(e.target.value)} />
          <button className="btn btn-primary" onClick={runReport} disabled={loading}>
            {loading ? "Loading…" : "Run Report"}
          </button>
          {rows.length > 0 && (
            <button className="btn btn-outline" onClick={exportCSV}>Export CSV</button>
          )}
        </div>
      </div>

      {rows.length > 0 && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Employee</th>
                  <th>Department</th>
                  <th>First In</th>
                  <th>Last Out</th>
                  <th>Total Hours</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const emp = employees[r.emp_id] || {};
                  return (
                    <tr key={r.id}>
                      <td>{r.date}</td>
                      <td>
                        <div className="emp-cell">
                          {emp.face_snapshot_url
                            ? <img className="avatar" src={emp.face_snapshot_url} alt="" />
                            : <div className="avatar" style={{ background: "#e2e8f0" }} />}
                          <span>{emp.name || r.emp_id}</span>
                        </div>
                      </td>
                      <td>{emp.department || "—"}</td>
                      <td>{fmt(r.in_time)}</td>
                      <td>{fmt(r.out_time)}</td>
                      <td>{hours(r.in_time, r.out_time)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading && rows.length === 0 && (
        <div className="empty card">Select a date range and click Run Report.</div>
      )}
    </div>
  );
}
