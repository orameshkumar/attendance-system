import os
import numpy as np
from datetime import datetime, date, timedelta
from firebase_admin import firestore
from dotenv import load_dotenv

load_dotenv()

GAP_MINUTES    = int(os.getenv("GAP_MINUTES", 30))       # new session if gap > 30 min
RETENTION_DAYS = int(os.getenv("RETENTION_DAYS", 7))     # delete records older than 7 days


def _db():
    return firestore.client()


def load_all_employees():
    """Load all employees that have at least a face encoding OR body appearance."""
    employees = {}
    docs = _db().collection("employees").stream()
    for doc in docs:
        data = doc.to_dict()
        has_face       = bool(data.get("face_encoding"))
        has_appearance = bool(data.get("body_appearance"))
        if not (has_face or has_appearance):
            continue
        employees[doc.id] = {
            "name":       data.get("name", doc.id),
            "encoding":   np.array(data["face_encoding"])   if has_face       else np.array([]),
            "appearance": np.array(data["body_appearance"]) if has_appearance else np.array([]),
        }
    return employees


def get_unknown_count():
    docs = _db().collection("employees").where("is_unknown", "==", True).stream()
    return sum(1 for _ in docs)


def create_unknown_employee(img_path, appearance=None, detection_frame_b64=None):
    count = get_unknown_count() + 1
    emp_id = f"Unknown{str(count).zfill(3)}"
    snapshot_url = upload_snapshot(emp_id, img_path)
    doc = {
        "name": emp_id,
        "department": "",
        "face_encoding": [],
        "body_appearance": appearance.tolist() if appearance is not None else [],
        "face_snapshot_url": snapshot_url,
        "detection_frame": detection_frame_b64 or "",   # annotated scene image
        "is_unknown": True,
        "created_at": firestore.SERVER_TIMESTAMP,
    }
    _db().collection("employees").document(emp_id).set(doc)
    return emp_id, snapshot_url


def update_employee_encoding(emp_id, encoding: np.ndarray):
    _db().collection("employees").document(emp_id).update({
        "face_encoding": encoding.tolist()
    })


def upload_snapshot(emp_id, local_path):
    """Snapshot upload is a no-op until Firebase Storage is enabled."""
    return ""


def record_attendance(emp_id, snapshot_url):
    """
    Attendance rules:
      1. No record today → create new with in_time = out_time = now
      2. Latest record out_time > 30 min ago → create new record (new session)
      3. Latest record out_time within 30 min → update out_time only
    """
    today = date.today().isoformat()
    now   = datetime.now()
    db    = _db()

    # Get all records for today (simple two-field query, no composite index needed)
    docs = list(
        db.collection("attendance")
        .where("emp_id", "==", emp_id)
        .where("date", "==", today)
        .stream()
    )

    if not docs:
        # Rule 1 — no entry today, create fresh record
        db.collection("attendance").add({
            "emp_id":       emp_id,
            "date":         today,
            "in_time":      now.isoformat(),
            "out_time":     now.isoformat(),
            "snapshot_url": snapshot_url,
            "updated_at":   firestore.SERVER_TIMESTAMP,
        })
        return "created"

    # Find the record with the latest out_time in Python (no index required)
    latest = max(docs, key=lambda d: d.to_dict().get("out_time", ""))
    latest_data = latest.to_dict()
    last_out = datetime.fromisoformat(latest_data["out_time"])
    gap_seconds = (now - last_out).total_seconds()

    if gap_seconds > GAP_MINUTES * 60:
        # Rule 2 — gap > 30 min → new session record
        db.collection("attendance").add({
            "emp_id":       emp_id,
            "date":         today,
            "in_time":      now.isoformat(),
            "out_time":     now.isoformat(),
            "snapshot_url": snapshot_url,
            "updated_at":   firestore.SERVER_TIMESTAMP,
        })
        return "new_session"
    else:
        # Rule 3 — within 30 min → update out_time
        latest.reference.update({
            "out_time":   now.isoformat(),
            "updated_at": firestore.SERVER_TIMESTAMP,
        })
        return "updated"


def get_employees_needing_capture():
    """Return list of (doc_id, data) for employees awaiting frame capture."""
    docs = _db().collection("employees").where("needs_capture", "==", True).stream()
    return [(d.id, d.to_dict()) for d in docs]


def add_capture_frame(emp_id: str, b64_frame: str, total: int):
    """Append one captured frame. When total reached, mark capture complete."""
    ref = _db().collection("employees").document(emp_id)
    ref.update({"capture_frames": firestore.ArrayUnion([b64_frame])})
    # Check how many we have now
    snap = ref.get()
    frames = snap.to_dict().get("capture_frames", [])
    if len(frames) >= total:
        ref.update({
            "needs_capture":  False,
            "capture_ready":  True,
        })
        return True   # capture complete
    return False


def get_employees_needing_retraining():
    """Return list of (doc_id, data) for employees flagged needs_retraining=True."""
    docs = _db().collection("employees").where("needs_retraining", "==", True).stream()
    return [(d.id, d.to_dict()) for d in docs]


def save_retrained_encoding(emp_id: str, encoding, appearance=None):
    update = {
        "face_encoding":    encoding.tolist() if encoding is not None else [],
        "needs_retraining": False,
        "training_photos":  [],
        "retrained_at":     firestore.SERVER_TIMESTAMP,
    }
    if appearance is not None:
        update["body_appearance"] = appearance.tolist()
    _db().collection("employees").document(emp_id).update(update)


def load_config():
    """
    Load runtime config from Firestore settings/config.
    Returns a dict with all keys; falls back to env-var defaults if document missing.
    """
    snap = _db().collection("settings").document("config").get()
    if snap.exists:
        data = snap.to_dict()
    else:
        data = {}

    return {
        "cameras":           data.get("cameras",          []),
        "frame_interval":    int(data.get("frame_interval",   os.getenv("FRAME_INTERVAL_SECONDS", 3))),
        "face_threshold":    float(data.get("face_threshold",  os.getenv("MATCH_THRESHOLD", 0.60))),
        "appear_threshold":  float(data.get("appear_threshold", os.getenv("APPEAR_THRESHOLD", 0.75))),
        "debounce_seconds":  int(data.get("debounce_seconds",  30)),
        "capture_frames":    int(data.get("capture_frames",    10)),
        "gap_minutes":       int(data.get("gap_minutes",       GAP_MINUTES)),
        "retention_days":    int(data.get("retention_days",    RETENTION_DAYS)),
    }


def save_default_config(rtsp_url):
    """Write initial config to Firestore from env vars (first-run only)."""
    ref = _db().collection("settings").document("config")
    if ref.get().exists:
        return
    ref.set({
        "cameras": [
            {"id": "cam1", "name": "Main Camera", "url": rtsp_url, "enabled": True}
        ],
        "frame_interval":   int(os.getenv("FRAME_INTERVAL_SECONDS", 3)),
        "face_threshold":   float(os.getenv("MATCH_THRESHOLD", 0.60)),
        "appear_threshold": float(os.getenv("APPEAR_THRESHOLD", 0.75)),
        "debounce_seconds": 30,
        "capture_frames":   10,
        "gap_minutes":      GAP_MINUTES,
        "retention_days":   RETENTION_DAYS,
    })
    print("[CONFIG] Initial settings written to Firestore.")


def cleanup_old_records():
    """Delete attendance records with date older than RETENTION_DAYS."""
    cutoff = (date.today() - timedelta(days=RETENTION_DAYS)).isoformat()
    db = _db()
    old_docs = list(
        db.collection("attendance")
        .where("date", "<", cutoff)
        .stream()
    )
    for doc in old_docs:
        doc.reference.delete()
    if old_docs:
        print(f"[CLEANUP] Deleted {len(old_docs)} records older than {RETENTION_DAYS} days.")
    else:
        print(f"[CLEANUP] No old records to delete.")
