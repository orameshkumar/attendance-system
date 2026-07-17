import { BrowserRouter, Routes, Route } from "react-router-dom";
import Navbar from "./components/Navbar";
import Attendance from "./pages/Attendance";
import Employees from "./pages/Employees";
import Reports from "./pages/Reports";
import LiveView from "./pages/LiveView";
import Settings from "./pages/Settings";
import "./index.css";

export default function App() {
  return (
    <BrowserRouter basename="/attendance-system">
      <div className="layout">
        <Navbar />
        <main className="main">
          <Routes>
            <Route path="/"          element={<Attendance />} />
            <Route path="/employees" element={<Employees />} />
            <Route path="/reports"   element={<Reports />} />
            <Route path="/live"      element={<LiveView />} />
            <Route path="/settings"  element={<Settings />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
