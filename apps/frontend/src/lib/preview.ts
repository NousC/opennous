// Preview mode — the full app, no credentials.
//
// Arms ONLY on an explicit opt-in (VITE_PREVIEW=1) in a dev-MODE build, and
// only when there is no Clerk publishable key — i.e. exactly the situation
// where the real app cannot boot at all (main.tsx would throw).
//
// Why MODE and not DEV: Vite derives `import.meta.env.DEV` from NODE_ENV, and
// vite.config.ts points envDir at the repo root, where .env.example (and every
// .env copied from it) sets NODE_ENV=development. That made a plain
// `vite build` on a host checkout emit a MINIFIED PRODUCTION BUNDLE with DEV
// still true — shipping the fixture auth provider into a real build. MODE is
// set by the build command itself ("production" for `vite build`) and no .env
// can flip it. The explicit VITE_PREVIEW opt-in is the second lock: a merely
// missing Clerk key now fails LOUD at boot again, the way it used to, instead
// of silently booting a fake founder session with plan enforcement off.
//
// In preview: main.tsx skips ClerkProvider, App mounts PreviewAuthProvider
// (a fixture /me + a role switcher) instead of AuthProvider, and the data
// comes from the mock API in apps/frontend/preview/server.mjs on :3000 —
// the same port, same routes, same shapes the real API serves.
export const PREVIEW: boolean =
  import.meta.env.MODE === "development" &&
  import.meta.env.VITE_PREVIEW === "1" &&
  !import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
