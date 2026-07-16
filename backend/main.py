import os
import time
import cv2
import firebase_admin
from firebase_admin import credentials, storage
from dotenv import load_dotenv

import face_engine as fe
import firebase_service as fs

load_dotenv()

RTSP_URL = os.getenv("RTSP_URL", "rtsp://orameshkumar:orameshkumar@192.168.1.19:554/stream1")
SERVICE_ACCOUNT_KEY = os.getenv("SERVICE_ACCOUNT_KEY", "serviceAccountKey.json")
STORAGE_BUCKET = os.getenv("FIREBASE_STORAGE_BUCKET", "orameshkumar-attendance.appspot.com")
FRAME_INTERVAL = int(os.getenv("FRAME_INTERVAL_SECONDS", 3))
MATCH_THRESHOLD = float(os.getenv("MATCH_THRESHOLD", 0.60))

# Initialize Firebase
cred = credentials.Certificate(SERVICE_ACCOUNT_KEY)
firebase_admin.initialize_app(cred, {"storageBucket": STORAGE_BUCKET})

print("Firebase connected.")
print(f"Connecting to stream: {RTSP_URL}")

cap = cv2.VideoCapture(RTSP_URL)
if not cap.isOpened():
    raise RuntimeError("Cannot connect to RTSP stream. Check URL and network.")

print("Stream connected. Starting attendance loop...\n")

# Cache employees in memory, refresh every 5 minutes
employees = {}
last_refresh = 0
REFRESH_INTERVAL = 300  # seconds

# Debounce: avoid logging same person repeatedly within 30 seconds
last_seen = {}
DEBOUNCE_SECONDS = 30

LIVE_FRAME_INTERVAL = 5   # upload live frame every 5 seconds
last_live_upload = 0

def upload_live_frame(frame):
    small = cv2.resize(frame, (320, 180))
    tmp = "snapshots_temp/live_current.jpg"
    cv2.imwrite(tmp, small, [cv2.IMWRITE_JPEG_QUALITY, 60])
    blob = storage.bucket().blob("live/current.jpg")
    blob.upload_from_filename(tmp, content_type="image/jpeg")
    blob.make_public()


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

    # Refresh employee list periodically
    if time.time() - last_refresh > REFRESH_INTERVAL:
        refresh_employees()

    # Upload live preview frame every 5 seconds
    if time.time() - last_live_upload >= LIVE_FRAME_INTERVAL:
        try:
            upload_live_frame(frame)
            last_live_upload = time.time()
        except Exception as e:
            print(f"[WARN] Live frame upload failed: {e}")

    faces = fe.detect_faces(frame)

    for face_img, bbox in faces:
        embedding = fe.get_embedding(face_img)
        if embedding is None:
            continue

        emp_id, score = fe.match_face(embedding, employees, MATCH_THRESHOLD)

        # Debounce check
        now = time.time()
        if emp_id and last_seen.get(emp_id, 0) > now - DEBOUNCE_SECONDS:
            continue
        if not emp_id and last_seen.get("unknown_block", 0) > now - DEBOUNCE_SECONDS:
            continue

        # Save face snapshot locally
        temp_path = fe.save_face_temp(face_img, prefix=emp_id or "unknown")

        if emp_id:
            snapshot_url = fs.upload_snapshot(emp_id, temp_path)
            fs.record_attendance(emp_id, snapshot_url)
            last_seen[emp_id] = now
            name = employees[emp_id]["name"]
            print(f"[MATCH]   {name} ({emp_id}) — score: {score:.2f}")
        else:
            new_id, snapshot_url = fs.create_unknown_employee(temp_path)
            # Build embedding for the new unknown
            fs.update_employee_encoding(new_id, embedding)
            fs.record_attendance(new_id, snapshot_url)
            # Add to local cache
            employees[new_id] = {"name": new_id, "encoding": embedding}
            last_seen["unknown_block"] = now
            print(f"[UNKNOWN] Created {new_id} — score: {score:.2f}")

    time.sleep(FRAME_INTERVAL)

cap.release()
