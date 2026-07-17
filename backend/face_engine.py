import base64
import cv2
import numpy as np
import os
from deepface import DeepFace

# Use OpenCV Haar cascade — no TensorFlow dependency for detection
_cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
_face_cascade = cv2.CascadeClassifier(_cascade_path)

SNAPSHOT_DIR = "snapshots_temp"
os.makedirs(SNAPSHOT_DIR, exist_ok=True)


def detect_faces(frame):
    """Return list of (cropped_face, bbox) tuples."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    detections = _face_cascade.detectMultiScale(
        gray, scaleFactor=1.1, minNeighbors=5, minSize=(80, 80)
    )
    faces = []
    if len(detections) == 0:
        return faces
    for (x, y, w, h) in detections:
        face_crop = frame[y:y+h, x:x+w]
        if face_crop.size == 0:
            continue
        faces.append((face_crop, (x, y, w, h)))
    return faces


def get_embedding(face_img):
    """Generate ArcFace embedding for a face image."""
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


def cosine_similarity(a, b):
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


def match_face(embedding, employees: dict, threshold: float = 0.60):
    """
    Compare embedding against all known employees.
    Returns (emp_id, score) if match found, else (None, best_score).
    """
    best_id = None
    best_score = 0.0
    for emp_id, data in employees.items():
        enc = data["encoding"]
        if len(enc) == 0:
            continue
        score = cosine_similarity(embedding, enc)
        if score > best_score:
            best_score = score
            best_id = emp_id
    if best_score >= threshold:
        return best_id, best_score
    return None, best_score


def save_face_temp(face_img, prefix="face") -> str:
    path = os.path.join(SNAPSHOT_DIR, f"{prefix}_temp.jpg")
    cv2.imwrite(path, face_img)
    return path


def embedding_from_base64(b64_str: str):
    """Decode a base64 JPEG and return its ArcFace embedding, or None on failure."""
    try:
        img_bytes = base64.b64decode(b64_str)
        arr = np.frombuffer(img_bytes, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            return None
        return get_embedding(img)
    except Exception:
        return None


def average_embeddings(embeddings: list) -> np.ndarray:
    """Return the L2-normalised mean of a list of embeddings."""
    stacked = np.stack(embeddings, axis=0)
    mean = stacked.mean(axis=0)
    norm = np.linalg.norm(mean)
    return mean / norm if norm > 0 else mean
