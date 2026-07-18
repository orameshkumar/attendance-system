import { useEffect, useState, useRef } from "react";
import {
  collection, getDocs, doc, updateDoc, deleteDoc, arrayUnion, query, where, writeBatch,
} from "firebase/firestore";
import { db } from "../firebase";

function latestPhoto(e) {
  const f = e.capture_frames;
  if (f?.length) return f[f.length - 1];
  const t = e.training_photos;
  if (t?.length) return t[t.length - 1];
  return e.detection_frame || null;
}

function fmtTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function Employees() {
  const [employees,   setEmployees]   = useState([]);
  const [attendance,  setAttendance]  = useState({}); // emp_id → { in_time, out_time }
  const [filter,      setFilter]      = useState("all");
  const [loading,     setLoading]     = useState(true);
  const [modal,       setModal]       = useState(null);
  const [selected,    setSelected]    = useState(new Set());
  const [deleting,    setDeleting]    = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    const [empSnap, attSnap] = await Promise.all([
      getDocs(collection(db, "employees")),
      getDocs(query(
        collection(db, "attendance"),
        where("date", "==", new Date().toISOString().slice(0, 10))
      )),
    ]);

    const list = empSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    list.sort((a, b) => (a.is_unknown ? 1 : -1));
    setEmployees(list);

    // Build attendance map: keep earliest in_time and latest out_time per employee
    const attMap = {};
    attSnap.docs.forEach((d) => {
      const r = d.data();
      if (!attMap[r.emp_id]) {
        attMap[r.emp_id] = { in_time: r.in_time, out_time: r.out_time };
      } else {
        if (r.in_time  < attMap[r.emp_id].in_time)  attMap[r.emp_id].in_time  = r.in_time;
        if (r.out_time > attMap[r.emp_id].out_time) attMap[r.emp_id].out_time = r.out_time;
      }
    });
    setAttendance(attMap);
    setLoading(false);
  }

  async function toggleIgnore(emp) {
    const newVal = !emp.is_ignored;
    await updateDoc(doc(db, "employees", emp.id), { is_ignored: newVal });
    load();
  }

  async function saveEmployee(id, fields, wasUnknown, captureFrames, uploadedPhotos = []) {
    if (wasUnknown) {
      fields.needs_capture  = true;
      fields.capture_ready  = false;
      fields.capture_frames = [];
      // Combine capture frames + manually uploaded photos into one additive arrayUnion
      // arrayUnion only adds to existing training_photos — never replaces them
      const allNewPhotos = [...(captureFrames || []), ...uploadedPhotos];
      if (allNewPhotos.length > 0) {
        fields.training_photos  = arrayUnion(...allNewPhotos);
        fields.needs_retraining = true;
      }
    }
    await updateDoc(doc(db, "employees", id), fields);
    setModal(null);
    load();
  }

  async function mergeUnknownIntoEmployee(unknownId, targetId, captureFrames) {
    // 1. Add capture frames as training photos on target
    const mergeFields = { needs_retraining: true };
    if (captureFrames?.length) {
      mergeFields.training_photos = arrayUnion(...captureFrames);
    }
    await updateDoc(doc(db, "employees", targetId), mergeFields);

    // 2. Re-assign all attendance records from unknown → target employee
    //    Frontend groups by emp_id+date and already picks earliest in_time
    //    and latest out_time, so start/end times merge automatically
    const attSnap = await getDocs(
      query(collection(db, "attendance"), where("emp_id", "==", unknownId))
    );
    if (attSnap.docs.length > 0) {
      const batch = writeBatch(db);
      attSnap.docs.forEach((d) => batch.update(d.ref, { emp_id: targetId }));
      await batch.commit();
    }

    // 3. Delete the unknown employee record
    await deleteDoc(doc(db, "employees", unknownId));
    setModal(null);
    load();
  }

  function toggleOne(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll(ids) {
    if (selected.size === ids.length) setSelected(new Set());
    else setSelected(new Set(ids));
  }

  async function handleDelete(ids) {
    const arr = ids instanceof Set ? [...ids] : ids;
    if (!window.confirm(`Delete ${arr.length} employee record(s)? This cannot be undone.`)) return;
    setDeleting(true);
    await Promise.all(arr.map((id) => deleteDoc(doc(db, "employees", id))));
    setDeleting(false);
    setSelected(new Set());
    load();
  }

  const filtered = employees.filter((e) => {
    if (filter === "unknown")  return e.is_unknown && !e.is_ignored;
    if (filter === "known")    return !e.is_unknown && !e.is_ignored;
    if (filter === "ignored")  return e.is_ignored;
    return !e.is_ignored; // "all" hides ignored by default
  });

  const unknownCount = employees.filter((e) => e.is_unknown  && !e.is_ignored).length;
  const ignoredCount = employees.filter((e) => e.is_ignored).length;
  const retrainCount = employees.filter((e) => e.needs_retraining).length;
  const captureCount = employees.filter((e) => e.needs_capture).length;
  const reviewCount  = employees.filter((e) => e.capture_ready).length;
  const filteredIds  = filtered.map((e) => e.id);
  const allSelected  = filteredIds.length > 0 && selected.size === filteredIds.length;

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
          📷 {captureCount} employee{captureCount > 1 ? "s" : ""} waiting for frame capture — walk past the camera
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
          {[
            { key: "all",     label: "All" },
            { key: "known",   label: "Known" },
            { key: "unknown", label: "Unknown" },
            { key: "ignored", label: `Ignored${ignoredCount > 0 ? ` (${ignoredCount})` : ""}` },
          ].map(({ key, label }) => (
            <button
              key={key}
              className={`btn btn-sm ${filter === key ? "btn-primary" : "btn-outline"}`}
              onClick={() => { setFilter(key); setSelected(new Set()); }}
            >
              {label}
            </button>
          ))}
          {selected.size > 0 && (
            <button
              className="btn btn-sm"
              style={{ background: "#dc2626", color: "#fff", marginLeft: "auto" }}
              onClick={() => handleDelete(selected)}
              disabled={deleting}
            >
              {deleting ? "Deleting…" : `Delete ${selected.size} selected`}
            </button>
          )}
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
                  <th style={{ width: 36 }}>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={() => toggleAll(filteredIds)}
                      style={{ cursor: "pointer" }}
                    />
                  </th>
                  <th>Photo</th>
                  <th>Detection</th>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Department</th>
                  <th>Status</th>
                  <th>Start Time</th>
                  <th>End Time</th>
                  <th>Action</th>
                  <th style={{ width: 44 }}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => {
                  const photo = latestPhoto(e);
                  const att   = attendance[e.id];
                  return (
                    <tr key={e.id} style={{ background: selected.has(e.id) ? "#eff6ff" : undefined }}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(e.id)}
                          onChange={() => toggleOne(e.id)}
                          style={{ cursor: "pointer" }}
                        />
                      </td>
                      <td>
                        {photo
                          ? <img className="avatar" src={`data:image/jpeg;base64,${photo}`} alt="" />
                          : <div className="avatar" />}
                      </td>
                      <td>
                        {e.detection_frame
                          ? (
                            <img
                              src={`data:image/jpeg;base64,${e.detection_frame}`}
                              alt="detection"
                              className="det-thumb"
                              onClick={() => setModal({ emp: e, mode: "detection" })}
                              title="Click to enlarge"
                            />
                          )
                          : <span style={{ color: "#cbd5e1", fontSize: 11 }}>—</span>}
                      </td>
                      <td style={{ fontFamily: "monospace", fontSize: 12 }}>{e.id}</td>
                      <td>
                        {e.name}
                        {e.needs_retraining && (
                          <span style={{ marginLeft: 6, fontSize: 10, color: "#d97706" }}>⚙️</span>
                        )}
                      </td>
                      <td>{e.department || "—"}</td>
                      <td>
                        {e.is_ignored
                          ? <span className="badge absent">Ignored</span>
                          : <span className={`badge ${e.is_unknown ? "unknown" : "present"}`}>
                              {e.is_unknown ? "Unknown" : "Known"}
                            </span>}
                      </td>
                      <td style={{ fontSize: 13 }}>{att ? fmtTime(att.in_time) : "—"}</td>
                      <td style={{ fontSize: 13 }}>{att ? fmtTime(att.out_time) : "—"}</td>
                      <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {!e.is_ignored && (
                          <button
                            className="btn btn-sm btn-outline"
                            onClick={() => setModal({ emp: e, mode: "edit" })}
                          >
                            {e.is_unknown ? "Convert" : "Edit"}
                          </button>
                        )}
                        <button
                          className="btn btn-sm btn-outline"
                          style={e.is_ignored
                            ? { color: "#16a34a", borderColor: "#86efac" }
                            : { color: "#64748b", borderColor: "#cbd5e1" }}
                          onClick={() => toggleIgnore(e)}
                          title={e.is_ignored ? "Remove from ignore list" : "Ignore this detection"}
                        >
                          {e.is_ignored ? "Unignore" : "Ignore"}
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
                      <td>
                        <button
                          className="btn btn-sm btn-outline"
                          style={{ color: "#dc2626", borderColor: "#fca5a5" }}
                          onClick={() => handleDelete([e.id])}
                          title="Delete employee"
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

      {modal?.mode === "review" ? (
        <CaptureReviewModal
          emp={modal.emp}
          onClose={() => setModal(null)}
          onTrained={() => { setModal(null); load(); }}
        />
      ) : modal?.mode === "detection" ? (
        <DetectionFrameModal
          emp={modal.emp}
          onClose={() => setModal(null)}
          onConvert={(cropB64) => setModal({ emp: modal.emp, mode: "edit", cropB64 })}
        />
      ) : modal ? (
        <EmployeeModal
          emp={modal.emp}
          initialCrop={modal.cropB64 || null}
          knownEmployees={employees.filter((e) => !e.is_unknown)}
          onSave={saveEmployee}
          onMerge={mergeUnknownIntoEmployee}
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
      resolve(canvas.toDataURL("image/jpeg", 0.7).split(",")[1]);
    };
    img.src = url;
  });
}

/* ── Employee / Convert modal ────────────────────────────────── */
function EmployeeModal({ emp, initialCrop = null, knownEmployees = [], onSave, onMerge, onClose }) {
  const [name,        setName]        = useState(emp.is_unknown ? "" : (emp.name || ""));
  const [empCode,     setEmpCode]     = useState(emp.emp_code || "");
  const [dept,        setDept]        = useState(emp.department || "");
  const [email,       setEmail]       = useState(emp.email || "");
  const [phone,       setPhone]       = useState(emp.phone || "");
  const [photos,      setPhotos]      = useState([]);
  const [saving,      setSaving]      = useState(false);
  const [error,       setError]       = useState("");
  const [mergeMode,   setMergeMode]   = useState(false);
  const [mergeSearch, setMergeSearch] = useState("");
  const [mergeTarget, setMergeTarget] = useState(null);
  // Capture frames + optional crop from detection frame; selectedFrames = Set of indices to include
  const [frameData, setFrameData] = useState(() => {
    const frames = (emp.capture_frames || []).map((b64) => ({ b64, cropped: false }));
    if (initialCrop) frames.unshift({ b64: initialCrop, cropped: true });
    return frames;
  });
  const [selectedFrames, setSelectedFrames] = useState(() => {
    const count = (emp.capture_frames || []).length + (initialCrop ? 1 : 0);
    return new Set(Array.from({ length: count }, (_, i) => i));
  });
  const [cropTarget, setCropTarget] = useState(null); // { index, b64 }
  const fileRef = useRef();

  const existingPhotoCount = emp.training_photos?.length || 0;
  const MAX_PHOTOS = 5;
  const canAddMore = photos.length + existingPhotoCount < MAX_PHOTOS;

  function toggleFrame(i) {
    setSelectedFrames((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  }

  function handleFrameCropDone(index, croppedB64) {
    setFrameData((prev) => {
      const next = [...prev];
      next[index] = { b64: croppedB64, cropped: true };
      return next;
    });
    setSelectedFrames((prev) => new Set([...prev, index]));
    setCropTarget(null);
  }

  // Filter known employees by search query
  const searchResults = mergeSearch.trim().length > 0
    ? knownEmployees.filter((ke) =>
        ke.name.toLowerCase().includes(mergeSearch.toLowerCase()) ||
        ke.id.toLowerCase().includes(mergeSearch.toLowerCase())
      )
    : knownEmployees;

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
    // Frames the user has selected (with any crops applied)
    const chosenFrames = [...selectedFrames].map((i) => frameData[i].b64);

    if (mergeMode) {
      if (!mergeTarget) { setError("Search and select an employee to merge into"); return; }
      setSaving(true);
      try {
        await onMerge(emp.id, mergeTarget.id, chosenFrames);
      } catch (err) {
        setError("Merge failed: " + err.message);
        setSaving(false);
      }
      return;
    }
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
      if (!emp.is_unknown && photos.length > 0) {
        fields.training_photos  = arrayUnion(...photos.map((p) => p.b64));
        fields.needs_retraining = true;
      }
      const uploadedPhotos = emp.is_unknown ? photos.map((p) => p.b64) : [];
      await onSave(emp.id, fields, emp.is_unknown, chosenFrames, uploadedPhotos);
    } catch (err) {
      setError("Save failed: " + err.message);
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
        <h2>{emp.is_unknown ? `Convert ${emp.id} → Employee` : `Edit ${emp.name}`}</h2>

        {emp.is_unknown && (
          <div style={{
            background: mergeMode ? "#eff6ff" : "#f8fafc",
            border: `1px solid ${mergeMode ? "#bfdbfe" : "#e2e8f0"}`,
            borderRadius: 10,
            padding: "10px 14px",
            marginBottom: 16,
          }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
              <input
                type="checkbox"
                checked={mergeMode}
                onChange={(ev) => { setMergeMode(ev.target.checked); setMergeTarget(null); setMergeSearch(""); }}
              />
              Merge into existing employee (same person, different records)
            </label>
            {mergeMode && (
              <div style={{ marginTop: 10 }}>
                {/* Search box */}
                <input
                  className="input"
                  placeholder="Search by name or ID…"
                  value={mergeSearch}
                  onChange={(ev) => { setMergeSearch(ev.target.value); setMergeTarget(null); }}
                  autoFocus
                />
                {/* Results list */}
                {mergeSearch.trim().length > 0 && (
                  <div style={{
                    border: "1px solid #e2e8f0",
                    borderRadius: 8,
                    marginTop: 4,
                    maxHeight: 180,
                    overflowY: "auto",
                    background: "#fff",
                  }}>
                    {searchResults.length === 0 ? (
                      <div style={{ padding: "10px 14px", fontSize: 13, color: "#94a3b8" }}>No matching employees</div>
                    ) : (
                      searchResults.map((ke) => (
                        <div
                          key={ke.id}
                          onClick={() => { setMergeTarget(ke); setMergeSearch(ke.name); }}
                          style={{
                            padding: "8px 14px",
                            cursor: "pointer",
                            fontSize: 13,
                            background: mergeTarget?.id === ke.id ? "#eff6ff" : undefined,
                            borderBottom: "1px solid #f1f5f9",
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                          }}
                          onMouseEnter={(ev) => { if (mergeTarget?.id !== ke.id) ev.currentTarget.style.background = "#f8fafc"; }}
                          onMouseLeave={(ev) => { if (mergeTarget?.id !== ke.id) ev.currentTarget.style.background = ""; }}
                        >
                          {latestPhoto(ke)
                            ? <img src={`data:image/jpeg;base64,${latestPhoto(ke)}`} alt="" style={{ width: 28, height: 28, borderRadius: "50%", objectFit: "cover" }} />
                            : <div style={{ width: 28, height: 28, borderRadius: "50%", background: "#e2e8f0", flexShrink: 0 }} />}
                          <div>
                            <div style={{ fontWeight: 600 }}>{ke.name}</div>
                            <div style={{ fontSize: 11, color: "#64748b" }}>{ke.id}{ke.department ? ` · ${ke.department}` : ""}</div>
                          </div>
                          {mergeTarget?.id === ke.id && <span style={{ marginLeft: "auto", color: "#2563eb", fontSize: 16 }}>✓</span>}
                        </div>
                      ))
                    )}
                  </div>
                )}
                {mergeTarget && (
                  <p className="hint" style={{ marginTop: 6, color: "#16a34a" }}>
                    ✓ Will merge into <strong>{mergeTarget.name}</strong>
                    {frameData.length > 0 && ` — ${selectedFrames.size} of ${frameData.length} frame${frameData.length > 1 ? "s" : ""} selected for training`}
                  </p>
                )}
                {!mergeTarget && (
                  <p className="hint" style={{ marginTop: 6 }}>
                    Captured frames will be added as training photos for the selected employee. The unknown record will be removed.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {!mergeMode && (
          <div>
            {emp.face_snapshot_url && (
              <div style={{ marginBottom: 16 }}>
                <img src={emp.face_snapshot_url} alt="CCTV snapshot"
                  style={{ width: 80, height: 80, borderRadius: 8, objectFit: "cover" }} />
                <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>CCTV snapshot</div>
              </div>
            )}

            <div className="field-row">
              <div className="field">
                <label>Full Name *</label>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ramesh Kumar" />
              </div>
              <div className="field">
                <label>Employee Code</label>
                <input className="input" value={empCode} onChange={(e) => setEmpCode(e.target.value)} placeholder="e.g. EMP001" />
              </div>
            </div>

            <div className="field-row">
              <div className="field">
                <label>Department</label>
                <input className="input" value={dept} onChange={(e) => setDept(e.target.value)} placeholder="e.g. Engineering" />
              </div>
              <div className="field">
                <label>Email</label>
                <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="e.g. name@company.com" />
              </div>
            </div>

            <div className="field">
              <label>Phone</label>
              <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="e.g. +91 9876543210" />
            </div>

            {frameData.length > 0 && (
              <div className="field" style={{ marginTop: 4 }}>
                <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span>Captured Frames
                    <span style={{ color: "#64748b", fontWeight: 400, marginLeft: 6 }}>
                      — select which to use, crop individual people if needed
                    </span>
                  </span>
                  <span style={{ fontSize: 12, color: "#64748b" }}>
                    {selectedFrames.size}/{frameData.length} selected
                  </span>
                </label>
                <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                  <button className="btn btn-sm btn-outline" style={{ fontSize: 11 }}
                    onClick={() => setSelectedFrames(new Set(frameData.map((_, i) => i)))}>
                    Select all
                  </button>
                  <button className="btn btn-sm btn-outline" style={{ fontSize: 11 }}
                    onClick={() => setSelectedFrames(new Set())}>
                    None
                  </button>
                </div>
                <div className="capture-grid">
                  {frameData.map(({ b64, cropped }, i) => (
                    <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <div
                        className={`capture-slot${selectedFrames.has(i) ? " selected" : ""}`}
                        onClick={() => toggleFrame(i)}
                        style={{ position: "relative" }}
                      >
                        <img src={`data:image/jpeg;base64,${b64}`} alt={`Frame ${i + 1}`} />
                        <div className="capture-check">{selectedFrames.has(i) ? "✓" : ""}</div>
                        <div className="capture-label">#{i + 1}{cropped ? " ✂" : ""}</div>
                      </div>
                      <button
                        className="btn btn-sm btn-outline"
                        style={{ fontSize: 11, padding: "2px 6px", color: "#2563eb", borderColor: "#bfdbfe" }}
                        onClick={(e) => { e.stopPropagation(); setCropTarget({ index: i, b64 }); }}
                        title="Crop to select one person from this frame"
                      >
                        ✂ Select person
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="field" style={{ marginTop: 4 }}>
              <label>
                Additional Training Photos
                <span style={{ color: "#64748b", fontWeight: 400, marginLeft: 6 }}>
                  ({existingPhotoCount + photos.length}/{MAX_PHOTOS}) — upload extra clear, front-facing photos
                </span>
              </label>
              <div className="photo-grid">
                {existingPhotoCount > 0 && (
                  <div className="photo-slot existing">
                    <span style={{ fontSize: 20 }}>🖼️</span>
                    <span style={{ fontSize: 11 }}>{existingPhotoCount} stored</span>
                  </div>
                )}
                {photos.map((p, i) => (
                  <div key={i} className="photo-slot">
                    <img src={p.preview} alt="" />
                    <button className="photo-remove" onClick={() => removePhoto(i)}>✕</button>
                  </div>
                ))}
                {canAddMore && (existingPhotoCount + photos.length < MAX_PHOTOS) && (
                  <div className="photo-slot add-btn" onClick={() => fileRef.current.click()}>
                    <span style={{ fontSize: 24, color: "#94a3b8" }}>＋</span>
                    <span style={{ fontSize: 11, color: "#94a3b8" }}>Add photo</span>
                  </div>
                )}
              </div>
              <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={handleFileChange} />
              {photos.length > 0 && (
                <p className="hint">⚙️ Photos will be uploaded. Backend will retrain face recognition automatically.</p>
              )}
            </div>
          </div>
        )}

        {error && <p style={{ color: "#dc2626", fontSize: 13, marginBottom: 8 }}>{error}</p>}

        <div className="modal-actions">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving
              ? (mergeMode ? "Merging…" : "Saving…")
              : mergeMode
                ? "Merge into Employee"
                : emp.is_unknown
                  ? "Convert to Employee"
                  : "Save Changes"}
          </button>
        </div>
      </div>

      {cropTarget && (
        <FrameCropModal
          index={cropTarget.index}
          b64={cropTarget.b64}
          onConfirm={handleFrameCropDone}
          onCancel={() => setCropTarget(null)}
        />
      )}
    </div>
  );
}

/* ── Capture Review Modal ────────────────────────────────────── */
function CaptureReviewModal({ emp, onClose, onTrained }) {
  const [frameData, setFrameData] = useState(() =>
    (emp.capture_frames || []).map((b64) => ({ b64, cropped: false }))
  );
  const [selected,  setSelected]  = useState(new Set());
  const [cropTarget, setCropTarget] = useState(null); // { index, b64 }
  const [saving,    setSaving]    = useState(false);

  function toggle(i) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  }

  function handleCropDone(index, croppedB64) {
    setFrameData((prev) => {
      const next = [...prev];
      next[index] = { b64: croppedB64, cropped: true };
      return next;
    });
    // Auto-select the cropped frame
    setSelected((prev) => new Set([...prev, index]));
    setCropTarget(null);
  }

  async function handleTrain() {
    if (selected.size === 0) return;
    setSaving(true);
    try {
      const chosen = [...selected].map((i) => frameData[i].b64);
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
          {frameData.length} frames captured. Click a frame to select it for training, or use
          <strong> "Select person"</strong> to crop a specific person from a multi-person frame.
        </p>

        <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
          <button className="btn btn-sm btn-outline" onClick={() => setSelected(new Set(frameData.map((_, i) => i)))}>Select All</button>
          <button className="btn btn-sm btn-outline" onClick={() => setSelected(new Set())}>None</button>
          <span style={{ fontSize: 13, color: "#64748b" }}>{selected.size} of {frameData.length} selected</span>
        </div>

        <div className="capture-grid">
          {frameData.map(({ b64, cropped }, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div
                className={`capture-slot${selected.has(i) ? " selected" : ""}`}
                onClick={() => toggle(i)}
                style={{ position: "relative" }}
              >
                <img src={`data:image/jpeg;base64,${b64}`} alt={`Frame ${i + 1}`} />
                <div className="capture-check">{selected.has(i) ? "✓" : ""}</div>
                <div className="capture-label">
                  #{i + 1}{cropped ? " ✂" : ""}
                </div>
              </div>
              <button
                className="btn btn-sm btn-outline"
                style={{ fontSize: 11, padding: "2px 6px", color: "#2563eb", borderColor: "#bfdbfe" }}
                onClick={(e) => { e.stopPropagation(); setCropTarget({ index: i, b64 }); }}
                title="Crop to select one person from this frame"
              >
                ✂ Select person
              </button>
            </div>
          ))}
        </div>

        {frameData.length === 0 && <div className="empty">No frames yet — walk past the camera to collect them.</div>}

        <div className="modal-actions">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleTrain} disabled={saving || selected.size === 0}>
            {saving ? "Sending to training…" : `Train with ${selected.size} frame${selected.size !== 1 ? "s" : ""}`}
          </button>
        </div>
      </div>

      {cropTarget && (
        <FrameCropModal
          index={cropTarget.index}
          b64={cropTarget.b64}
          onConfirm={handleCropDone}
          onCancel={() => setCropTarget(null)}
        />
      )}
    </div>
  );
}

/* ── Frame Crop Modal ────────────────────────────────────────── */
function FrameCropModal({ index, b64, onConfirm, onCancel }) {
  const canvasRef  = useRef();
  const imgRef     = useRef();
  const [drag,     setDrag]    = useState(null);   // { x0, y0, x1, y1 } in image coords
  const [rect,     setRect]    = useState(null);   // confirmed selection
  const [imgLoaded, setImgLoaded] = useState(false);

  // Draw selection rectangle on canvas overlay
  useEffect(() => {
    const canvas = canvasRef.current;
    const img    = imgRef.current;
    if (!canvas || !img || !imgLoaded) return;
    const r = canvas.getBoundingClientRect();
    canvas.width  = r.width;
    canvas.height = r.height;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const sel = drag || rect;
    if (!sel) return;

    const { x0, y0, x1, y1 } = normalizeRect(sel);
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth   = 2;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.fillStyle = "rgba(37,99,235,0.12)";
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }, [drag, rect, imgLoaded]);

  function normalizeRect({ x0, y0, x1, y1 }) {
    return {
      x0: Math.min(x0, x1), y0: Math.min(y0, y1),
      x1: Math.max(x0, x1), y1: Math.max(y0, y1),
    };
  }

  function getPos(e) {
    const r = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onMouseDown(e) {
    const p = getPos(e);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    setRect(null);
  }

  function onMouseMove(e) {
    if (!drag) return;
    const p = getPos(e);
    setDrag((d) => ({ ...d, x1: p.x, y1: p.y }));
  }

  function onMouseUp() {
    if (!drag) return;
    const n = normalizeRect(drag);
    if (n.x1 - n.x0 > 10 && n.y1 - n.y0 > 10) setRect(drag);
    setDrag(null);
  }

  function cropAndConfirm() {
    if (!rect) return;
    const img    = imgRef.current;
    const canvas = canvasRef.current;
    const br     = canvas.getBoundingClientRect();
    const scaleX = img.naturalWidth  / br.width;
    const scaleY = img.naturalHeight / br.height;
    const { x0, y0, x1, y1 } = normalizeRect(rect);
    const sx = x0 * scaleX, sy = y0 * scaleY;
    const sw = (x1 - x0) * scaleX, sh = (y1 - y0) * scaleY;

    const out = document.createElement("canvas");
    out.width  = Math.min(sw, 200);
    out.height = Math.round(sh * (out.width / sw));
    out.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, out.width, out.height);
    const croppedB64 = out.toDataURL("image/jpeg", 0.8).split(",")[1];
    onConfirm(index, croppedB64);
  }

  return (
    <div
      className="modal-overlay"
      style={{ zIndex: 200 }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <h2 style={{ marginBottom: 8 }}>Select Person — Frame #{index + 1}</h2>
        <p className="hint" style={{ marginBottom: 12 }}>
          Drag a box around the person you want to use for training. Then click <strong>Use crop</strong>.
        </p>

        <div style={{ position: "relative", display: "inline-block", maxWidth: "100%", cursor: "crosshair" }}>
          <img
            ref={imgRef}
            src={`data:image/jpeg;base64,${b64}`}
            alt="frame"
            style={{ width: "100%", display: "block", borderRadius: 6, border: "1px solid #e2e8f0" }}
            onLoad={() => setImgLoaded(true)}
            draggable={false}
          />
          <canvas
            ref={canvasRef}
            style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
          />
        </div>

        {rect && (
          <p className="hint" style={{ marginTop: 8, color: "#16a34a" }}>
            ✓ Selection ready — click <strong>Use crop</strong> to apply
          </p>
        )}
        {!rect && (
          <p className="hint" style={{ marginTop: 8 }}>
            Click and drag on the image to draw a selection box
          </p>
        )}

        <div className="modal-actions">
          <button className="btn btn-outline" onClick={onCancel}>Back</button>
          <button className="btn btn-primary" onClick={cropAndConfirm} disabled={!rect}>
            ✂ Use crop
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Detection Frame Modal (with inline crop selector) ───────── */
function DetectionFrameModal({ emp, onClose, onConvert }) {
  const canvasRef    = useRef();
  const imgRef       = useRef();
  const [drag,       setDrag]       = useState(null);
  const [rect,       setRect]       = useState(null);
  const [imgLoaded,  setImgLoaded]  = useState(false);
  const [cropPreview, setCropPreview] = useState(null); // b64 of cropped region

  const hasFame = !!emp.detection_frame;

  // Redraw selection rectangle whenever drag/rect changes
  useEffect(() => {
    const canvas = canvasRef.current;
    const img    = imgRef.current;
    if (!canvas || !img || !imgLoaded) return;

    // Sync canvas buffer size to its rendered size
    const r = canvas.getBoundingClientRect();
    canvas.width  = r.width;
    canvas.height = r.height;

    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const sel = drag || rect;
    if (!sel) return;
    const { x0, y0, x1, y1 } = normRect(sel);
    ctx.strokeStyle = "#f59e0b";
    ctx.lineWidth   = 2;
    ctx.setLineDash([6, 3]);
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.fillStyle = "rgba(245,158,11,0.15)";
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }, [drag, rect, imgLoaded]);

  function normRect({ x0, y0, x1, y1 }) {
    return { x0: Math.min(x0,x1), y0: Math.min(y0,y1), x1: Math.max(x0,x1), y1: Math.max(y0,y1) };
  }

  function getPos(e) {
    const r = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onMouseDown(e) {
    if (!hasFame) return;
    const p = getPos(e);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    setRect(null);
    setCropPreview(null);
  }

  function onMouseMove(e) {
    if (!drag) return;
    const p = getPos(e);
    setDrag((d) => ({ ...d, x1: p.x, y1: p.y }));
  }

  function onMouseUp() {
    if (!drag) return;
    const n = normRect(drag);
    if (n.x1 - n.x0 > 10 && n.y1 - n.y0 > 10) {
      setRect(drag);
      // Generate crop preview
      const img    = imgRef.current;
      const canvas = canvasRef.current;
      const br     = canvas.getBoundingClientRect();
      const scaleX = img.naturalWidth  / br.width;
      const scaleY = img.naturalHeight / br.height;
      const { x0, y0, x1, y1 } = normRect(drag);
      const sx = x0 * scaleX, sy = y0 * scaleY;
      const sw = (x1 - x0) * scaleX, sh = (y1 - y0) * scaleY;
      const out = document.createElement("canvas");
      out.width  = Math.min(sw, 300);
      out.height = Math.round(sh * (out.width / sw));
      out.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, out.width, out.height);
      setCropPreview(out.toDataURL("image/jpeg", 0.85).split(",")[1]);
    }
    setDrag(null);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
        <h2>Detection Scene — {emp.id}</h2>
        <p className="hint" style={{ marginBottom: 10 }}>
          {hasFame
            ? <>Drag a box around the person you want to use, then click <strong>Convert</strong> or <strong>Merge</strong>.</>
            : "No detection frame stored for this record."}
        </p>

        {hasFame && (
          <div style={{ position: "relative", display: "block", cursor: "crosshair", userSelect: "none" }}>
            <img
              ref={imgRef}
              src={`data:image/jpeg;base64,${emp.detection_frame}`}
              alt="detection scene"
              style={{ width: "100%", display: "block", borderRadius: 8, border: "1px solid #e2e8f0" }}
              onLoad={() => setImgLoaded(true)}
              draggable={false}
            />
            <canvas
              ref={canvasRef}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", borderRadius: 8 }}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onMouseLeave={onMouseUp}
            />
          </div>
        )}

        {/* Crop preview + status */}
        {cropPreview ? (
          <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 12,
                        padding: "10px 14px", background: "#fffbeb", borderRadius: 8, border: "1px solid #fde68a" }}>
            <img src={`data:image/jpeg;base64,${cropPreview}`} alt="crop preview"
              style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 6, border: "1px solid #fcd34d" }} />
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, color: "#92400e" }}>✓ Person selected</div>
              <div style={{ fontSize: 12, color: "#92400e", marginTop: 2 }}>
                This crop will be used as the training photo. Click Convert or Merge below.
              </div>
            </div>
          </div>
        ) : hasFame && (
          <p style={{ marginTop: 8, fontSize: 12, color: "#94a3b8" }}>
            No selection yet — drag a box around the person above
          </p>
        )}

        <div className="modal-actions" style={{ marginTop: 16 }}>
          <button className="btn btn-outline" onClick={onClose}>Close</button>
          {emp.is_unknown && (
            <button
              className="btn btn-outline"
              style={{ color: "#2563eb", borderColor: "#bfdbfe" }}
              onClick={() => onConvert(cropPreview || null)}
            >
              {cropPreview ? "Convert with crop →" : "Convert (no crop) →"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
