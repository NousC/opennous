// A lazy chunk that fails where it is, not for the whole app (GET-754).
//
// A chunk can fail to load: most often a tab opened before a deploy asks for a file name the new
// build no longer serves. A plain React.lazy rethrows that into the nearest error boundary, which
// for a shell overlay or a settings panel is the app-wide one in App.tsx, so one missing panel
// took the whole app down. These log the failure and render a local fallback instead, the way
// the lazy pages (routeKit's lazyWithErrorBoundary) always have.
//
// Its own module with no app imports: the cloud registry uses it while lib/cloud.ts is still
// evaluating, so it must not reach back into anything that imports lib/cloud.ts. Plain .ts
// (createElement, no JSX) so node --test can load it through lib/preloadable.ts.
import { createElement as h, lazy, type ComponentType } from "react";

const reload = () => window.location.reload();

/** What a page or panel shows when its chunk did not load. `compact` fits it inside a page. */
export function ChunkLoadFailed({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return h("div", { className: "flex flex-col items-start gap-2 py-6 text-sm" },
      h("p", { className: "text-muted-foreground" }, "This section failed to load. Refresh the page and try again."),
      h("button", { onClick: reload, className: "px-3 py-1.5 bg-primary text-primary-foreground rounded-md hover:bg-primary/90" }, "Reload Page"),
    );
  }
  return h("div", { className: "flex flex-col items-center justify-center min-h-screen p-8" },
    h("h2", { className: "text-2xl font-semibold mb-2" }, "Failed to load page"),
    h("p", { className: "text-muted-foreground mb-4" }, "Please refresh the page and try again."),
    h("button", { onClick: reload, className: "px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90" }, "Reload Page"),
  );
}

/** The in-page fallback, for a section or panel. */
export const SectionLoadFailed = () => h(ChunkLoadFailed, { compact: true });

export const NoFallback = () => null;

export function reportChunkError(error: unknown) {
  console.error("Failed to load chunk:", error);
}

/** React.lazy, but a chunk that fails to load renders `Fallback` (nothing by default) and is logged. */
export function lazyOr<P>(
  load: () => Promise<{ default: ComponentType<P> }>,
  Fallback: ComponentType<P> = NoFallback as ComponentType<P>,
) {
  return lazy(() => load().catch((error) => {
    reportChunkError(error);
    return { default: Fallback };
  }));
}
