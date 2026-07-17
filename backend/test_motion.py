"""
Motion detection test — run this standalone to verify frame-diff is working.

Usage:
    python test_motion.py

Saves to  snapshots_temp/
    frame_A.jpg        — first captured frame
    frame_B.jpg        — second captured frame (3 sec later)
    diff_raw.jpg       — raw pixel difference (bright = changed)
    diff_mask.jpg      — binary motion mask after threshold
    diff_mog2.jpg      — MOG2 foreground mask
    diff_combined.jpg  — combined mask (what the system actually uses)
    diff_boxes.jpg     — original frame with bounding boxes drawn on it

Also prints:
    - number of motion regions found
    - bounding box of each region
    - total changed pixel count
"""

import os, time
import cv2
import numpy as np
from dotenv import load_dotenv

load_dotenv()

RTSP_URL = os.getenv("RTSP_URL", "rtsp://orameshkumar:orameshkumar@192.168.1.19:554/stream1")
OUT_DIR  = "snapshots_temp"
os.makedirs(OUT_DIR, exist_ok=True)

DIFF_THRESHOLD  = 20     # pixel brightness change to count as "moved"
MIN_MOTION_AREA = 2500   # px² — minimum blob size to report

print(f"Connecting to: {RTSP_URL}")
cap = cv2.VideoCapture(RTSP_URL)
if not cap.isOpened():
    raise RuntimeError("Cannot open stream. Check RTSP_URL in .env")

# ── Capture frame A ───────────────────────────────────────────────────────────
print("Capturing frame A…")
for _ in range(5):          # flush buffer
    cap.read()
ret, frame_a = cap.read()
assert ret, "Failed to read frame A"
cv2.imwrite(f"{OUT_DIR}/frame_A.jpg", frame_a)
print(f"  Frame A: {frame_a.shape[1]}×{frame_a.shape[0]}")

# ── Wait then capture frame B ─────────────────────────────────────────────────
WAIT = 4
print(f"Waiting {WAIT} seconds — walk in front of the camera now…")
time.sleep(WAIT)

for _ in range(3):
    cap.read()
ret, frame_b = cap.read()
assert ret, "Failed to read frame B"
cv2.imwrite(f"{OUT_DIR}/frame_B.jpg", frame_b)
print(f"  Frame B: {frame_b.shape[1]}×{frame_b.shape[0]}")

cap.release()

# ── Compute frame difference ──────────────────────────────────────────────────
diff_raw  = cv2.absdiff(frame_a, frame_b)
diff_gray = cv2.cvtColor(diff_raw, cv2.COLOR_BGR2GRAY)

changed_pixels = int(np.count_nonzero(diff_gray > DIFF_THRESHOLD))
total_pixels   = diff_gray.size
pct = 100.0 * changed_pixels / total_pixels
print(f"\nPixel-level diff:")
print(f"  Changed pixels (>{DIFF_THRESHOLD} brightness): {changed_pixels:,} / {total_pixels:,}  ({pct:.2f}%)")

# Amplify for visibility
diff_visible = cv2.convertScaleAbs(diff_raw, alpha=5.0)
cv2.imwrite(f"{OUT_DIR}/diff_raw.jpg", diff_visible)

# Binary threshold mask
_, diff_mask = cv2.threshold(diff_gray, DIFF_THRESHOLD, 255, cv2.THRESH_BINARY)

# Morphological cleanup
kernel   = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
diff_mask = cv2.morphologyEx(diff_mask, cv2.MORPH_CLOSE, kernel, iterations=2)
diff_mask = cv2.morphologyEx(diff_mask, cv2.MORPH_OPEN,  kernel, iterations=1)
diff_mask = cv2.dilate(diff_mask, kernel, iterations=2)
cv2.imwrite(f"{OUT_DIR}/diff_mask.jpg", diff_mask)

# ── MOG2 ─────────────────────────────────────────────────────────────────────
mog2 = cv2.createBackgroundSubtractorMOG2(history=200, varThreshold=40, detectShadows=False)
for frame in [frame_a, frame_b]:
    mog_mask = mog2.apply(frame)
cv2.imwrite(f"{OUT_DIR}/diff_mog2.jpg", mog_mask)

# Combined
combined = cv2.bitwise_or(diff_mask, mog_mask)
cv2.imwrite(f"{OUT_DIR}/diff_combined.jpg", combined)

# ── Find and draw bounding boxes ──────────────────────────────────────────────
contours, _ = cv2.findContours(combined, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
annotated    = frame_b.copy()
regions_found = 0

print(f"\nMotion regions (>{MIN_MOTION_AREA} px²):")
for cnt in contours:
    area = cv2.contourArea(cnt)
    if area < MIN_MOTION_AREA:
        continue
    x, y, w, h = cv2.boundingRect(cnt)
    regions_found += 1
    print(f"  Region {regions_found}: x={x} y={y} w={w} h={h}  area={int(area):,} px²")
    cv2.rectangle(annotated, (x, y), (x+w, y+h), (0, 255, 0), 3)
    cv2.putText(annotated, f"Motion {regions_found} ({int(area):,}px)",
                (x, max(y-8, 16)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)

if regions_found == 0:
    print("  None — no movement detected or area too small.")
    print(f"  Tip: lower MIN_MOTION_AREA below {MIN_MOTION_AREA} or increase wait time.")

cv2.imwrite(f"{OUT_DIR}/diff_boxes.jpg", annotated)

print(f"\nSaved outputs to  {OUT_DIR}/")
print("  frame_A.jpg       first frame")
print("  frame_B.jpg       second frame (after wait)")
print("  diff_raw.jpg      amplified pixel difference")
print("  diff_mask.jpg     binary motion mask")
print("  diff_mog2.jpg     MOG2 foreground mask")
print("  diff_combined.jpg combined mask (what the system uses)")
print("  diff_boxes.jpg    frame B with motion boxes drawn in green")
print(f"\nSummary: {regions_found} motion region(s) found, {pct:.2f}% pixels changed.")
