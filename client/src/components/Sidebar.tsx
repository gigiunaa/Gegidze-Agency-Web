import { NavLink, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { useAuthStore } from '../stores/auth';
import styles from './Sidebar.module.css';

type NavItem = { path: string; label: string; icon: React.FC; roles?: string[] };

const allNavItems: NavItem[] = [
  { path: '/dashboard', label: 'Dashboard', icon: DashboardIcon },
  { path: '/meetings', label: 'Meetings', icon: MeetingsIcon },
  { path: '/recording', label: 'Record', icon: RecordIcon },
  { path: '/settings', label: 'Settings', icon: SettingsIcon },
  { path: '/admin', label: 'Admin', icon: AdminIcon, roles: ['admin'] },
];

export function Sidebar() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem('sidebar-collapsed') === 'true';
  });

  useEffect(() => {
    localStorage.setItem('sidebar-collapsed', String(collapsed));
  }, [collapsed]);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const visibleItems = allNavItems.filter(
    (item) => !item.roles || (user?.role && item.roles.includes(user.role))
  );

  const roleBadge = user?.role === 'admin' ? 'Admin' : user?.role === 'manager' ? 'Manager' : '';

  return (
    <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''}`}>
      <div>
        <div className={styles.brand}>
          <div className={styles.logo}>G</div>
          {!collapsed && <span className={styles.brandName}>Gegidze</span>}
          <button
            className={styles.collapseBtn}
            onClick={() => setCollapsed(!collapsed)}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <CollapseIcon flipped={collapsed} />
          </button>
        </div>

        <nav className={styles.nav}>
          {visibleItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                `${styles.navItem} ${isActive ? styles.active : ''}`
              }
              title={collapsed ? item.label : undefined}
            >
              <item.icon />
              {!collapsed && <span>{item.label}</span>}
            </NavLink>
          ))}
        </nav>
      </div>

      <div className={styles.footer}>
        {!collapsed ? (
          <>
            <div className={styles.userInfo}>
              <div className={styles.userName}>
                {user?.name}
                {roleBadge && <span className={styles.roleBadge}>{roleBadge}</span>}
              </div>
              <div className={styles.userEmail}>{user?.email}</div>
            </div>
            <button className={styles.logoutBtn} onClick={handleLogout}>
              <LogoutIcon />
              <span>Logout</span>
            </button>
          </>
        ) : (
          <button className={styles.logoutBtn} onClick={handleLogout} title="Logout">
            <LogoutIcon />
          </button>
        )}
      </div>
    </aside>
  );
}

function DashboardIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="7" height="8" rx="2" />
      <rect x="11" y="2" width="7" height="5" rx="2" />
      <rect x="2" y="12" width="7" height="6" rx="2" />
      <rect x="11" y="9" width="7" height="9" rx="2" />
    </svg>
  );
}

function MeetingsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="14" height="14" rx="2" />
      <line x1="3" y1="8" x2="17" y2="8" />
      <line x1="7" y1="2" x2="7" y2="5" />
      <line x1="13" y1="2" x2="13" y2="5" />
    </svg>
  );
}

function RecordIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="10" cy="10" r="7" />
      <circle cx="10" cy="10" r="3" fill="currentColor" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10" cy="10" r="3" />
      <path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.22 4.22l1.42 1.42M14.36 14.36l1.42 1.42M4.22 15.78l1.42-1.42M14.36 5.64l1.42-1.42" />
    </svg>
  );
}

function AdminIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 18v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="10" cy="6" r="4" />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3" />
      <polyline points="11 15 16 10 11 5" />
      <line x1="16" y1="10" x2="6" y2="10" />
    </svg>
  );
}

function CollapseIcon({ flipped }: { flipped: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: flipped ? 'rotate(180deg)' : undefined, transition: 'transform 0.2s ease' }}
    >
      <polyline points="10 3 5 8 10 13" />
    </svg>
  );
}
