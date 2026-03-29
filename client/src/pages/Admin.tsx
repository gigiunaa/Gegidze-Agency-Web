import { useEffect, useState, useMemo, useCallback } from 'react';
import { api } from '../api/client';
import { useAuthStore } from '../stores/auth';
import {
  PageHeader,
  StatCard,
  DataTable,
  Badge,
  Button,
  Modal,
  SearchInput,
  EmptyState,
  Skeleton,
} from '../components/ui';
import type { Column } from '../components/ui';
import type { User } from '../../../shared/types';
import styles from './Admin.module.css';

type UserRole = User['role'];

const ROLES: UserRole[] = ['user', 'manager', 'admin'];

interface AdminStats {
  totalUsers: number;
  totalMeetings: number;
  completedMeetings: number;
  failedMeetings: number;
}

export function AdminPage() {
  const currentUser = useAuthStore((s) => s.user);

  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // Add-user modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [addForm, setAddForm] = useState({ email: '', name: '', role: 'user' as UserRole, password: '' });
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState('');

  // Delete confirmation modal
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Role change loading tracker
  const [roleLoading, setRoleLoading] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [statsData, usersData] = await Promise.all([
        api.admin.stats(),
        api.admin.users(),
      ]);
      setStats(statsData);
      setUsers(usersData);
    } catch {
      // silently fail — user will see empty state
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (currentUser?.role !== 'admin') return;
    fetchData();
  }, [currentUser, fetchData]);

  const filteredUsers = useMemo(() => {
    if (!search.trim()) return users;
    const q = search.toLowerCase();
    return users.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        u.role.toLowerCase().includes(q),
    );
  }, [users, search]);

  // ── Handlers ──────────────────────────────────────────────────────

  const handleRoleChange = async (userId: string, newRole: UserRole) => {
    setRoleLoading(userId);
    try {
      const updated = await api.admin.updateRole(userId, newRole);
      setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, role: updated.role } : u)));
    } catch {
      // TODO: toast
    } finally {
      setRoleLoading(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      await api.admin.deleteUser(deleteTarget.id);
      setUsers((prev) => prev.filter((u) => u.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch {
      // TODO: toast
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddError('');
    if (!addForm.email || !addForm.name || !addForm.password) {
      setAddError('All fields are required.');
      return;
    }
    setAddLoading(true);
    try {
      const newUser = await api.admin.inviteUser(addForm);
      setUsers((prev) => [...prev, newUser]);
      setShowAddModal(false);
      setAddForm({ email: '', name: '', role: 'user', password: '' });
    } catch (err: unknown) {
      setAddError(err instanceof Error ? err.message : 'Failed to add user.');
    } finally {
      setAddLoading(false);
    }
  };

  // ── Access guard ──────────────────────────────────────────────────

  if (currentUser?.role !== 'admin') {
    return (
      <div className={styles.page}>
        <EmptyState title="Access Denied" description="Admin privileges are required to view this page." />
      </div>
    );
  }

  // ── Table columns ─────────────────────────────────────────────────

  const columns: Column<User & Record<string, unknown>>[] = [
    {
      key: 'name',
      label: 'Name',
      width: '1.5fr',
      render: (row) => <span className={styles.userName}>{row.name as string}</span>,
    },
    {
      key: 'email',
      label: 'Email',
      width: '2fr',
      render: (row) => <span className={styles.userEmail}>{row.email as string}</span>,
    },
    {
      key: 'role',
      label: 'Role',
      width: '160px',
      render: (row) => {
        const userId = row.id as string;
        const role = row.role as UserRole;
        const isCurrentUser = userId === currentUser?.id;
        const isChanging = roleLoading === userId;

        return (
          <div className={styles.roleCell}>
            {isChanging ? (
              <Skeleton width={80} height={26} borderRadius={20} />
            ) : (
              <select
                className={styles.roleSelect}
                value={role}
                disabled={isCurrentUser}
                onChange={(e) => handleRoleChange(userId, e.target.value as UserRole)}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            )}
            <Badge variant={role}>{role}</Badge>
          </div>
        );
      },
    },
    {
      key: 'actions',
      label: '',
      width: '100px',
      render: (row) => {
        const userId = row.id as string;
        const isCurrentUser = userId === currentUser?.id;

        if (isCurrentUser) return null;

        return (
          <Button
            variant="danger"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              setDeleteTarget(row as unknown as User);
            }}
          >
            Delete
          </Button>
        );
      },
    },
  ];

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div className={styles.page}>
      <PageHeader
        title="Admin Panel"
        subtitle="Manage users and monitor platform activity"
        actions={
          <Button variant="primary" size="md" onClick={() => setShowAddModal(true)}>
            Add User
          </Button>
        }
      />

      {/* Stats */}
      {loading ? (
        <div className={styles.statsGrid}>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} height={90} borderRadius="var(--radius-md)" />
          ))}
        </div>
      ) : stats ? (
        <div className={styles.statsGrid}>
          <StatCard label="Total Users" value={stats.totalUsers} />
          <StatCard label="Total Meetings" value={stats.totalMeetings} />
          <StatCard label="Completed" value={stats.completedMeetings} variant="success" />
          <StatCard label="Failed" value={stats.failedMeetings} variant="error" />
        </div>
      ) : null}

      {/* Users section */}
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Users</h2>
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search by name, email, or role..."
            className={styles.search}
          />
        </div>

        {loading ? (
          <Skeleton count={5} height={52} borderRadius="var(--radius-sm)" />
        ) : filteredUsers.length === 0 && search ? (
          <EmptyState
            title="No users found"
            description={`No results matching "${search}"`}
            action={
              <Button variant="secondary" size="sm" onClick={() => setSearch('')}>
                Clear search
              </Button>
            }
          />
        ) : filteredUsers.length === 0 ? (
          <EmptyState title="No users yet" description="Add a user to get started." />
        ) : (
          <DataTable
            columns={columns}
            data={filteredUsers as (User & Record<string, unknown>)[]}
          />
        )}
      </section>

      {/* Add User Modal */}
      <Modal
        isOpen={showAddModal}
        onClose={() => {
          setShowAddModal(false);
          setAddError('');
        }}
        title="Add New User"
        footer={
          <div className={styles.modalFooter}>
            <Button variant="secondary" onClick={() => setShowAddModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={addLoading} onClick={handleAddUser}>
              Add User
            </Button>
          </div>
        }
      >
        <form onSubmit={handleAddUser} className={styles.form}>
          {addError && <p className={styles.formError}>{addError}</p>}

          <label className={styles.formField}>
            <span className={styles.formLabel}>Name</span>
            <input
              className={styles.formInput}
              type="text"
              value={addForm.name}
              onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Full name"
              autoComplete="off"
            />
          </label>

          <label className={styles.formField}>
            <span className={styles.formLabel}>Email</span>
            <input
              className={styles.formInput}
              type="email"
              value={addForm.email}
              onChange={(e) => setAddForm((f) => ({ ...f, email: e.target.value }))}
              placeholder="user@example.com"
              autoComplete="off"
            />
          </label>

          <label className={styles.formField}>
            <span className={styles.formLabel}>Password</span>
            <input
              className={styles.formInput}
              type="password"
              value={addForm.password}
              onChange={(e) => setAddForm((f) => ({ ...f, password: e.target.value }))}
              placeholder="Initial password"
              autoComplete="new-password"
            />
          </label>

          <label className={styles.formField}>
            <span className={styles.formLabel}>Role</span>
            <select
              className={styles.formInput}
              value={addForm.role}
              onChange={(e) => setAddForm((f) => ({ ...f, role: e.target.value as UserRole }))}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r.charAt(0).toUpperCase() + r.slice(1)}
                </option>
              ))}
            </select>
          </label>
        </form>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete User"
        footer={
          <div className={styles.modalFooter}>
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={deleteLoading} onClick={handleDelete}>
              Delete
            </Button>
          </div>
        }
      >
        <p className={styles.confirmText}>
          Are you sure you want to delete <strong>{deleteTarget?.name}</strong> ({deleteTarget?.email})? This action
          cannot be undone.
        </p>
      </Modal>
    </div>
  );
}
