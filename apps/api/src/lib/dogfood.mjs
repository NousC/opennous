// Self-integration: hit our own public API so every signup/plan-change lands
// in our own Nous workspace as a person + timeline event. Same code path as
// any external customer — best-effort, never blocks the caller.

const API_URL = process.env.NOUS_INTERNAL_API_URL || 'https://api.opennous.cloud';
const API_KEY = process.env.NOUS_INTERNAL_API_KEY || null;

function configured() {
  // Never phone home from a self-hosted instance — a self-hoster's signups and
  // plan changes must not land in our cloud Nous workspace, even if they happen
  // to set NOUS_INTERNAL_API_KEY.
  if (process.env.SELF_HOSTED === 'true') return false;
  return !!API_KEY;
}

async function call(path, init = {}) {
  if (!configured()) return { ok: false, skipped: true };
  const url = `${API_URL.replace(/\/$/, '')}${path}`;
  return fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
      ...(init.headers || {}),
    },
  });
}

export async function upsertNousPerson({ email, first_name, last_name, company, stage }) {
  if (!configured() || !email) return;
  try {
    const lookup = await call(`/v2/accounts/${encodeURIComponent(email)}`);
    if (lookup?.skipped) return;
    if (lookup.ok) return;
    if (lookup.status !== 404) {
      const errText = await lookup.text().catch(() => '');
      console.warn(`[NOUS_INTERNAL] lookup ${email} -> ${lookup.status}: ${errText}`);
    }
    const create = await call('/v2/people', {
      method: 'POST',
      body: JSON.stringify({
        email,
        first_name: first_name || null,
        last_name: last_name || null,
        company: company || null,
        stage: stage || 'Free User',
        source: 'app.opennous.cloud',
      }),
    });
    if (create?.skipped) return;
    if (create.ok) {
      console.log(`[NOUS_INTERNAL] created person ${email} (stage="${stage || 'Free User'}")`);
    } else {
      const errText = await create.text().catch(() => '');
      console.error(`[NOUS_INTERNAL] person create failed for ${email}: ${create.status} ${errText}`);
    }
  } catch (err) {
    console.error(`[NOUS_INTERNAL] upsertNousPerson error for ${email}:`, err.message);
  }
}

export async function logNousObservation(email, observations) {
  if (!configured() || !email || !observations?.length) return;
  try {
    const res = await call('/v2/observations', {
      method: 'POST',
      body: JSON.stringify({ focus: email, observations }),
    });
    if (res?.skipped) return;
    if (res.ok) {
      console.log(`[NOUS_INTERNAL] logged ${observations.length} observation(s) for ${email}`);
    } else {
      const errText = await res.text().catch(() => '');
      console.error(`[NOUS_INTERNAL] observation log failed for ${email}: ${res.status} ${errText}`);
    }
  } catch (err) {
    console.error(`[NOUS_INTERNAL] logNousObservation error for ${email}:`, err.message);
  }
}
