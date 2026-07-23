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

SERVICE_ACCOUNT_KEY = os.getenv("SERVICE_ACCOUNT_KEY", "serviceAccountKey.json")
RTSP_URL_ENV        = os.getenv("RTSP_URL", "rtsp://orameshkumar:orameshkumar@192.168.1.19:554/stream1")

# Initialize Firebase
cred = credentials.Certificate(SERVICE_ACCOUNT_KEY)
firebase_admin.initialize_app(cred)
print("Firebase connected.")

# Write default config to Firestore on first run (uses env-var RTSP_URL as seed)
fs.save_default_config(RTSP_URL_ENV)

# ── Load config from Firestore ──────────────────────────────────
cfg              = fs.load_config()
FRAME_INTERVAL   = cfg["frame_interval"]
FACE_THRESHOLD   = cfg["face_threshold"]
APPEAR_THRESHOLD = cfg["appear_threshold"]
DEBOUNCE_SECONDS = cfg["debounce_seconds"]
CAPTURE_FRAMES   = cfg["capture_frames"]

def active_camera_url():
    """Return URL of first enabled camera, or env-var fallback."""
    for cam in cfg.get("cameras", []):
        if cam.get("enabled") and cam.get("url"):
            url = cam["url"].strip()
            # Allow "0", "1" etc. as local webcam indexes
            return int(url) if url.isdigit() else url
    return RTSP_URL_ENV

current_cam_url = active_camera_url()
print(f"Connecting to stream: {current_cam_url}")
cap = cv2.VideoCapture(current_cam_url)
if not cap.isOpened():
    raise RuntimeError("Cannot connect to camera. Check URL/network in Settings.")

print("Stream connected. Starting attendance loop...\n")

employees        = {}
last_refresh     = 0
last_live_upload = 0
last_cleanup     = 0
last_retrain     = 0
last_config_check = 0
last_seen        = {}   # emp_id → timestamp, debounce duplicate records
capture_targets  = {}   # emp_id → last_capture_ts, employees awaiting frame capture

REFRESH_INTERVAL      = 300    # reload employee cache every 5 min
LIVE_INTERVAL         = 5      # upload live preview frame every 5 sec
CLEANUP_INTERVAL      = 3600   # delete old attendance records every 1 hour
RETRAIN_INTERVAL      = 60     # check retraining queue every 60 sec
CONFIG_CHECK_INTERVAL = 30     # re-read Firestore config every 30 sec


def apply_config(new_cfg):
    """Apply a freshly loaded config dict to global runtime vars."""
    global cfg, FRAME_INTERVAL, FACE_THRESHOLD, APPEAR_THRESHOLD
    global DEBOUNCE_SECONDS, CAPTURE_FRAMES, cap, current_cam_url

    cfg              = new_cfg
    FRAME_INTERVAL   = cfg["frame_interval"]
    FACE_THRESHOLD   = cfg["face_threshold"]
    APPEAR_THRESHOLD = cfg["appear_threshold"]
    DEBOUNCE_SECONDS = cfg["debounce_seconds"]
    CAPTURE_FRAMES   = cfg["capture_frames"]

    new_url = active_camera_url()
    if new_url != current_cam_url:
        print(f"[CONFIG] Camera URL changed → {new_url}. Reconnecting…")
        cap.release()
        cap = cv2.VideoCapture(new_url)
        current_cam_url = new_url
        if not cap.isOpened():
            print(f"[WARN] Cannot open new camera URL: {new_url}")
        else:
            print(f"[CONFIG] Reconnected to {new_url}")


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
    global capture_targets
    pending = fs.get_employees_needing_capture()
    capture_targets = {emp_id: capture_targets.get(emp_id, 0) for emp_id, _ in pending}
    if pending:
        names = [f"{d.get('name', eid)} ({eid})" for eid, d in pending]
        print(f"[CAPTURE] Watching for: {', '.join(names)}")


def save_capture_frame(emp_id: str, person_crop):
    resized = cv2.resize(person_crop, (200, 200))
    _, buf = cv2.imencode(".jpg", resized, [cv2.IMWRITE_JPEG_QUALITY, 80])
    b64 = __import__("base64").b64encode(buf).decode("utf-8")
    done = fs.add_capture_frame(emp_id, b64, CAPTURE_FRAMES)
    return done


def run_retraining():
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


def _annotated_frame_b64(frame, bbox, label="Motion detected"):
    x, y, w, h = bbox
    vis = frame.copy()
    cv2.rectangle(vis, (x, y), (x + w, y + h), (0, 255, 0), 3)
    cv2.putText(vis, label, (x, max(y - 8, 20)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)
    small = cv2.resize(vis, (320, 180))
    _, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 55])
    return base64.b64encode(buf).decode("utf-8")


def _process_candidate(person_crop, bbox, source, now, frame=None):
    x, y, w, h = bbox

    face_emb = fe.get_face_embedding(person_crop)
    print(f"[DETECT]  source={source} bbox=({x},{y},{w}×{h}) "
          f"face={'yes' if face_emb is not None else 'no'}")

    appearance = fe.get_body_appearance(person_crop)
    if appearance is None:
        print(f"[DETECT]  appearance extraction failed — crop too small?  size={person_crop.shape}")
        return

    # Check against ignored objects before doing any matching or recording
    ign_id, ign_score, ign_method = fe.find_ignored_match(face_emb, appearance, employees)
    if ign_id:
        print(f"[IGNORE]  matched ignored record {ign_id} via {ign_method} score={ign_score:.2f} — skipping")
        return

    emp_id, score, method = fe.match_person(
        face_emb, appearance, employees,
        face_thresh=FACE_THRESHOLD,
        appear_thresh=APPEAR_THRESHOLD,
    )
    print(f"[DETECT]  match={'FOUND: ' + emp_id if emp_id else 'none'} "
          f"method={method} score={score:.3f}")

    # Fallback: try known employees at relaxed 60% threshold before treating as unknown
    if emp_id is None:
        emp_id, score, method = fe.find_best_known_match(
            face_emb, appearance, employees, min_score=0.60
        )
        if emp_id:
            print(f"[DETECT]  relaxed-match FOUND: {emp_id} via {method} score={score:.3f}")

    if emp_id:
        if emp_id in capture_targets:
            last_cap = capture_targets.get(emp_id, 0)
            if now - last_cap >= 2:
                try:
                    done = save_capture_frame(emp_id, person_crop)
                    capture_targets[emp_id] = now
                    if done:
                        del capture_targets[emp_id]
                        print(f"[CAPTURE] {emp_id} — {CAPTURE_FRAMES} frames captured. Ready for review.")
                    else:
                        print(f"[CAPTURE] {emp_id} — frame saved…")
                except Exception as e:
                    print(f"[WARN] Capture frame failed for {emp_id}: {e}")

        if last_seen.get(emp_id, 0) > now - DEBOUNCE_SECONDS:
            print(f"[DETECT]  skipped (debounce) — {emp_id}")
            return

        last_seen[emp_id] = now
        print(f"[RECORD]  recording attendance for {emp_id}…")
        snapshot_url = fs.upload_snapshot(emp_id, fe.save_face_temp(person_crop, emp_id))
        result = fs.record_attendance(emp_id, snapshot_url)
        print(f"[MATCH]   {employees[emp_id]['name']} ({emp_id}) "
              f"via {method} [{source}] score={score:.2f} → {result}")

    else:
        # ── Try re-matching against existing unknowns at 60% threshold ──────
        unk_id, unk_score, unk_method = fe.find_best_unknown_match(
            face_emb, appearance, employees, min_score=0.60
        )

        if unk_id:
            # Seen this unknown before — just update their attendance end time
            if last_seen.get(unk_id, 0) > now - DEBOUNCE_SECONDS:
                print(f"[DETECT]  skipped (debounce) — existing unknown {unk_id}")
                return
            last_seen[unk_id] = now
            snapshot_url = fs.upload_snapshot(unk_id, fe.save_face_temp(person_crop, unk_id))
            result = fs.record_attendance(unk_id, snapshot_url)
            print(f"[UNKNOWN] Re-matched {unk_id} via {unk_method} [{source}] "
                  f"score={unk_score:.2f} → {result}")
            return

        # ── Truly new unknown — check position debounce then create ─────────
        pos_key = f"unk_{x//80}_{y//80}"
        if last_seen.get(pos_key, 0) > now - DEBOUNCE_SECONDS:
            print(f"[DETECT]  skipped (debounce) — position {pos_key}")
            return

        last_seen[pos_key] = now

        det_frame_b64 = _annotated_frame_b64(frame, bbox, f"Detected [{source}]") if frame is not None else None
        top_matches   = fe.find_top_matches(face_emb, appearance, employees)

        print(f"[RECORD]  creating unknown employee… top matches: {[m['name'] + ' ' + str(m['score']) + '%' for m in top_matches]}")
        temp_path = fe.save_face_temp(person_crop, "unknown")
        new_id, snapshot_url = fs.create_unknown_employee(temp_path, appearance, det_frame_b64, top_matches)
        print(f"[RECORD]  created {new_id}, recording attendance…")

        if face_emb is not None:
            fs.update_employee_encoding(new_id, face_emb)

        result = fs.record_attendance(new_id, snapshot_url)
        employees[new_id] = {
            "name":       new_id,
            "encoding":   face_emb if face_emb is not None else [],
            "appearance": appearance,
            "is_unknown": True,
        }
        method_str = "face+appearance" if face_emb is not None else "appearance only"
        print(f"[UNKNOWN] {new_id} via {method_str} [{source}] → {result}")


refresh_employees()
refresh_capture_targets()

while True:
    ret, frame = cap.read()
    if not ret:
        print("[WARN] Frame read failed. Reconnecting...")
        cap.release()
        time.sleep(3)
        cap = cv2.VideoCapture(current_cam_url)
        continue

    now = time.time()

    # Periodic: reload config from Firestore (picks up Settings page changes)
    if now - last_config_check >= CONFIG_CHECK_INTERVAL:
        try:
            new_cfg = fs.load_config()
            apply_config(new_cfg)
            last_config_check = now
        except Exception as e:
            print(f"[WARN] Config reload failed: {e}")

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
            refresh_capture_targets()
        except Exception as e:
            print(f"[WARN] Retraining failed: {e}")
        last_retrain = now

    if now - last_cleanup >= CLEANUP_INTERVAL:
        try:
            fs.cleanup_old_records()
        except Exception as e:
            print(f"[WARN] Cleanup failed: {e}")
        last_cleanup = now

    yolo_persons   = fe.detect_persons(frame)
    motion_regions = fe.detect_motion_regions(frame)
    candidates     = fe.merge_detections(yolo_persons, motion_regions)

    if motion_regions and not yolo_persons:
        print(f"[MOTION]  {len(motion_regions)} moving region(s) detected, YOLO found 0 persons — using motion fallback.")

    for person_crop, bbox, source in candidates:
        try:
            _process_candidate(person_crop, bbox, source, now, frame=frame)
        except Exception as e:
            print(f"[ERROR] Candidate processing failed ({source}): {e}")
            import traceback; traceback.print_exc()

    time.sleep(FRAME_INTERVAL)

cap.release()
