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
    employees = {}
    docs = _db().collection("employees").stream()
    for doc in docs:
        data = doc.to_dict()
        if data.get("face_encoding"):
            employees[doc.id] = {
                "name": data.get("name", doc.id),
                "encoding": np.array(data["face_encoding"]),
            }
    return employees


def get_unknown_count():
    docs = _db().collection("employees").where("is_unknown", "==", True).stream()
    return sum(1 for _ in docs)


def create_unknown_employee(face_img_path):
    count = get_unknown_count() + 1
    emp_id = f"Unknown{str(count).zfill(3)}"
    snapshot_url = upload_snapshot(emp_id, face_img_path)
    _db().collection("employees").document(emp_id).set({
        "name": emp_id,
        "department": "",
        "face_encoding": [],
        "face_snapshot_url": snapshot_url,
        "is_unknown": True,
        "created_at": firestore.SERVER_TIMESTAMP,
    })
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

    # Get only the latest record for today (ordered by out_time desc, limit 1)
    docs = list(
        db.collection("attendance")
        .where("emp_id", "==", emp_id)
        .where("date", "==", today)
        .order_by("out_time", direction=firestore.Query.DESCENDING)
        .limit(1)
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

    # This is already the latest record
    latest = docs[0]
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
