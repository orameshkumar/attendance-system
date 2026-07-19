import { useRef, useState, useEffect } from "react";

export default function FrameCropModal({ index, b64, onConfirm, onCancel }) {
  const canvasRef   = useRef();
  const imgRef      = useRef();
  const [drag,      setDrag]      = useState(null);
  const [rect,      setRect]      = useState(null);
  const [imgLoaded, setImgLoaded] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const img    = imgRef.current;
    if (!canvas || !img || !imgLoaded) return;
    const r = canvas.getBoundingClientRect();
    canvas.width  = r.width;
    canvas.height = r.height;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const sel = drag || rect;
    if (!sel) return;
    const { x0, y0, x1, y1 } = normalize(sel);
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth   = 2;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.fillStyle = "rgba(37,99,235,0.12)";
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }, [drag, rect, imgLoaded]);

  function normalize({ x0, y0, x1, y1 }) {
    return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
  }

  function getPos(e) {
    const r = canvasRef.current.getBoundingClientRect();
    const src = e.touches ? e.touches[0] || e.changedTouches[0] : e;
    return { x: src.clientX - r.left, y: src.clientY - r.top };
  }

  function onMouseDown(e) {
    const p = getPos(e);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    setRect(null);
  }

  function onMouseMove(e) {
    if (!drag) return;
    const p = getPos(e);
    setDrag((d) => ({ ...d, x1: p.x, y1: p.y }));
  }

  function onMouseUp() {
    if (!drag) return;
    const n = normalize(drag);
    if (n.x1 - n.x0 > 10 && n.y1 - n.y0 > 10) setRect(drag);
    setDrag(null);
  }

  function onTouchStart(e) {
    e.preventDefault();
    const p = getPos(e);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    setRect(null);
  }

  function onTouchMove(e) {
    e.preventDefault();
    if (!drag) return;
    const p = getPos(e);
    setDrag((d) => ({ ...d, x1: p.x, y1: p.y }));
  }

  function onTouchEnd(e) {
    e.preventDefault();
    if (!drag) return;
    const n = normalize(drag);
    if (n.x1 - n.x0 > 10 && n.y1 - n.y0 > 10) setRect(drag);
    setDrag(null);
  }

  function cropAndConfirm() {
    if (!rect) return;
    const img    = imgRef.current;
    const canvas = canvasRef.current;
    const br     = canvas.getBoundingClientRect();
    const scaleX = img.naturalWidth  / br.width;
    const scaleY = img.naturalHeight / br.height;
    const { x0, y0, x1, y1 } = normalize(rect);
    const sx = x0 * scaleX, sy = y0 * scaleY;
    const sw = (x1 - x0) * scaleX, sh = (y1 - y0) * scaleY;
    const out = document.createElement("canvas");
    out.width  = Math.min(sw, 200);
    out.height = Math.round(sh * (out.width / sw));
    out.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, out.width, out.height);
    onConfirm(index, out.toDataURL("image/jpeg", 0.8).split(",")[1]);
  }

  return (
    <div
      className="modal-overlay"
      style={{ zIndex: 200 }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <h2 style={{ marginBottom: 8 }}>Crop Person from Frame</h2>
        <p className="hint" style={{ marginBottom: 12 }}>
          Drag a box around the person, then click <strong>Use crop</strong>.
        </p>
        <div style={{ position: "relative", display: "inline-block", maxWidth: "100%", cursor: "crosshair" }}>
          <img
            ref={imgRef}
            src={`data:image/jpeg;base64,${b64}`}
            alt="frame"
            style={{ width: "100%", display: "block", borderRadius: 6, border: "1px solid #e2e8f0" }}
            onLoad={() => setImgLoaded(true)}
            draggable={false}
          />
          <canvas
            ref={canvasRef}
            style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", touchAction: "none" }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
          />
        </div>
        {rect
          ? <p className="hint" style={{ marginTop: 8, color: "#16a34a" }}>✓ Selection ready — click <strong>Use crop</strong> to apply</p>
          : <p className="hint" style={{ marginTop: 8 }}>Click and drag to draw a selection box</p>
        }
        <div className="modal-actions">
          <button className="btn btn-outline" onClick={onCancel}>Back</button>
          <button className="btn btn-primary" onClick={cropAndConfirm} disabled={!rect}>✂ Use crop</button>
        </div>
      </div>
    </div>
  );
}
