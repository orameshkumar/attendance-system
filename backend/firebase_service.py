import os
import numpy as np
from datetime import datetime, date
from firebase_admin import firestore, storage
from dotenv import load_dotenv

load_dotenv()


def _db():
    return firestore.client()

def _bucket():
    return storage.bucket()


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
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    blob_path = f"snapshots/{emp_id}/{timestamp}.jpg"
    blob = _bucket().blob(blob_path)
    blob.upload_from_filename(local_path, content_type="image/jpeg")
    blob.make_public()
    return blob.public_url


def record_attendance(emp_id, snapshot_url):
    today = date.today().isoformat()
    now = datetime.now()
    query = (
        _db().collection("attendance")
        .where("emp_id", "==", emp_id)
        .where("date", "==", today)
        .limit(1)
        .stream()
    )
    existing = list(query)
    if not existing:
        _db().collection("attendance").add({
            "emp_id": emp_id,
            "date": today,
            "in_time": now.isoformat(),
            "out_time": now.isoformat(),
            "snapshot_url": snapshot_url,
            "updated_at": firestore.SERVER_TIMESTAMP,
        })
    else:
        existing[0].reference.update({
            "out_time": now.isoformat(),
            "updated_at": firestore.SERVER_TIMESTAMP,
        })
