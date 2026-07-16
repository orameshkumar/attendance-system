import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { getAuth } from "firebase/auth";

export const FIREBASE_CONFIGURED =
  import.meta.env.VITE_FIREBASE_API_KEY &&
  import.meta.env.VITE_FIREBASE_API_KEY !== "REPLACE_WITH_YOUR_API_KEY";

// Replace these values with your Firebase project config
// Firebase Console → Project Settings → Your Apps → Web App
const firebaseConfig = {
  apiKey: "AIzaSyCAu5qXePTx22QA13su3mSK7pGttpukBp8",
  authDomain: "orameshkumar-attendance.firebaseapp.com",
  projectId: "orameshkumar-attendance",
  storageBucket: "orameshkumar-attendance.firebasestorage.app",
  messagingSenderId: "780710148024",
  appId: "1:780710148024:web:0406775305e67b7a0a014d",
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const storage = getStorage(app);
export const auth = getAuth(app);
