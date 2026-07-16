import { useEffect, useState } from "react";
import { collection, getDocs, doc, updateDoc } from "firebase/firestore";
import { db } from "../firebase";

export default function Employees() {
  const [employees, setEmployees] = useState([]);
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // { emp } | null

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    const snap = await getDocs(collection(db, "employees"));
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    list.sort((a, b) => (a.is_unknown ? 1 : -1));
    setEmployees(list);
    setLoading(false);
  }

  async function saveEmployee(id, name, department) {
    await updateDoc(doc(db, "employees", id), {
      name,
      department,
      is_unknown: false,
    });
    setModal(null);
    load();
  }

  const filtered = employees.filter((e) => {
    if (filter === "unknown") return e.is_unknown;
    if (filter === "known")   return !e.is_unknown;
    return true;
  });

  const unknownCount = employees.filter((e) => e.is_unknown).length;

  return (
    <div>
      <div className="page-header">
        <h1>Employees</h1>
        <p>Manage known employees and link unknown faces</p>
      </div>

      <div className="stats-row">
        <div className="stat-card blue">
          <div className="label">Total</div>
          <div className="value">{employees.length}</div>
        </div>
        <div className="stat-card green">
          <div className="label">Known</div>
          <div className="value">{employees.length - unknownCount}</div>
        </div>
        <div className="stat-card orange">
          <div className="label">Unlinked Unknowns</div>
          <div className="value">{unknownCount}</div>
        </div>
      </div>

      <div className="card">
        <div className="toolbar">
          {["all", "known", "unknown"].map((f) => (
            <button
              key={f}
              className={`btn btn-sm ${filter === f ? "btn-primary" : "btn-outline"}`}
              onClick={() => setFilter(f)}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="loading">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="empty">No employees found.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Photo</th>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Department</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => (
                  <tr key={e.id}>
                    <td>
                      {e.face_snapshot_url ? (
                        <img className="avatar" src={e.face_snapshot_url} alt="" />
                      ) : (
                        <div className="avatar" style={{ background: "#e2e8f0" }} />
                      )}
                    </td>
                    <td style={{ fontFamily: "monospace", fontSize: 12 }}>{e.id}</td>
                    <td>{e.name}</td>
                    <td>{e.department || "—"}</td>
                    <td>
                      <span className={`badge ${e.is_unknown ? "unknown" : "present"}`}>
                        {e.is_unknown ? "Unknown" : "Known"}
                      </span>
                    </td>
                    <td>
                      <button
                        className="btn btn-sm btn-outline"
                        onClick={() => setModal({ emp: e })}
                      >
                        {e.is_unknown ? "Link" : "Edit"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal && (
        <LinkModal
          emp={modal.emp}
          onSave={saveEmployee}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

function LinkModal({ emp, onSave, onClose }) {
  const [name, setName]   = useState(emp.is_unknown ? "" : emp.name);
  const [dept, setDept]   = useState(emp.department || "");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    await onSave(emp.id, name.trim(), dept.trim());
    setSaving(false);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{emp.is_unknown ? `Link ${emp.id} to Employee` : `Edit ${emp.name}`}</h2>
        {emp.face_snapshot_url && (
          <img
            src={emp.face_snapshot_url}
            alt=""
            style={{ width: 80, height: 80, borderRadius: 8, objectFit: "cover", marginBottom: 16 }}
          />
        )}
        <div className="field">
          <label>Full Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ramesh Kumar" />
        </div>
        <div className="field">
          <label>Department</label>
          <input className="input" value={dept} onChange={(e) => setDept(e.target.value)} placeholder="e.g. Engineering" />
        </div>
        <div className="modal-actions">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
