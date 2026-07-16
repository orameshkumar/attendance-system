# Attendance System

Automatic facial recognition attendance using CCTV, Firebase, and a React dashboard.

## Architecture

```
CCTV (Realme Smart Cam 360)
  └─► Python Backend (laptop)   ←→   Firebase (Firestore + Storage)
                                          ↕
                              React Dashboard (GitHub Pages)
                         https://orameshkumar.github.io/attendance-system
```

## Project Structure

```
attendance-system/
├── backend/           Python face recognition + Firebase writer
├── dashboard/         React web dashboard (deployed to GitHub Pages)
├── .github/workflows/ Auto-deploy on push to main
└── .gitignore         Excludes serviceAccountKey.json
```

## Setup

### 1. Firebase
1. Go to [Firebase Console](https://console.firebase.google.com)
2. Create project: `orameshkumar-attendance`
3. Enable **Firestore**, **Storage**, and **Authentication**
4. Project Settings → Service Accounts → **Generate New Private Key**
5. Save as `backend/serviceAccountKey.json` (never commit this file)
6. Project Settings → Your Apps → Add Web App → copy config to `dashboard/src/firebase.js`

### 2. Python Backend
```bash
cd backend
pip install -r requirements.txt
cp .env.example .env          # fill in your values
python main.py
```

### 3. Dashboard (local dev)
```bash
cd dashboard
npm install
npm run dev
```

### 4. GitHub Pages (auto-deploy)
1. Push to GitHub: `git push origin main`
2. GitHub Actions builds and deploys automatically
3. Go to repo **Settings → Pages → Source: gh-pages branch**
4. Live at: `https://orameshkumar.github.io/attendance-system`

## Firestore Collections

| Collection   | Fields |
|---|---|
| `employees`  | id, name, department, face_encoding[], face_snapshot_url, is_unknown |
| `attendance` | emp_id, date, in_time, out_time, snapshot_url |

## Environment Variables (backend/.env)

```
RTSP_URL=rtsp://username:password@192.168.1.x:554/stream1
FIREBASE_STORAGE_BUCKET=orameshkumar-attendance.appspot.com
SERVICE_ACCOUNT_KEY=serviceAccountKey.json
MATCH_THRESHOLD=0.60
FRAME_INTERVAL_SECONDS=3
```
