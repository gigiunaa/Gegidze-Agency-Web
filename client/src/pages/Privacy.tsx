import { Link } from 'react-router-dom';
import styles from './Legal.module.css';

// Written for the people whose calls this records, and for Google's OAuth review.
export function PrivacyPage() {
  return (
    <div className={styles.page}>
      <div className={styles.brand}>Unitty Meeting Recorder</div>
      <h1 className={styles.title}>Privacy Policy</h1>
      <p className={styles.updated}>Last updated 22 September 2026</p>

      <p className={styles.lead}>
        Unitty Meeting Recorder is an internal tool. A member of our team starts a recording of a
        call they are taking part in, and the tool turns that call into a written transcript and a
        short set of notes. This page explains exactly what it handles and why.
      </p>

      <section className={styles.section}>
        <h2>What the tool handles</h2>
        <ul>
          <li><strong>Call audio.</strong> Your microphone and the sound of the meeting tab, recorded only while a recording is running and only on the call you started it on.</li>
          <li><strong>The transcript and notes</strong> made from that audio.</li>
          <li><strong>Who was speaking.</strong> Names shown by Google Meet's live captions, so the transcript says who said what.</li>
          <li><strong>Calendar details of that meeting</strong>, if you connect Google Calendar: the meeting's title and the names and email addresses of the people invited.</li>
          <li><strong>Your account</strong>: name, email address and password (stored only as a hash).</li>
        </ul>
      </section>

      <section className={styles.section}>
        <h2>Google Calendar</h2>
        <p>
          Connecting Google Calendar is optional and can be undone at any time from the dashboard.
          The tool asks for read-only access to calendar events and uses it for one thing: finding
          the invitation behind the call you just recorded, to read its title and the people
          invited. It never creates, edits or deletes anything in your calendar, and it does not
          read events unrelated to a recorded call. Google user data obtained through these scopes
          is not used to develop, improve or train any generalised artificial intelligence model.
        </p>
      </section>

      <section className={styles.section}>
        <h2>Who else sees the data</h2>
        <ul>
          <li><strong>Google (Gemini API)</strong> receives the call audio in order to transcribe it, and the transcript in order to write the notes. The audio is deleted from Google's file storage as soon as the transcript comes back.</li>
          <li><strong>Zoho CRM</strong> receives the finished transcript as a document attached to the record of a person who was on the call, when their email address matches a Lead or Contact.</li>
          <li><strong>Railway</strong> hosts the service and its database.</li>
        </ul>
        <p>Nothing is sold, and nothing is shared with anyone else.</p>
      </section>

      <section className={styles.section}>
        <h2>How long it is kept</h2>
        <p>
          Audio files are deleted from our server as soon as the transcript is finished; they are
          kept only if processing failed, so the call is not lost, and are removed once it has been
          retried. Transcripts, notes and meeting details stay until someone deletes the meeting.
          Deleting a meeting deletes its transcript and notes with it.
        </p>
      </section>

      <section className={styles.section}>
        <h2>Telling people they are being recorded</h2>
        <p>
          When a recording starts, the tool posts a message in the meeting chat saying the call is
          being transcribed, so everyone on the call knows.
        </p>
      </section>

      <section className={styles.section}>
        <h2>Your choices</h2>
        <p>
          You can ask us to show you what we hold about you, to correct it, or to delete it — including
          any recording you took part in. Write to <a href="mailto:digital@gegidze.com">digital@gegidze.com</a> and
          we will act on it.
        </p>
      </section>

      <p className={styles.footer}>
        Questions: <a href="mailto:digital@gegidze.com">digital@gegidze.com</a> · <Link to="/terms">Terms of Service</Link>
      </p>
    </div>
  );
}
