import os
import time
import base64
import cv2
import firebase_admin
from firebase_admin import credentials, firestore as _fs
from dotenv import load_dotenv
from datetime import datetime, timezone, timedelta

import face_engine as fe
import firebase_service as fs

load_dotenv()

RTSP_URL          = os.getenv("RTSP_URL", "rtsp://orameshkumar:orameshkumar@192.168.1.19:554/stream1")
SERVICE_ACCOUNT_KEY = os.getenv("SERVICE_ACCOUNT_KEY", "serviceAccountKey.json")
FRAME_INTERVAL    = int(os.getenv("FRAME_INTERVAL_SECONDS", 3))
MATCH_THRESHOLD   = float(os.getenv("MATCH_THRESHOLD", 0.60))
RETENTION_HOURS   = int(os.getenv("RETENTION_HOURS", 2))

# Initialize Firebase
cred = credentials.Certificate(SERVICE_ACCOUNT_KEY)
firebase_admin.initialize_app(cred)

print("Firebase connected.")
print(f"Connecting to stream: {RTSP_URL}")

cap = cv2.VideoCapture(RTSP_URL)
if not cap.isOpened():
    raise RuntimeError("Cannot connect to RTSP stream. Check URL and network.")

print("Stream connected. Starting attendance loop...\n")

employees        = {}
last_refresh     = 0
last_live_upload = 0
last_cleanup     = 0
last_seen        = {}

REFRESH_INTERVAL = 300   # refresh employee cache every 5 min
LIVE_INTERVAL    = 5     # upload live frame every 5 sec
CLEANUP_INTERVAL = 3600  # run cleanup every 1 hour


def upload_live_frame(frame):
    small = cv2.resize(frame, (320, 180))
    _, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 40])
    b64 = base64.b64encode(buf).decode("utf-8")
    _fs.client().collection("live").document("current").set({
        "frame": b64,
        "ts": _fs.SERVER_TIMESTAMP,
    })


def consolidate_attendance():
    """
    Every 2 hours: group all attendance records by emp_id + date,
    merge into one record (first in_time, last out_time),
    delete the originals, write one consolidated record.
    """
    db = _fs.client()
    docs = list(db.collection("attendance").stream())

    if not docs:
        return

    # Group by emp_id + date
    groups = {}
    for doc in docs:
        data = doc.to_dict()
        key = f"{data.get('emp_id')}_{data.get('date')}"
        if key not in groups:
            groups[key] = {"docs": [], "emp_id": data.get("emp_id"),
                           "date": data.get("date"),
                           "in_time": data.get("in_time"),
                           "out_time": data.get("out_time"),
                           "snapshot_url": data.get("snapshot_url", "")}
        else:
            # Keep earliest in_time and latest out_time
            if data.get("in_time") and data["in_time"] < groups[key]["in_time"]:
                groups[key]["in_time"] = data["in_time"]
            if data.get("out_time") and data["out_time"] > groups[key]["out_time"]:
                groups[key]["out_time"] = data["out_time"]
        groups[key]["docs"].append(doc)

    consolidated = 0
    for key, group in groups.items():
        if len(group["docs"]) <= 1:
            continue  # nothing to merge
        # Delete all individual records
        for doc in group["docs"]:
            doc.reference.delete()
        # Write one merged record
        db.collection("attendance").add({
            "emp_id":       group["emp_id"],
            "date":         group["date"],
            "in_time":      group["in_time"],
            "out_time":     group["out_time"],
            "snapshot_url": group["snapshot_url"],
            "consolidated": True,
            "updated_at":   _fs.SERVER_TIMESTAMP,
        })
        consolidated += 1

    if consolidated:
        print(f"[CONSOLIDATE] Merged {consolidated} employee-day records.")
    else:
        print(f"[CONSOLIDATE] Nothing to merge.")


def refresh_employees():
    global employees, last_refresh
    employees = fs.load_all_employees()
    last_refresh = time.time()
    print(f"[INFO] Loaded {len(employees)} employee encodings.")


refresh_employees()

while True:
    ret, frame = cap.read()
    if not ret:
        print("[WARN] Frame read failed. Reconnecting...")
        cap.release()
        time.sleep(3)
        cap = cv2.VideoCapture(RTSP_URL)
        continue

    now = time.time()

    # Refresh employee list periodically
    if now - last_refresh > REFRESH_INTERVAL:
        refresh_employees()

    # Upload live preview frame
    if now - last_live_upload >= LIVE_INTERVAL:
        try:
            upload_live_frame(frame)
            last_live_upload = now
        except Exception as e:
            print(f"[WARN] Live frame upload failed: {e}")

    # Consolidate attendance records every 2 hours
    if now - last_cleanup >= CLEANUP_INTERVAL:
        try:
            consolidate_attendance()
        except Exception as e:
            print(f"[WARN] Consolidation failed: {e}")
        last_cleanup = now

    faces = fe.detect_faces(frame)

    for face_img, bbox in faces:
        embedding = fe.get_embedding(face_img)
        if embedding is None:
            continue

        emp_id, score = fe.match_face(embedding, employees, MATCH_THRESHOLD)

        if emp_id and last_seen.get(emp_id, 0) > now - 30:
            continue
        if not emp_id and last_seen.get("unknown_block", 0) > now - 30:
            continue

        temp_path = fe.save_face_temp(face_img, prefix=emp_id or "unknown")

        if emp_id:
            snapshot_url = fs.upload_snapshot(emp_id, temp_path)
            fs.record_attendance(emp_id, snapshot_url)
            last_seen[emp_id] = now
            print(f"[MATCH]   {employees[emp_id]['name']} ({emp_id}) — score: {score:.2f}")
        else:
            new_id, snapshot_url = fs.create_unknown_employee(temp_path)
            fs.update_employee_encoding(new_id, embedding)
            fs.record_attendance(new_id, snapshot_url)
            employees[new_id] = {"name": new_id, "encoding": []}
            last_seen["unknown_block"] = now
            print(f"[UNKNOWN] Created {new_id} — score: {score:.2f}")

    time.sleep(FRAME_INTERVAL)

cap.release()
