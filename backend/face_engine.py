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

SNAPSHOT_DIR = "snapshots_temp"
os.makedirs(SNAPSHOT_DIR, exist_ok=True)

# ── YOLO person detector (lazy load) ─────────────────────────────────────────
_yolo_model = None

def _yolo():
    global _yolo_model
    if _yolo_model is None:
        # yolov8n.pt is downloaded automatically on first run (~6 MB)
        _yolo_model = YOLO("yolov8n.pt")
    return _yolo_model


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
            # Clamp to frame boundaries
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(frame.shape[1], x2), min(frame.shape[0], y2)
            crop = frame[y1:y2, x1:x2]
            if crop.size == 0:
                continue
            persons.append((crop, (x1, y1, x2 - x1, y2 - y1)))
    return persons


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


# ── Training utilities ────────────────────────────────────────────────────────

def embedding_from_base64(b64_str: str):
    """Decode a base64 JPEG and return its ArcFace embedding, or None."""
    try:
        arr = np.frombuffer(base64.b64decode(b64_str), dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            return None
        return get_embedding(img)
    except Exception:
        return None


def appearance_from_base64(b64_str: str):
    """Decode a base64 JPEG and return its body appearance histogram, or None."""
    try:
        arr = np.frombuffer(base64.b64decode(b64_str), dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            return None
        return get_body_appearance(img)
    except Exception:
        return None


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
