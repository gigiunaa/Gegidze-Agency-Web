import { Link } from 'react-router-dom';
import styles from './Legal.module.css';

export function TermsPage() {
  return (
    <div className={styles.page}>
      <div className={styles.brand}>Unitty Meeting Recorder</div>
      <h1 className={styles.title}>Terms of Service</h1>
      <p className={styles.updated}>Last updated 22 September 2026</p>

      <p className={styles.lead}>
        Unitty Meeting Recorder is an internal tool provided by Gegidze Group to its team and
        approved partners. Using it means accepting these terms.
      </p>

      <section className={styles.section}>
        <h2>What it does</h2>
        <p>
          The tool records a call you are taking part in, writes a transcript and a short set of
          notes from it, and can attach that transcript to the matching record in our CRM. It is
          provided as it is, for work use, and may change or be withdrawn at any time.
        </p>
      </section>

      <section className={styles.section}>
        <h2>Your side of it</h2>
        <ul>
          <li>Record only calls you are taking part in, and only where the law where you and the other people are allows it.</li>
          <li>Leave the automatic notice in the meeting chat in place, so everyone knows the call is being transcribed. If someone objects, stop the recording.</li>
          <li>Keep your account to yourself and treat transcripts as confidential company material.</li>
          <li>Do not use the tool to record anything unlawful.</li>
        </ul>
      </section>

      <section className={styles.section}>
        <h2>Accuracy</h2>
        <p>
          Transcripts and notes are produced automatically and will contain mistakes. They are a
          record to work from, not a verbatim legal record, and should not be relied on as one.
        </p>
      </section>

      <section className={styles.section}>
        <h2>Accounts</h2>
        <p>
          Accounts are for named people. We may suspend or remove an account, and delete the
          recordings and transcripts belonging to it, at our discretion.
        </p>
      </section>

      <section className={styles.section}>
        <h2>Data</h2>
        <p>
          What the tool collects and how long it is kept is described in the{' '}
          <Link to="/privacy">Privacy Policy</Link>, which forms part of these terms.
        </p>
      </section>

      <p className={styles.footer}>
        Questions: <a href="mailto:digital@gegidze.com">digital@gegidze.com</a> · <Link to="/privacy">Privacy Policy</Link>
      </p>
    </div>
  );
}
