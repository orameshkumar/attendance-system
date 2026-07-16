import { useLocation, useNavigate } from "react-router-dom";

const links = [
  { path: "/",          icon: "📋", label: "Attendance" },
  { path: "/employees", icon: "👤", label: "Employees"  },
  { path: "/reports",   icon: "📊", label: "Reports"    },
  { path: "/live",      icon: "📷", label: "Live View"  },
];

export default function Navbar() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        Attend<span>AI</span>
      </div>
      <nav>
        {links.map((l) => (
          <div
            key={l.path}
            className={`nav-link ${location.pathname === l.path ? "active" : ""}`}
            onClick={() => navigate(l.path)}
          >
            <span className="icon">{l.icon}</span>
            <span>{l.label}</span>
          </div>
        ))}
      </nav>
    </aside>
  );
}
