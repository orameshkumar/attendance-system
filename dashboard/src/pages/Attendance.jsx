import { useEffect, useState } from "react";
import { collection, query, where, getDocs, orderBy } from "firebase/firestore";
import { db } from "../firebase";

export default function Attendance() {
  const [records, setRecords] = useState([]);
  const [employees, setEmployees] = useState({});
  const [selectedDate, setSelectedDate] = useState(today());
  const [loading, setLoading] = useState(true);

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  useEffect(() => {
    loadEmployees();
  }, []);

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
    const q = query(
      collection(db, "attendance"),
      where("date", "==", selectedDate)
    );
    const snap = await getDocs(q);
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    rows.sort((a, b) => (a.in_time > b.in_time ? 1 : -1));
    setRecords(rows);
    setLoading(false);
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
                  <th>Employee</th>
                  <th>Status</th>
                  <th>First In</th>
                  <th>Last Out</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => {
                  const emp = employees[r.emp_id] || {};
                  const isUnknown = emp.is_unknown;
                  return (
                    <tr key={r.id}>
                      <td>
                        <div className="emp-cell">
                          {emp.face_snapshot_url ? (
                            <img className="avatar" src={emp.face_snapshot_url} alt="" />
                          ) : (
                            <div className="avatar" style={{ background: "#e2e8f0" }} />
                          )}
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
