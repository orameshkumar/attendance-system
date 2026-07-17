import os
import time
import base64
import cv2
import firebase_admin
from firebase_admin import credentials, firestore as _fs
from dotenv import load_dotenv

import face_engine as fe
import firebase_service as fs

load_dotenv()

RTSP_URL          = os.getenv("RTSP_URL", "rtsp://orameshkumar:orameshkumar@192.168.1.19:554/stream1")
SERVICE_ACCOUNT_KEY = os.getenv("SERVICE_ACCOUNT_KEY", "serviceAccountKey.json")
FRAME_INTERVAL    = int(os.getenv("FRAME_INTERVAL_SECONDS", 3))
FACE_THRESHOLD    = float(os.getenv("MATCH_THRESHOLD", 0.60))
APPEAR_THRESHOLD  = float(os.getenv("APPEAR_THRESHOLD", 0.75))

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
last_retrain     = 0
last_seen        = {}   # emp_id → timestamp, debounce duplicate records
capture_targets  = {}   # emp_id → last_capture_ts, employees awaiting frame capture
CAPTURE_FRAMES   = 10   # how many frames to collect per employee

REFRESH_INTERVAL  = 300    # reload employee cache every 5 min
LIVE_INTERVAL     = 5      # upload live preview frame every 5 sec
CLEANUP_INTERVAL  = 3600   # delete old attendance records every 1 hour
RETRAIN_INTERVAL  = 60     # check retraining queue every 60 sec
DEBOUNCE_SECONDS  = 30     # ignore same person within 30 sec
CAPTURE_GAP       = 2      # seconds between capture frames for same person


def upload_live_frame(frame):
    small = cv2.resize(frame, (320, 180))
    _, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 40])
    b64 = base64.b64encode(buf).decode("utf-8")
    _fs.client().collection("live").document("current").set({
        "frame": b64,
        "ts": _fs.SERVER_TIMESTAMP,
    })


def refresh_employees():
    global employees, last_refresh
    employees = fs.load_all_employees()
    last_refresh = time.time()
    print(f"[INFO] Loaded {len(employees)} employee profiles.")


def refresh_capture_targets():
    """Reload which employees are waiting for frame capture."""
    global capture_targets
    pending = fs.get_employees_needing_capture()
    capture_targets = {emp_id: capture_targets.get(emp_id, 0) for emp_id, _ in pending}
    if pending:
        names = [f"{d.get('name', eid)} ({eid})" for eid, d in pending]
        print(f"[CAPTURE] Watching for: {', '.join(names)}")


def save_capture_frame(emp_id: str, person_crop):
    """Resize person crop to 200×200 and store as base64 in Firestore."""
    resized = cv2.resize(person_crop, (200, 200))
    _, buf = cv2.imencode(".jpg", resized, [cv2.IMWRITE_JPEG_QUALITY, 80])
    b64 = __import__("base64").b64encode(buf).decode("utf-8")
    done = fs.add_capture_frame(emp_id, b64, CAPTURE_FRAMES)
    return done


def run_retraining():
    """
    Process employees with new training photos.
    For each photo:
      - Extract the face sub-region (if visible) → ArcFace embedding
      - Use the full person crop → body appearance histogram
    Average all valid embeddings and save back to Firestore.
    """
    global employees
    pending = fs.get_employees_needing_retraining()
    if not pending:
        return
    for emp_id, data in pending:
        photos = data.get("training_photos", [])
        if not photos:
            continue

        face_embeddings = []
        appear_features = []
        faces_found     = 0

        for p in photos:
            face_emb, appearance = fe.embeddings_from_b64(p)
            if face_emb is not None:
                face_embeddings.append(face_emb)
                faces_found += 1
            if appearance is not None:
                appear_features.append(appearance)

        avg_face       = fe.average_embeddings(face_embeddings) if face_embeddings else None
        avg_appearance = fe.average_embeddings(appear_features) if appear_features else None

        fs.save_retrained_encoding(emp_id, avg_face, avg_appearance)

        name = data.get("name", emp_id)
        face_str   = f"{faces_found}/{len(photos)} faces extracted" if faces_found else "no face visible (top-angle only)"
        appear_str = f"{len(appear_features)} appearance features"
        print(f"[RETRAIN] {name} ({emp_id}) — {face_str}, {appear_str} → saved.")

    refresh_employees()


refresh_employees()
refresh_capture_targets()

while True:
    ret, frame = cap.read()
    if not ret:
        print("[WARN] Frame read failed. Reconnecting...")
        cap.release()
        time.sleep(3)
        cap = cv2.VideoCapture(RTSP_URL)
        continue

    now = time.time()

    # Periodic tasks
    if now - last_refresh > REFRESH_INTERVAL:
        refresh_employees()

    if now - last_live_upload >= LIVE_INTERVAL:
        try:
            upload_live_frame(frame)
            last_live_upload = now
        except Exception as e:
            print(f"[WARN] Live frame upload failed: {e}")

    if now - last_retrain >= RETRAIN_INTERVAL:
        try:
            run_retraining()
            refresh_capture_targets()   # pick up any newly converted employees
        except Exception as e:
            print(f"[WARN] Retraining failed: {e}")
        last_retrain = now

    if now - last_cleanup >= CLEANUP_INTERVAL:
        try:
            fs.cleanup_old_records()
        except Exception as e:
            print(f"[WARN] Cleanup failed: {e}")
        last_cleanup = now

    # ── Detect all persons in this frame ────────────────────────────────────
    # Layer 1: YOLO — accurate when person is clearly visible
    yolo_persons   = fe.detect_persons(frame)

    # Layer 2: Motion detection — catches anyone YOLO missed
    #          (partial body, unusual angle, fast movement, top-angle occlusion)
    motion_regions = fe.detect_motion_regions(frame)

    # Merge: motion regions not already covered by a YOLO box become candidates
    candidates = fe.merge_detections(yolo_persons, motion_regions)

    if motion_regions and not yolo_persons:
        print(f"[MOTION]  {len(motion_regions)} moving region(s) detected, YOLO found 0 persons — using motion fallback.")

    for person_crop, bbox, source in candidates:

        # Extract face embedding (may be None for top-angle views)
        face_emb = fe.get_face_embedding(person_crop)

        # Extract body appearance (always available as long as person is detected)
        appearance = fe.get_body_appearance(person_crop)

        # Match against known employees
        emp_id, score, method = fe.match_person(
            face_emb, appearance, employees,
            face_thresh=FACE_THRESHOLD,
            appear_thresh=APPEAR_THRESHOLD,
        )

        if emp_id:
            # ── Frame capture for newly converted employees ──────────────────
            if emp_id in capture_targets:
                last_cap = capture_targets.get(emp_id, 0)
                if now - last_cap >= CAPTURE_GAP:
                    try:
                        done = save_capture_frame(emp_id, person_crop)
                        capture_targets[emp_id] = now
                        if done:
                            del capture_targets[emp_id]
                            print(f"[CAPTURE] {emp_id} — {CAPTURE_FRAMES} frames captured. Ready for review.")
                        else:
                            count = list(capture_targets.keys()).index(emp_id) if emp_id in capture_targets else "?"
                            print(f"[CAPTURE] {emp_id} — frame saved…")
                    except Exception as e:
                        print(f"[WARN] Capture frame failed for {emp_id}: {e}")

            # Known employee — debounce attendance record
            if last_seen.get(emp_id, 0) > now - DEBOUNCE_SECONDS:
                continue

            snapshot_url = fs.upload_snapshot(emp_id, fe.save_face_temp(person_crop, emp_id))
            fs.record_attendance(emp_id, snapshot_url)
            last_seen[emp_id] = now
            print(f"[MATCH]   {employees[emp_id]['name']} ({emp_id}) "
                  f"via {method} [{source}] — score: {score:.2f}")

        else:
            # Unknown person — debounce using a position-based key
            x, y, w, h = bbox
            pos_key = f"unk_{x//80}_{y//80}"   # grid cell ~80px, avoids re-creating same person
            if last_seen.get(pos_key, 0) > now - DEBOUNCE_SECONDS:
                continue

            temp_path = fe.save_face_temp(person_crop, "unknown")
            new_id, snapshot_url = fs.create_unknown_employee(temp_path, appearance)

            # Try to get face embedding for the new unknown too
            if face_emb is not None:
                fs.update_employee_encoding(new_id, face_emb)

            fs.record_attendance(new_id, snapshot_url)
            employees[new_id] = {
                "name": new_id,
                "encoding": face_emb if face_emb is not None else [],
                "appearance": appearance if appearance is not None else [],
            }
            last_seen[pos_key] = now
            method_str = "face+appearance" if face_emb is not None else "appearance only"
            print(f"[UNKNOWN] Created {new_id} via {method_str} [{source}] — score: {score:.2f}")

    time.sleep(FRAME_INTERVAL)

cap.release()
