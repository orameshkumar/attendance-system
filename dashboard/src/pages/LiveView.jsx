import { useEffect, useState, useRef } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";

export default function LiveView() {
  const [imgSrc, setImgSrc]     = useState(null);
  const [lastSeen, setLastSeen] = useState(null);
  const [error, setError]       = useState(null);
  const unsubRef                = useRef(null);

  useEffect(() => {
    unsubRef.current = onSnapshot(
      doc(db, "live", "current"),
      (snap) => {
        if (snap.exists()) {
          const data = snap.data();
          setImgSrc(`data:image/jpeg;base64,${data.frame}`);
          setLastSeen(new Date().toLocaleTimeString());
          setError(null);
        } else {
          setError("No live feed yet — make sure the Python backend is running.");
        }
      },
      () => setError("Failed to connect to live feed.")
    );
    return () => unsubRef.current && unsubRef.current();
  }, []);

  return (
    <div>
      <div className="page-header">
        <h1>Live View</h1>
        <p>Camera feed — updates every 5 seconds</p>
      </div>

      <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
        <div className="card" style={{ flex: "0 0 auto" }}>
          <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{
              width: 10, height: 10, borderRadius: "50%",
              background: error ? "#ef4444" : "#22c55e",
              display: "inline-block",
              boxShadow: error ? "none" : "0 0 6px #22c55e",
            }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: error ? "#ef4444" : "#16a34a" }}>
              {error ? "Offline" : imgSrc ? "Live" : "Connecting…"}
            </span>
            <span style={{ fontSize: 12, color: "#94a3b8", marginLeft: "auto" }}>
              {lastSeen ? `Updated: ${lastSeen}` : ""}
            </span>
          </div>

          {error ? (
            <div style={{
              width: 320, height: 180, background: "#1e293b", borderRadius: 8,
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "#64748b", fontSize: 13, textAlign: "center", padding: 16,
            }}>
              {error}
            </div>
          ) : imgSrc ? (
            <img
              src={imgSrc}
              alt="Live camera feed"
              style={{ width: 320, height: 180, borderRadius: 8, objectFit: "cover", display: "block" }}
            />
          ) : (
            <div style={{
              width: 320, height: 180, background: "#f1f5f9", borderRadius: 8,
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "#94a3b8", fontSize: 13,
            }}>
              Waiting for first frame…
            </div>
          )}

          <div style={{ marginTop: 10, fontSize: 12, color: "#94a3b8", display: "flex", gap: 16 }}>
            <span>Resolution: 320 × 180</span>
            <span>Refresh: 5s</span>
          </div>
        </div>

        <div className="card" style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#64748b", marginBottom: 16 }}>Camera Info</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {[
              ["Camera",     "Realme Smart Cam 360"],
              ["Protocol",   "RTSP"],
              ["Source res", "1920 × 1080"],
              ["Preview",    "320 × 180 @ 40% quality"],
              ["Storage",    "Firestore (no Storage needed)"],
              ["Backend",    "Python + OpenCV"],
            ].map(([label, value]) => (
              <div key={label} style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                <span style={{ color: "#94a3b8" }}>{label}</span>
                <span style={{ fontWeight: 500, color: "#334155" }}>{value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
