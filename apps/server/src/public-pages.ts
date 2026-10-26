type PublicPolicy = 'privacy' | 'terms';

const policies: Record<PublicPolicy, { title: string; body: string }> = {
  privacy: {
    title: 'Privacy Policy',
    body: `<p>Remote Agent Console (RAC) is a self-hosted tool for managing coding agents. This policy covers this installation and its optional Google Calendar integration.</p>
<h2>Data and purpose</h2>
<p>RAC stores workspace configuration, prompt/history records and browser-session information to provide its console. Coding agents process prompts you choose to send under their providers' policies.</p>
<p>Connecting Google provides your Google account identifier, email and access/refresh tokens. RAC uses <code>openid</code>, <code>email</code> and <code>calendar.app.created</code> to link that account and create a dedicated calendar and agent-work events. RAC accesses only calendars it created and keeps calendar/event identifiers and delivery records for reliable delivery.</p>
<p>Events contain your configured title (including chosen worktree, project or agent labels), start/end times and an opaque ownership marker. RAC does not automatically include prompts, responses, file contents, filesystem paths, attendees or descriptions. Avoid sensitive information in event titles and labels.</p>
<h2>Storage and sharing</h2>
<p>Authorization tokens are encrypted at rest on this server. The instance administrator and hosting providers may access local records to operate and secure the service. Google receives calendar data; your Google Calendar sharing settings and services you separately connect determine further access. Google API data is not sold, used for advertising or used to train AI models.</p>
<p>Remote Agent Console's use of Google API data complies with the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including its Limited Use requirements.</p>
<h2>Retention and your choices</h2>
<p>Disconnect in Settings removes saved tokens and account email, but retains minimal account/calendar identifiers and delivery history. Successful and suppressed delivery records older than 30 days are removed during startup cleanup; pending/failed records and minimal identifiers can remain until administrator cleanup.</p>
<p>You can revoke authorization through <a href="https://myaccount.google.com/permissions">Google Account permissions</a>. Disconnecting does not delete calendars or events already in Google Calendar; delete those in Google Calendar itself. For privacy questions or deletion of local records, contact the instance administrator who provided your access.</p>`
  },
  terms: {
    title: 'Terms of Service',
    body: `<p>These terms govern use of this Remote Agent Console (RAC) installation, a self-hosted tool for managing coding agents and optionally recording agent work in Google Calendar.</p>
<h2>Authorized use</h2>
<p>Use this installation only with its operator's permission and only with accounts, repositories and systems you are authorized to manage. You are responsible for the commands, prompts, labels and other content you submit and for checking their results.</p>
<h2>Google Calendar</h2>
<p>Connecting Google is optional and authorizes RAC to create and manage its dedicated calendars and agent-work events as configured. You may disconnect or revoke access at any time. Google services remain subject to <a href="https://policies.google.com/terms">Google's terms</a>; data handling is described in the <a href="/privacy">Privacy Policy</a>.</p>
<h2>Availability and support</h2>
<p>The service is provided as is, without warranties to the extent permitted by applicable law. It may change or become unavailable. Verify generated events before relying on them for billing or other important records. You may stop using the service at any time; its operator may end access.</p>
<p>For support or questions about these terms, contact the instance administrator who provided your access.</p>`
  }
};

// share the readable public document shell without private application state
function renderPublicPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${title} for Remote Agent Console.">
<title>${title} | Remote Agent Console</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; background: Canvas; color: CanvasText; font: 16px/1.65 system-ui, sans-serif; }
main { max-width: 46rem; margin: 0 auto; padding: clamp(1.25rem, 4vw, 3rem) 1.25rem; }
nav, footer { display: flex; flex-wrap: wrap; gap: 1rem; }
h1 { font-size: 2rem; line-height: 1.2; }
h2 { margin: 1.75rem 0 .5rem; font-size: 1.125rem; }
p { margin: .75rem 0; }
a { color: LinkText; }
a, code { overflow-wrap: anywhere; }
.updated { font-size: .875rem; opacity: .75; }
footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid GrayText; }
</style>
</head>
<body><main>
<nav aria-label="Home"><a href="/">Remote Agent Console</a></nav>
<h1>${title}</h1>
${body}
<footer aria-label="Legal"><a href="/privacy">Privacy Policy</a><a href="/terms">Terms of Service</a></footer>
</main></body>
</html>`;
}

// date policy documents without coupling the error page to publication updates
export function renderPublicPolicyPage(policy: PublicPolicy): string {
  const { title, body } = policies[policy];
  return renderPublicPage(title, `<p class="updated">Updated <time datetime="2026-10-26">26 October 2026</time></p>\n${body}`);
}

// offer a safe way home without echoing the requested path or query
export function renderNotFoundPage(): string {
  return renderPublicPage('404 — Page not found', '<p>This page does not exist or has moved.</p><p><a href="/">Return to console</a></p>');
}
