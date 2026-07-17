import { useEffect, useState, useRef } from "react";
import {
  collection, getDocs, doc, updateDoc, arrayUnion, arrayRemove,
} from "firebase/firestore";
import { db } from "../firebase";

export default function Employees() {
  const [employees, setEmployees]   = useState([]);
  const [filter, setFilter]         = useState("all");
  const [loading, setLoading]       = useState(true);
  const [modal, setModal]           = useState(null); // { emp } | null

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    const snap = await getDocs(collection(db, "employees"));
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    list.sort((a, b) => (a.is_unknown ? 1 : -1));
    setEmployees(list);
    setLoading(false);
  }

  async function saveEmployee(id, fields, wasUnknown) {
    // When converting an unknown, automatically trigger frame capture
    if (wasUnknown) {
      fields.needs_capture   = true;
      fields.capture_ready   = false;
      fields.capture_frames  = [];
    }
    await updateDoc(doc(db, "employees", id), fields);
    setModal(null);
    load();
  }

  const filtered = employees.filter((e) => {
    if (filter === "unknown") return e.is_unknown;
    if (filter === "known")   return !e.is_unknown;
    return true;
  });

  const unknownCount = employees.filter((e) => e.is_unknown).length;
  const retrainCount  = employees.filter((e) => e.needs_retraining).length;
  const captureCount  = employees.filter((e) => e.needs_capture).length;
  const reviewCount   = employees.filter((e) => e.capture_ready).length;

  return (
    <div>
      <div className="page-header">
        <h1>Employees</h1>
        <p>Convert unknown faces to named employees and upload training photos</p>
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
          <div className="label">Unknown</div>
          <div className="value">{unknownCount}</div>
        </div>
      </div>

      {captureCount > 0 && (
        <div className="retrain-banner" style={{ background: "#eff6ff", borderColor: "#bfdbfe", color: "#1e40af" }}>
          📷 {captureCount} employee{captureCount > 1 ? "s" : ""} waiting for frame capture — walk past the camera to collect training frames
        </div>
      )}
      {reviewCount > 0 && (
        <div className="retrain-banner" style={{ background: "#f0fdf4", borderColor: "#bbf7d0", color: "#166534" }}>
          ✅ {reviewCount} employee{reviewCount > 1 ? "s" : ""} ready for frame review — select the best frames to train recognition
        </div>
      )}
      {retrainCount > 0 && (
        <div className="retrain-banner">
          ⚙️ {retrainCount} employee{retrainCount > 1 ? "s" : ""} pending retraining — backend will update recognition automatically
        </div>
      )}

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
                        <div className="avatar" />
                      )}
                    </td>
                    <td style={{ fontFamily: "monospace", fontSize: 12 }}>{e.id}</td>
                    <td>
                      {e.name}
                      {e.needs_retraining && (
                        <span style={{ marginLeft: 6, fontSize: 10, color: "#d97706" }}>⚙️ retraining</span>
                      )}
                    </td>
                    <td>{e.department || "—"}</td>
                    <td>
                      <span className={`badge ${e.is_unknown ? "unknown" : "present"}`}>
                        {e.is_unknown ? "Unknown" : "Known"}
                      </span>
                    </td>
                    <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button
                        className="btn btn-sm btn-outline"
                        onClick={() => setModal({ emp: e, mode: "edit" })}
                      >
                        {e.is_unknown ? "Convert" : "Edit"}
                      </button>
                      {e.capture_ready && (
                        <button
                          className="btn btn-sm btn-primary"
                          onClick={() => setModal({ emp: e, mode: "review" })}
                        >
                          📷 Review
                        </button>
                      )}
                      {e.needs_capture && !e.capture_ready && (
                        <span className="badge unknown" style={{ alignSelf: "center" }}>
                          capturing…
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal?.mode === "review" ? (
        <CaptureReviewModal
          emp={modal.emp}
          onClose={() => setModal(null)}
          onTrained={() => { setModal(null); load(); }}
        />
      ) : modal ? (
        <EmployeeModal
          emp={modal.emp}
          onSave={saveEmployee}
          onClose={() => setModal(null)}
        />
      ) : null}
    </div>
  );
}

/* ── Resize image in browser before storing ──────────────────── */
function resizeImage(file, maxSize = 200) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.7).split(",")[1]); // base64 only
    };
    img.src = url;
  });
}

/* ── Modal ───────────────────────────────────────────────────── */
function EmployeeModal({ emp, onSave, onClose }) {
  const [name,     setName]     = useState(emp.is_unknown ? "" : (emp.name || ""));
  const [empCode,  setEmpCode]  = useState(emp.emp_code || "");
  const [dept,     setDept]     = useState(emp.department || "");
  const [email,    setEmail]    = useState(emp.email || "");
  const [phone,    setPhone]    = useState(emp.phone || "");
  const [photos,   setPhotos]   = useState([]); // [{ file, preview, b64 }]
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState("");
  const fileRef = useRef();

  const existingPhotoCount = emp.training_photos?.length || 0;
  const MAX_PHOTOS = 5;
  const canAddMore = photos.length + existingPhotoCount < MAX_PHOTOS;

  async function handleFileChange(e) {
    const files = Array.from(e.target.files).slice(0, MAX_PHOTOS - existingPhotoCount - photos.length);
    const newPhotos = await Promise.all(
      files.map(async (file) => ({
        file,
        preview: URL.createObjectURL(file),
        b64: await resizeImage(file),
      }))
    );
    setPhotos((prev) => [...prev, ...newPhotos]);
    e.target.value = "";
  }

  function removePhoto(i) {
    setPhotos((prev) => {
      URL.revokeObjectURL(prev[i].preview);
      return prev.filter((_, idx) => idx !== i);
    });
  }

  async function handleSave() {
    if (!name.trim()) { setError("Name is required"); return; }
    setSaving(true);
    try {
      const fields = {
        name:       name.trim(),
        emp_code:   empCode.trim(),
        department: dept.trim(),
        email:      email.trim(),
        phone:      phone.trim(),
        is_unknown: false,
      };
      if (photos.length > 0) {
        fields.training_photos = arrayUnion(...photos.map((p) => p.b64));
        fields.needs_retraining = true;
      }
      await onSave(emp.id, fields, emp.is_unknown);
    } catch (err) {
      setError("Save failed: " + err.message);
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
        <h2>{emp.is_unknown ? `Convert ${emp.id} → Employee` : `Edit ${emp.name}`}</h2>

        {/* Existing CCTV snapshot */}
        {emp.face_snapshot_url && (
          <div style={{ marginBottom: 16 }}>
            <img
              src={emp.face_snapshot_url}
              alt="CCTV snapshot"
              style={{ width: 80, height: 80, borderRadius: 8, objectFit: "cover" }}
            />
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>CCTV snapshot</div>
          </div>
        )}

        {/* ── Info fields ── */}
        <div className="field-row">
          <div className="field">
            <label>Full Name *</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Ramesh Kumar"
            />
          </div>
          <div className="field">
            <label>Employee Code</label>
            <input
              className="input"
              value={empCode}
              onChange={(e) => setEmpCode(e.target.value)}
              placeholder="e.g. EMP001"
            />
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label>Department</label>
            <input
              className="input"
              value={dept}
              onChange={(e) => setDept(e.target.value)}
              placeholder="e.g. Engineering"
            />
          </div>
          <div className="field">
            <label>Email</label>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="e.g. name@company.com"
            />
          </div>
        </div>

        <div className="field">
          <label>Phone</label>
          <input
            className="input"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="e.g. +91 9876543210"
          />
        </div>

        {/* ── Training photos ── */}
        <div className="field" style={{ marginTop: 4 }}>
          <label>
            Training Photos
            <span style={{ color: "#64748b", fontWeight: 400, marginLeft: 6 }}>
              ({existingPhotoCount + photos.length}/{MAX_PHOTOS}) — clear, front-facing photos improve recognition accuracy
            </span>
          </label>

          <div className="photo-grid">
            {/* Already stored photos indicator */}
            {existingPhotoCount > 0 && (
              <div className="photo-slot existing">
                <span style={{ fontSize: 20 }}>🖼️</span>
                <span style={{ fontSize: 11 }}>{existingPhotoCount} stored</span>
              </div>
            )}
            {/* New photos previews */}
            {photos.map((p, i) => (
              <div key={i} className="photo-slot">
                <img src={p.preview} alt="" />
                <button className="photo-remove" onClick={() => removePhoto(i)}>✕</button>
              </div>
            ))}
            {/* Add button */}
            {canAddMore && (
              <div className="photo-slot add-btn" onClick={() => fileRef.current.click()}>
                <span style={{ fontSize: 24, color: "#94a3b8" }}>＋</span>
                <span style={{ fontSize: 11, color: "#94a3b8" }}>Add photo</span>
              </div>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={handleFileChange}
          />
          {photos.length > 0 && (
            <p className="hint">
              ⚙️ Photos will be uploaded. Backend will retrain face recognition automatically.
            </p>
          )}
        </div>

        {error && <p style={{ color: "#dc2626", fontSize: 13, marginBottom: 8 }}>{error}</p>}

        <div className="modal-actions">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : emp.is_unknown ? "Convert to Employee" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Capture Review Modal ────────────────────────────────────── */
function CaptureReviewModal({ emp, onClose, onTrained }) {
  const frames  = emp.capture_frames || [];
  const [selected, setSelected] = useState(new Set());
  const [saving,   setSaving]   = useState(false);

  function toggle(i) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  }

  function selectAll()  { setSelected(new Set(frames.map((_, i) => i))); }
  function selectNone() { setSelected(new Set()); }

  async function handleTrain() {
    if (selected.size === 0) return;
    setSaving(true);
    try {
      const chosen = [...selected].map((i) => frames[i]);
      await updateDoc(doc(db, "employees", emp.id), {
        training_photos:  arrayUnion(...chosen),
        needs_retraining: true,
        capture_ready:    false,
        capture_frames:   [],
      });
      onTrained();
    } catch (err) {
      console.error(err);
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
        <h2>Review Captured Frames — {emp.name}</h2>
        <p className="hint" style={{ marginBottom: 12 }}>
          {frames.length} frames captured from the CCTV. Select the clearest ones and click Train.
        </p>

        <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
          <button className="btn btn-sm btn-outline" onClick={selectAll}>Select All</button>
          <button className="btn btn-sm btn-outline" onClick={selectNone}>None</button>
          <span style={{ fontSize: 13, color: "#64748b" }}>
            {selected.size} of {frames.length} selected
          </span>
        </div>

        <div className="capture-grid">
          {frames.map((b64, i) => (
            <div
              key={i}
              className={`capture-slot${selected.has(i) ? " selected" : ""}`}
              onClick={() => toggle(i)}
            >
              <img src={`data:image/jpeg;base64,${b64}`} alt={`Frame ${i + 1}`} />
              <div className="capture-check">{selected.has(i) ? "✓" : ""}</div>
              <div className="capture-label">#{i + 1}</div>
            </div>
          ))}
        </div>

        {frames.length === 0 && (
          <div className="empty">No frames yet — walk past the camera to collect them.</div>
        )}

        <div className="modal-actions">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={handleTrain}
            disabled={saving || selected.size === 0}
          >
            {saving
              ? "Sending to training…"
              : `Train with ${selected.size} frame${selected.size !== 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}
