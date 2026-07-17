"""
Detection pipeline
──────────────────
Primary   : YOLOv8 person detector  → works from any angle including top-down
Secondary : ArcFace face embedding  → high accuracy when face is visible
Fallback  : Body appearance (HSV color histogram of head+torso region)
            → used when camera angle hides the face

For each detected person both scores are computed;
the highest confidence one wins.
"""

import base64
import os

import cv2
import numpy as np
from deepface import DeepFace
from ultralytics import YOLO

SNAPSHOT_DIR    = "snapshots_temp"
MIN_MOTION_AREA = int(os.getenv("MIN_MOTION_AREA", 15000))  # px² — real person at typical distance
os.makedirs(SNAPSHOT_DIR, exist_ok=True)

# ── Background subtractor (MOG2) ──────────────────────────────────────────────
# history=200 frames, varThreshold=40 — sensitive enough to catch slow movers
_mog2 = cv2.createBackgroundSubtractorMOG2(
    history=200, varThreshold=40, detectShadows=False
)

# Keep previous frame for absdiff fallback
_prev_frame = None   # np.ndarray or None

# ── YOLO person detector (lazy load) ─────────────────────────────────────────
_yolo_model = None

def _yolo():
    global _yolo_model
    if _yolo_model is None:
        # yolov8n.pt is downloaded automatically on first run (~6 MB)
        _yolo_model = YOLO("yolov8n.pt")
    return _yolo_model


# ── Motion detection ──────────────────────────────────────────────────────────

def _motion_mask(frame: np.ndarray) -> np.ndarray:
    """
    Combine MOG2 + frame-diff, then aggressively fill gaps so that all
    scattered blobs from one moving person merge into a single solid region.

    Key insight from camera output: diff detects edge fragments (head outline,
    arm edges, leg edges separately). We need large morphological kernels to
    bridge those gaps — for a person 300–500px tall, gap can be 60–120px.
    """
    global _prev_frame

    fh, fw = frame.shape[:2]

    # ── MOG2 foreground mask ────────────────────────────────────────────
    mog_mask = _mog2.apply(frame)

    # ── Frame-difference mask ───────────────────────────────────────────
    if _prev_frame is not None:
        diff  = cv2.absdiff(_prev_frame, frame)
        gray  = cv2.cvtColor(diff, cv2.COLOR_BGR2GRAY)
        _, diff_mask = cv2.threshold(gray, 20, 255, cv2.THRESH_BINARY)
    else:
        diff_mask = np.zeros((fh, fw), dtype=np.uint8)

    _prev_frame = frame.copy()

    # ── Combine both signals ─────────────────────────────────────────────
    combined = cv2.bitwise_or(mog_mask, diff_mask)

    # ── Step 1: small open to remove single-pixel noise ─────────────────
    k_noise = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    combined = cv2.morphologyEx(combined, cv2.MORPH_OPEN, k_noise, iterations=1)

    # ── Step 2: large CLOSE to fill gaps between body-part fragments ─────
    # Gap size scales with frame width: ~6% of width bridges arm-to-torso gaps
    gap_px = max(20, int(fw * 0.06))   # ~115px for 1920-wide frame
    k_fill = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (gap_px, gap_px))
    combined = cv2.morphologyEx(combined, cv2.MORPH_CLOSE, k_fill, iterations=3)

    # ── Step 3: dilate to expand each region into a solid body-sized blob ─
    k_expand = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
    combined = cv2.dilate(combined, k_expand, iterations=2)

    return combined


def detect_motion_regions(frame: np.ndarray):
    """
    Detect moving objects by comparing against background and previous frame.
    Merges nearby blobs into coherent bounding boxes.
    Returns list of (crop, (x, y, w, h)) for each significant motion region.
    """
    mask = _motion_mask(frame)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    regions = []
    for cnt in contours:
        if cv2.contourArea(cnt) < MIN_MOTION_AREA:
            continue
        x, y, w, h = cv2.boundingRect(cnt)
        # Clamp
        fh, fw = frame.shape[:2]
        x, y = max(0, x), max(0, y)
        w, h = min(w, fw - x), min(h, fh - y)
        if w < 20 or h < 20:
            continue
        crop = frame[y:y+h, x:x+w]
        if crop.size == 0:
            continue
        regions.append((crop, (x, y, w, h)))

    # Merge overlapping / touching regions into one bounding box
    return _merge_overlapping(frame, regions)


def _iou(a, b) -> float:
    """Intersection-over-union of two (x,y,w,h) boxes."""
    ax1, ay1, ax2, ay2 = a[0], a[1], a[0]+a[2], a[1]+a[3]
    bx1, by1, bx2, by2 = b[0], b[1], b[0]+b[2], b[1]+b[3]
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    if inter == 0:
        return 0.0
    union = a[2]*a[3] + b[2]*b[3] - inter
    return inter / union if union > 0 else 0.0


def _merge_overlapping(frame, regions, iou_thresh=0.05):
    """
    Merge nearby / touching regions.
    Gap threshold scales with frame width so it works at any resolution.
    """
    fw = frame.shape[1]
    gap = max(60, int(fw * 0.08))   # ~154px for 1920-wide frame

    boxes = [r[1] for r in regions]
    merged = True
    while merged:
        merged = False
        result = []
        used   = [False] * len(boxes)
        for i, a in enumerate(boxes):
            if used[i]:
                continue
            x1, y1, x2, y2 = a[0], a[1], a[0]+a[2], a[1]+a[3]
            for j, b in enumerate(boxes):
                if i == j or used[j]:
                    continue
                if _iou(a, b) > iou_thresh or _boxes_close(a, b, gap=gap):
                    x1 = min(x1, b[0]);      y1 = min(y1, b[1])
                    x2 = max(x2, b[0]+b[2]); y2 = max(y2, b[1]+b[3])
                    used[j] = True
                    merged = True
            result.append((x1, y1, x2 - x1, y2 - y1))
            used[i] = True
        boxes = result

    out = []
    for (x, y, w, h) in boxes:
        if w * h < MIN_MOTION_AREA:
            continue
        crop = frame[y:y+h, x:x+w]
        if crop.size > 0:
            out.append((crop, (x, y, w, h)))
    return out


def _boxes_close(a, b, gap=40) -> bool:
    """Return True if two boxes are within `gap` pixels of each other."""
    ax1, ay1, ax2, ay2 = a[0], a[1], a[0]+a[2], a[1]+a[3]
    bx1, by1, bx2, by2 = b[0], b[1], b[0]+b[2], b[1]+b[3]
    dx = max(0, max(ax1, bx1) - min(ax2, bx2))
    dy = max(0, max(ay1, by1) - min(ay2, by2))
    return dx < gap and dy < gap


# ── Person detection ──────────────────────────────────────────────────────────

def detect_persons(frame):
    """
    Detect all people in the frame using YOLOv8.
    Returns list of (person_crop, (x, y, w, h)).
    Works reliably from front, side, and top-down camera angles.
    """
    results = _yolo()(frame, classes=[0], verbose=False)  # class 0 = person
    persons = []
    for r in results:
        for box in r.boxes:
            conf = float(box.conf[0])
            if conf < 0.40:
                continue
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(frame.shape[1], x2), min(frame.shape[0], y2)
            crop = frame[y1:y2, x1:x2]
            if crop.size == 0:
                continue
            persons.append((crop, (x1, y1, x2 - x1, y2 - y1)))
    return persons


def merge_detections(yolo_persons, motion_regions, overlap_thresh=0.20):
    """
    Combine YOLO and motion detections.
    Any motion region NOT covered by a YOLO box is added as an extra candidate.
    This catches people YOLO missed (partial body, unusual angle, fast movement).
    Returns list of (crop, bbox, source) where source is 'yolo' or 'motion'.
    """
    candidates = [(crop, bbox, "yolo") for crop, bbox in yolo_persons]

    for m_crop, m_box in motion_regions:
        covered = any(_iou(m_box, y_box) > overlap_thresh for _, y_box, _ in candidates)
        if not covered:
            candidates.append((m_crop, m_box, "motion"))

    return candidates


# ── Face recognition ──────────────────────────────────────────────────────────

def get_face_embedding(person_crop):
    """
    Try to find a face in the person crop and return its ArcFace embedding.
    Returns None if no face is detected or embedding fails.
    """
    try:
        result = DeepFace.represent(
            person_crop,
            model_name="ArcFace",
            enforce_detection=True,       # raises if no face found
            detector_backend="opencv",    # fast, handles partial faces
        )
        return np.array(result[0]["embedding"])
    except Exception:
        return None


def get_embedding(face_img):
    """Direct embedding from a cropped face image (used during retraining)."""
    try:
        result = DeepFace.represent(
            face_img,
            model_name="ArcFace",
            enforce_detection=False,
            detector_backend="skip",
        )
        return np.array(result[0]["embedding"])
    except Exception:
        return None


# ── Body appearance (top-angle fallback) ──────────────────────────────────────

def get_body_appearance(person_crop):
    """
    Build a compact HSV color histogram from the upper 60% of the person crop
    (head + torso region visible from top/overhead cameras).

    Returns a 1-D float32 numpy array (288 bins = 18 hue × 16 sat).
    """
    h = person_crop.shape[0]
    upper = person_crop[: max(1, int(h * 0.6))]
    if upper.size == 0:
        return None
    try:
        hsv = cv2.cvtColor(upper, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], None, [18, 16], [0, 180, 0, 256])
        cv2.normalize(hist, hist, norm_type=cv2.NORM_L2)
        return hist.flatten().astype(np.float32)
    except Exception:
        return None


def appearance_similarity(a, b):
    """Cosine similarity between two appearance histograms."""
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


# ── Cosine similarity (used for face embeddings too) ─────────────────────────

def cosine_similarity(a, b):
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


# ── Matching ──────────────────────────────────────────────────────────────────

def match_person(face_emb, appearance, employees: dict, face_thresh=0.60, appear_thresh=0.75):
    """
    Match a detected person against all known employees.

    Tries face embedding first (higher accuracy), falls back to body appearance.
    Returns (emp_id, score, method) where method is 'face' or 'appearance',
    or (None, best_score, method) if no match exceeds the threshold.
    """
    best_id    = None
    best_score = 0.0
    best_method = "none"

    for emp_id, data in employees.items():
        # ── Face match ──
        if face_emb is not None and len(data.get("encoding", [])) > 0:
            score = cosine_similarity(face_emb, data["encoding"])
            if score > best_score:
                best_score = score
                best_id = emp_id
                best_method = "face"

        # ── Appearance match ──
        if appearance is not None and len(data.get("appearance", [])) > 0:
            score = appearance_similarity(appearance, data["appearance"])
            # Appearance is less discriminative — require higher threshold
            if score > best_score and score >= appear_thresh:
                best_score = score
                best_id = emp_id
                best_method = "appearance"

    # Check if winner cleared its threshold
    if best_method == "face"       and best_score >= face_thresh:
        return best_id, best_score, best_method
    if best_method == "appearance" and best_score >= appear_thresh:
        return best_id, best_score, best_method

    return None, best_score, best_method


def find_best_unknown_match(face_emb, appearance, employees: dict, min_score=0.60):
    """
    Among employees flagged is_unknown=True, find the best match above min_score.
    Used to re-identify an unknown person seen before so we update their
    attendance end time instead of creating a duplicate unknown record.
    Returns (emp_id, score, method) or (None, 0.0, 'none').
    """
    best_id     = None
    best_score  = 0.0
    best_method = "none"

    for emp_id, data in employees.items():
        if not data.get("is_unknown"):
            continue

        if face_emb is not None and len(data.get("encoding", [])) > 0:
            score = cosine_similarity(face_emb, data["encoding"])
            if score > best_score:
                best_score  = score
                best_id     = emp_id
                best_method = "face"

        if appearance is not None and len(data.get("appearance", [])) > 0:
            score = appearance_similarity(appearance, data["appearance"])
            if score > best_score:
                best_score  = score
                best_id     = emp_id
                best_method = "appearance"

    if best_score >= min_score:
        return best_id, best_score, best_method
    return None, best_score, best_method


# ── Training utilities ────────────────────────────────────────────────────────

def decode_b64_image(b64_str: str):
    """Decode a base64 JPEG/PNG string into a BGR numpy image, or None."""
    try:
        arr = np.frombuffer(base64.b64decode(b64_str), dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        return img  # may be None if decode fails
    except Exception:
        return None


def _extract_face_crop(img):
    """
    Try to find a face inside img using two strategies:
      1. DeepFace with OpenCV detector (handles partial/angled faces)
      2. Haar cascade fallback
    Returns the face crop (BGR), or None if no face found.
    """
    # Strategy 1: DeepFace detector — returns bounding box
    try:
        results = DeepFace.extract_faces(
            img,
            detector_backend="opencv",
            enforce_detection=True,
            align=True,
        )
        if results:
            face_arr = results[0]["face"]          # float 0-1, RGB
            face_bgr = cv2.cvtColor(
                (face_arr * 255).astype(np.uint8), cv2.COLOR_RGB2BGR
            )
            return face_bgr
    except Exception:
        pass

    # Strategy 2: Haar cascade
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    cascade = cv2.CascadeClassifier(cascade_path)
    dets = cascade.detectMultiScale(gray, 1.1, 4, minSize=(30, 30))
    if len(dets) > 0:
        x, y, w, h = dets[0]
        return img[y:y+h, x:x+w]

    return None


def embeddings_from_b64(b64_str: str):
    """
    From a base64 training image (person crop or uploaded photo):
      - Extract the face sub-region if visible → ArcFace embedding
      - Use the full image for body appearance histogram

    Returns (face_embedding | None, appearance | None).
    """
    img = decode_b64_image(b64_str)
    if img is None:
        return None, None

    # Body appearance — always from the full crop
    appearance = get_body_appearance(img)

    # Face embedding — only from the detected face sub-region
    face_crop = _extract_face_crop(img)
    if face_crop is not None and face_crop.size > 0:
        face_emb = get_embedding(face_crop)
    else:
        face_emb = None   # top-angle frame with no visible face — appearance only

    return face_emb, appearance


def average_embeddings(embeddings: list) -> np.ndarray:
    """Return the L2-normalised mean of a list of numpy arrays."""
    stacked = np.stack(embeddings, axis=0)
    mean = stacked.mean(axis=0)
    norm = np.linalg.norm(mean)
    return mean / norm if norm > 0 else mean


# ── Temp snapshot ─────────────────────────────────────────────────────────────

def save_face_temp(img, prefix="person") -> str:
    path = os.path.join(SNAPSHOT_DIR, f"{prefix}_temp.jpg")
    cv2.imwrite(path, img)
    return path
