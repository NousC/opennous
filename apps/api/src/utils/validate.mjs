export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUUID = (s) => UUID_RE.test(s);

export function requireUUID(value, name) {
  if (!value || !UUID_RE.test(value)) {
    const err = new Error(`invalid_${name}`);
    err.code = `invalid_${name}`;
    throw err;
  }
}
