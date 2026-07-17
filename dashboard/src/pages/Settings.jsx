import { useEffect, useState } from "react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "../firebase";

const DEFAULT_CONFIG = {
  cameras: [
    { id: "cam1", name: "Main Camera", url: "", enabled: true },
  ],
  frame_interval:    3,
  face_threshold:    0.60,
  appear_threshold:  0.75,
  debounce_seconds:  30,
  capture_frames:    10,
  gap_minutes:       30,
  retention_days:    7,
};

export default function Settings() {
  const [config,  setConfig]  = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [camModal, setCamModal] = useState(null); // null | { cam, index } | "new"

  useEffect(() => { loadConfig(); }, []);

  async function loadConfig() {
    setLoading(true);
    const snap = await getDoc(doc(db, "settings", "config"));
    setConfig(snap.exists() ? { ...DEFAULT_CONFIG, ...snap.data() } : { ...DEFAULT_CONFIG });
    setLoading(false);
  }

  async function saveConfig() {
    setSaving(true);
    await setDoc(doc(db, "settings", "config"), config);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  function setField(key, value) {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }

  function saveCam(cam, index) {
    setConfig((prev) => {
      const cams = [...prev.cameras];
      if (index === "new") cams.push({ ...cam, id: `cam${Date.now()}` });
      else cams[index] = cam;
      return { ...prev, cameras: cams };
    });
    setCamModal(null);
  }

  function deleteCam(index) {
    if (!window.confirm("Remove this camera?")) return;
    setConfig((prev) => {
      const cams = prev.cameras.filter((_, i) => i !== index);
      return { ...prev, cameras: cams };
    });
  }

  function toggleCam(index) {
    setConfig((prev) => {
      const cams = [...prev.cameras];
      cams[index] = { ...cams[index], enabled: !cams[index].enabled };
      return { ...prev, cameras: cams };
    });
  }

  if (loading) return <div className="loading">Loading settings…</div>;

  return (
    <div>
      <div className="page-header">
        <h1>Settings</h1>
        <p>Configure camera feeds and detection parameters</p>
      </div>

      {/* ── Camera feeds ─────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Camera Feeds</div>
            <div style={{ fontSize: 13, color: "#64748b", marginTop: 2 }}>
              RTSP / HTTP streams the backend will monitor
            </div>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => setCamModal({ cam: { name: "", url: "", enabled: true }, index: "new" })}>
            + Add Camera
          </button>
        </div>

        {config.cameras.length === 0 ? (
          <div className="empty" style={{ padding: "20px 0" }}>No cameras configured — add one above.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Stream URL</th>
                  <th>Status</th>
                  <th style={{ width: 120 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {config.cameras.map((cam, i) => (
                  <tr key={cam.id || i}>
                    <td style={{ fontWeight: 600 }}>{cam.name || "—"}</td>
                    <td>
                      <span style={{ fontFamily: "monospace", fontSize: 12, color: "#475569" }}>
                        {cam.url || <span style={{ color: "#94a3b8" }}>not set</span>}
                      </span>
                    </td>
                    <td>
                      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={cam.enabled}
                          onChange={() => toggleCam(i)}
                        />
                        <span className={`badge ${cam.enabled ? "present" : "absent"}`}>
                          {cam.enabled ? "Enabled" : "Disabled"}
                        </span>
                      </label>
                    </td>
                    <td style={{ display: "flex", gap: 6 }}>
                      <button
                        className="btn btn-sm btn-outline"
                        onClick={() => setCamModal({ cam: { ...cam }, index: i })}
                      >
                        Edit
                      </button>
                      <button
                        className="btn btn-sm btn-outline"
                        style={{ color: "#dc2626", borderColor: "#fca5a5" }}
                        onClick={() => deleteCam(i)}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Detection parameters ──────────────────────────── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>Detection Parameters</div>
        <div style={{ fontSize: 13, color: "#64748b", marginBottom: 16 }}>
          Controls how the backend processes each camera frame
        </div>

        <div className="field-row">
          <SettingField
            label="Frame Interval (seconds)"
            hint="How often the backend samples a frame from the stream"
            type="number" min={1} max={30} step={1}
            value={config.frame_interval}
            onChange={(v) => setField("frame_interval", Number(v))}
          />
          <SettingField
            label="Capture Frames per Employee"
            hint="Number of frames collected when a new employee walks past"
            type="number" min={3} max={30} step={1}
            value={config.capture_frames}
            onChange={(v) => setField("capture_frames", Number(v))}
          />
        </div>

        <div className="field-row">
          <SettingField
            label="Face Match Threshold"
            hint="Lower = stricter face matching (0.0 – 1.0)"
            type="number" min={0.3} max={0.95} step={0.05}
            value={config.face_threshold}
            onChange={(v) => setField("face_threshold", Number(v))}
          />
          <SettingField
            label="Appearance Match Threshold"
            hint="Lower = stricter body/clothing matching (0.0 – 1.0)"
            type="number" min={0.3} max={0.95} step={0.05}
            value={config.appear_threshold}
            onChange={(v) => setField("appear_threshold", Number(v))}
          />
        </div>
      </div>

      {/* ── Attendance rules ─────────────────────────────── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>Attendance Rules</div>
        <div style={{ fontSize: 13, color: "#64748b", marginBottom: 16 }}>
          Controls when records are created vs. extended
        </div>

        <div className="field-row">
          <SettingField
            label="Debounce (seconds)"
            hint="Ignore re-detections of the same person within this window"
            type="number" min={5} max={300} step={5}
            value={config.debounce_seconds}
            onChange={(v) => setField("debounce_seconds", Number(v))}
          />
          <SettingField
            label="Session Gap (minutes)"
            hint="Gap longer than this creates a new attendance record"
            type="number" min={5} max={240} step={5}
            value={config.gap_minutes}
            onChange={(v) => setField("gap_minutes", Number(v))}
          />
        </div>

        <div className="field-row">
          <SettingField
            label="Retention (days)"
            hint="Attendance records older than this are automatically deleted"
            type="number" min={1} max={365} step={1}
            value={config.retention_days}
            onChange={(v) => setField("retention_days", Number(v))}
          />
          <div /> {/* spacer */}
        </div>
      </div>

      {/* ── Save button ──────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <button className="btn btn-primary" onClick={saveConfig} disabled={saving}>
          {saving ? "Saving…" : "Save Settings"}
        </button>
        {saved && (
          <span style={{ color: "#16a34a", fontSize: 13, fontWeight: 600 }}>
            ✓ Saved — backend will apply changes within {config.frame_interval * 2 || 10} seconds
          </span>
        )}
      </div>

      {/* ── Camera modal ─────────────────────────────────── */}
      {camModal && (
        <CameraModal
          cam={camModal.cam}
          index={camModal.index}
          onSave={saveCam}
          onClose={() => setCamModal(null)}
        />
      )}
    </div>
  );
}

/* ── Reusable field ──────────────────────────────────────────── */
function SettingField({ label, hint, value, onChange, ...inputProps }) {
  return (
    <div className="field">
      <label>{label}</label>
      <input
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...inputProps}
        style={{ width: "100%" }}
      />
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

/* ── Camera add/edit modal ───────────────────────────────────── */
function CameraModal({ cam, index, onSave, onClose }) {
  const [name,    setName]    = useState(cam.name    || "");
  const [url,     setUrl]     = useState(cam.url     || "");
  const [enabled, setEnabled] = useState(cam.enabled ?? true);
  const [error,   setError]   = useState("");

  function handleSave() {
    if (!name.trim()) { setError("Camera name is required"); return; }
    if (!url.trim())  { setError("Stream URL is required"); return; }
    onSave({ ...cam, name: name.trim(), url: url.trim(), enabled }, index);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{index === "new" ? "Add Camera" : "Edit Camera"}</h2>

        <div className="field">
          <label>Camera Name *</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Front Door" autoFocus />
        </div>

        <div className="field">
          <label>Stream URL *</label>
          <input
            className="input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="rtsp://user:pass@192.168.1.x:554/stream1"
            style={{ fontFamily: "monospace", fontSize: 13 }}
          />
          <p className="hint">
            RTSP: <code>rtsp://user:pass@ip:554/stream1</code><br />
            HTTP: <code>http://ip:8080/video</code><br />
            Local webcam: <code>0</code> (or 1, 2 for additional cameras)
          </p>
        </div>

        <div className="field">
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enable this camera
          </label>
        </div>

        {error && <p style={{ color: "#dc2626", fontSize: 13, marginBottom: 8 }}>{error}</p>}

        <div className="modal-actions">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave}>
            {index === "new" ? "Add Camera" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
