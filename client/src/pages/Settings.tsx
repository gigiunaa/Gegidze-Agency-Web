import { useEffect, useState } from 'react';
import { api } from '../api/client';
import styles from './Settings.module.css';

export function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.settings.get().then(setSettings);
  }, []);

  async function handleUpdate(patch: Record<string, string>) {
    await api.settings.update(patch);
    setSettings((prev) => ({ ...prev, ...patch }));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function handleThemeChange(theme: string) {
    handleUpdate({ theme });
    document.documentElement.className = theme === 'system' ? 'dark' : theme;
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.heading}>Settings</h1>
        {saved && <span className={styles.savedBadge}>Saved</span>}
      </div>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Appearance</h2>
        <div className={styles.field}>
          <label className={styles.label}>Theme</label>
          <div className={styles.themeOptions}>
            {['dark', 'light', 'system'].map((t) => (
              <button
                key={t}
                className={`${styles.themeBtn} ${(settings.theme || 'dark') === t ? styles.themeActive : ''}`}
                onClick={() => handleThemeChange(t)}
              >
                {t === 'dark' ? 'Dark' : t === 'light' ? 'Light' : 'System'}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>API Keys</h2>
        <div className={styles.field}>
          <label className={styles.label}>OpenAI API Key (Whisper & GPT)</label>
          <input
            className={styles.input}
            type="password"
            placeholder="sk-..."
            value={settings.openaiApiKey ?? ''}
            onChange={(e) => handleUpdate({ openaiApiKey: e.target.value })}
          />
        </div>
      </section>
    </div>
  );
}
