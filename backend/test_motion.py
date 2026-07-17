"""
Motion detection test — run this standalone to verify frame-diff is working.

Usage:
    python test_motion.py

Walk in front of the camera when prompted.
Saves to  snapshots_temp/
"""

import os, time, sys
import cv2
import numpy as np
from dotenv import load_dotenv

load_dotenv()
sys.path.insert(0, os.path.dirname(__file__))
import face_engine as fe

RTSP_URL = os.getenv("RTSP_URL", "rtsp://orameshkumar:orameshkumar@192.168.1.19:554/stream1")
OUT_DIR  = "snapshots_temp"
os.makedirs(OUT_DIR, exist_ok=True)

print(f"Connecting to: {RTSP_URL}")
cap = cv2.VideoCapture(RTSP_URL)
if not cap.isOpened():
    raise RuntimeError("Cannot open stream. Check RTSP_URL in .env")

# ── Capture frame A (prime MOG2 background model first) ───────────────────────
print("Priming background model with 10 frames…")
for _ in range(10):
    ret, f = cap.read()
    if ret:
        fe._mog2.apply(f)       # teach MOG2 what the empty scene looks like
        fe._prev_frame = f.copy()

ret, frame_a = cap.read()
assert ret, "Failed to read frame A"
cv2.imwrite(f"{OUT_DIR}/frame_A.jpg", frame_a)
print(f"  Frame A saved: {frame_a.shape[1]}×{frame_a.shape[0]}")

# ── Wait then capture frame B ─────────────────────────────────────────────────
WAIT = 4
print(f"\nWaiting {WAIT} seconds — walk in front of the camera now…")
time.sleep(WAIT)

for _ in range(3):
    cap.read()
ret, frame_b = cap.read()
assert ret, "Failed to read frame B"
cv2.imwrite(f"{OUT_DIR}/frame_B.jpg", frame_b)
print(f"  Frame B saved.")
cap.release()

# ── Run the exact same motion detection as main.py uses ──────────────────────
print("\nRunning motion detection (same logic as main.py)…")
regions = fe.detect_motion_regions(frame_b)

# Also save intermediate mask for debugging
mask_debug = fe._motion_mask.__wrapped__(frame_b) if hasattr(fe._motion_mask, '__wrapped__') else None

# Save the combined mask by re-computing it visually
diff_raw  = cv2.absdiff(frame_a, frame_b)
diff_gray = cv2.cvtColor(diff_raw, cv2.COLOR_BGR2GRAY)
_, raw_thresh = cv2.threshold(diff_gray, 20, 255, cv2.THRESH_BINARY)

# Amplified diff for visibility
diff_visible = cv2.convertScaleAbs(diff_raw, alpha=5.0)
cv2.imwrite(f"{OUT_DIR}/diff_raw.jpg", diff_visible)
cv2.imwrite(f"{OUT_DIR}/diff_mask_raw.jpg", raw_thresh)

changed_px = int(np.count_nonzero(diff_gray > 20))
pct = 100.0 * changed_px / diff_gray.size
print(f"\nPixel diff: {changed_px:,} pixels changed ({pct:.2f}%)")

# ── Draw MERGED bounding boxes (what main.py actually processes) ──────────────
annotated = frame_b.copy()
print(f"\nMerged motion regions ({len(regions)} found):")

for i, (crop, (x, y, w, h)) in enumerate(regions, 1):
    area = w * h
    print(f"  Region {i}: x={x} y={y} w={w} h={h}  area={area:,} px²")
    cv2.rectangle(annotated, (x, y), (x+w, y+h), (0, 255, 0), 3)
    label = f"Person? #{i}  {w}x{h}"
    cv2.putText(annotated, label, (x, max(y - 8, 20)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 255, 0), 2)
    # Save individual crop
    cv2.imwrite(f"{OUT_DIR}/motion_crop_{i}.jpg", crop)
    print(f"           → saved motion_crop_{i}.jpg")

if not regions:
    print("  None detected.")
    print(f"  Tip: lower MIN_MOTION_AREA (currently {fe.MIN_MOTION_AREA}) or increase wait time.")

cv2.imwrite(f"{OUT_DIR}/diff_boxes.jpg", annotated)

print(f"\nOutput files in  {OUT_DIR}/")
print("  frame_A.jpg          background (empty scene)")
print("  frame_B.jpg          after movement")
print("  diff_raw.jpg         amplified pixel difference")
print("  diff_mask_raw.jpg    raw binary threshold")
print("  diff_boxes.jpg       merged motion boxes (what main.py uses)")
print("  motion_crop_N.jpg    each detected region cropped out")
print(f"\nSummary: {len(regions)} region(s) detected from {pct:.2f}% pixel change.")
