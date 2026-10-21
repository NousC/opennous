import { decrypt } from './crypto.mjs';

// Best-effort revocation of a connection's OAuth tokens AT THE PROVIDER, so a
// disconnect or account erasure actually severs access instead of just deleting
// our row (GDPR Art. 17 completeness). Never throws — a provider that refuses
// must not block the delete on our side.
export async function revokeConnectionTokens(conn) {
  const name = (conn?.workflow_providers?.name || conn?.provider?.name || '').toLowerCase();
  const creds = conn?.encrypted_credentials || {};
  try {
    if (name.startsWith('google') || name === 'gmail_oauth' || name === 'gmail') {
      // Revoking the refresh token invalidates the whole grant at Google.
      const token = decrypt(creds.refresh_token || '') || decrypt(creds.access_token || '');
      if (token) {
        await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(token), {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
      }
    } else if (name.startsWith('slack')) {
      // A personal connection holds only that person's user token (GET-985): revoking it signs
      // them out of us and nothing else. The workspace install's bot token uninstalls the bot.
      const token = name === 'slack_personal'
        ? decrypt(creds.user_token || '')
        : decrypt(creds.bot_token || creds.access_token || creds.token || '');
      if (token) {
        await fetch('https://slack.com/api/auth.revoke', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token },
        });
      }
    }
    // Other providers are API-key based (no OAuth grant to revoke) — deleting the
    // row + tearing down the webhook (disconnectProvider) is the full severance.
  } catch (err) {
    console.warn('[REVOKE]', name, err?.message);
  }
}
