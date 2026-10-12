// What a self-hosted install has configured, for Settings → Instance setup (GET-837). Read from
// the environment the api runs with (nous.env), never from the database, because these are the
// operator's decisions, made in nous.env. Values are never returned: only whether each is set.
import { nativeGoogleConfigured } from '../providers/googleNative.mjs';

const GUIDE = 'https://github.com/NousC/opennous/blob/main/docs/self-host-bundled.md';
const set = (env, k) => {
  const v = String(env[k] ?? '').trim();
  // Example values count as unset ("placeholder", "your-…", "sk-ant-...").
  return v !== '' && !/placeholder|\.\.\.|…|^your[-_ ]|changeme|[<>]/i.test(v);
};

/** Each integration a person can connect, and what the operator must do first (if anything). */
export function integrationStatus(env = process.env) {
  const keyPaste = (id, name, kind) => ({ id, name, kind, ready: true, needs: [] });
  // Self-host connects Google with its own OAuth app only, never Composio (GET-765, GET-837).
  const google = nativeGoogleConfigured(env);
  const salesforce = set(env, 'SALESFORCE_CLIENT_ID') && set(env, 'SALESFORCE_CLIENT_SECRET') && set(env, 'SALESFORCE_REDIRECT_URI');
  return [
    keyPaste('hubspot', 'HubSpot', 'CRM'),
    keyPaste('attio', 'Attio', 'CRM'),
    {
      id: 'salesforce', name: 'Salesforce', kind: 'CRM', ready: salesforce,
      needs: salesforce ? [] : ['SALESFORCE_CLIENT_ID', 'SALESFORCE_CLIENT_SECRET', 'SALESFORCE_REDIRECT_URI'],
      guide: `${GUIDE}#salesforce`,
    },
    {
      id: 'gmail_oauth', name: 'Gmail and Google Calendar', kind: 'Email and calendar', ready: google,
      needs: google ? [] : ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
      guide: `${GUIDE}#gmail-and-google-calendar`,
    },
    keyPaste('fireflies', 'Fireflies', 'Meeting notes'),
    keyPaste('granola', 'Granola', 'Meeting notes'),
    keyPaste('fathom', 'Fathom', 'Meeting notes'),
  ];
}

/** Sign-in emails (password reset, confirmations) need SMTP on the auth server. */
export function emailStatus(env = process.env) {
  const smtp = set(env, 'SMTP_HOST') && set(env, 'SMTP_ADMIN_EMAIL');
  return { ready: smtp, needs: smtp ? [] : ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_ADMIN_EMAIL'], guide: `${GUIDE}#email` };
}

export { GUIDE as SELF_HOST_GUIDE, set as envIsSet };
