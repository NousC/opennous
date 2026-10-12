// The same token the server derives, computed independently on this side.
//
// It has to be a COPY rather than an import: the server derives it in @nous/core, which the
// browser bundle does not pull in. Twelve lines duplicated is the right trade against
// shipping a backend package to the client — but they must stay identical, so if one moves
// the other does. See packages/core/src/evidenceDetail.ts.
//
// The point of deriving it on both sides is that neither side COUNTS. The agent copies a
// token it was handed; the panel computes the same token from the same ref. There is no
// shared ordering to drift, which is what made the old numbering wrong: the model numbered
// blind and the panel numbered its rows, and the two had nothing to do with each other.
export function citeKey(ref: string | null | undefined): string | null {
  if (!ref) return null;
  let h = 0;
  for (let i = 0; i < ref.length; i++) h = (Math.imul(h, 31) + ref.charCodeAt(i)) | 0;
  return `c${(Math.abs(h) % 1679616).toString(36).padStart(4, "0")}`;
}
