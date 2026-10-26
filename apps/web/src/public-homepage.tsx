import './public-homepage.css';

type PublicHomepageProps = {
  onLogin: () => void;
  error?: string;
};

// present the public product overview before password entry
export function PublicHomepage({ onLogin, error }: PublicHomepageProps) {
  return <main className="public-homepage">
    <div className="public-homepage-shell">
      <header className="public-homepage-header">
        <a className="public-homepage-brand" href="/" aria-label="Remote Agent Console home"><span aria-hidden="true">&gt;_</span><strong>Remote Agent Console</strong></a>
        <nav className="public-homepage-nav" aria-label="Homepage"><a href="#capabilities">How it works</a><a href="#google-calendar">Google Calendar</a></nav>
      </header>

      <section className="public-homepage-hero" aria-labelledby="public-homepage-title">
        <div className="public-homepage-hero-copy">
          <p className="public-homepage-eyebrow">REMOTE // AGENTS</p>
          <h1 id="public-homepage-title">Remote Agent Console</h1>
          <p className="public-homepage-lede">Manage coding agents and their worktrees from one self-hosted console.</p>
          <p>RAC brings agent sessions, repository work and project tools into a single browser workspace while keeping access behind your console password.</p>
          <div className="public-homepage-actions">
            <button className="public-homepage-login" type="button" onClick={onLogin}>Log in <span aria-hidden="true">↗</span></button>
            <a className="public-homepage-secondary" href="#capabilities">Explore functionality</a>
          </div>
          {/* preserve public context when the console cannot be reached */}
          {error && <p className="public-homepage-error" role="alert">{error}</p>}
        </div>
        <div className="public-homepage-summary" aria-label="Product summary">
          <p>Built for active development work</p>
          <ul>
            <li>Configured Codex, Claude and OMX workflows</li>
            <li>Live agent output, prompts and project tools</li>
            <li>Repository and review context in one workspace</li>
          </ul>
        </div>
      </section>

      <section className="public-homepage-section" id="capabilities" aria-labelledby="capabilities-title">
        <p className="public-homepage-eyebrow">WHAT RAC DOES</p>
        <h2 id="capabilities-title">One place to direct and inspect agent work</h2>
        <div className="public-homepage-capabilities">
          <article><h3>Run agents</h3><p>Launch and monitor configured coding agents, send or queue prompts and schedule repeatable work.</p></article>
          <article><h3>See the work</h3><p>Follow terminal output, inspect files and keep notes beside the agent session that produced them.</p></article>
          <article><h3>Manage repositories</h3><p>Work across repositories, worktrees and branches, then inspect pull requests, changes and guided reviews.</p></article>
          <article><h3>Use project tools</h3><p>Open project processes, terminals and browser previews without losing the active agent context.</p></article>
        </div>
        <p className="public-homepage-data">This installation stores workspace configuration, prompts, history and notes to provide these tools. Prompts you submit are processed by your selected coding-agent provider under its own policies.</p>
      </section>

      <section className="public-homepage-section public-homepage-calendar" id="google-calendar" aria-labelledby="google-calendar-title">
        <p className="public-homepage-eyebrow">OPT-IN INTEGRATION</p>
        <h2 id="google-calendar-title">Optional Google Calendar integration</h2>
        <p>After logging in, you can optionally connect Google Calendar to create a dedicated timeline of supported agent work. Event titles use your configured worktree, project or agent labels, and event start and end times come only from selected lifecycle moments backed by exact agent evidence.</p>
        <p>To connect the selected Google account, RAC receives its account ID and email and stores encrypted access and refresh tokens to maintain the connection. The <code>calendar.app.created</code> permission lets RAC create and manage only the secondary calendars and events that RAC creates.</p>
        <p>RAC does not automatically put prompts, responses, file contents or filesystem paths into Google Calendar. Google API data is not sold, used for advertising or used to train AI models.</p>
        <p>Console password login is separate from Google authorization. Connecting Google is optional, happens only after login and can be revoked.</p>
        <p>Read the <a href="/privacy">Privacy Policy</a> for the complete data, storage, retention and revocation details.</p>
      </section>

      <footer className="public-homepage-footer">
        <span>Remote Agent Console</span>
        <nav aria-label="Legal policies"><a href="/privacy">Privacy Policy</a><a href="/terms">Terms of Service</a></nav>
      </footer>
    </div>
  </main>;
}
