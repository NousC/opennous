// Its own module, not part of lib/cloud.ts: the cloud registry calls it while lib/cloud.ts is
// still evaluating (that module loads the registry eagerly), so anything the registry needs at
// load time must live outside it.
import { createElement, lazy, useState, type ComponentType } from "react";
import { ChunkLoadFailed, reportChunkError } from "./lazyChunk.ts";

/**
 * A lazy component that can be fetched ahead of its first render. Once `preload()` has resolved
 * it renders straight away, without suspending, so a page that warms it while its own data loads
 * (the account record) shows no loading frame the in-chunk component did not have.
 *
 * Each mount keeps the component type it started with. A mount that rendered before the chunk
 * arrived stays on the lazy wrapper (which renders the real component once loaded); switching it
 * to the real component on a later render would change the element type, and React would
 * remount the subtree and drop its state (a typed search, an open tab).
 *
 * A chunk that fails to load (a stale tab after a deploy) renders the "failed to load" message
 * in place and is logged, the way the lazy pages do; `preload()` rejects, so callers catch it.
 */
export type Preloadable<P> = ComponentType<P> & { preload: () => Promise<unknown> };
export function preloadable<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
  Fallback: ComponentType<P> = ChunkLoadFailed as ComponentType<P>,
): Preloadable<P> {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<unknown> | null = null;
  const preload = () => (pending ??= load().then(
    (m) => { loaded = m.default; },
    // Forget a failed fetch so a later preload() tries again.
    (error) => { pending = null; throw error; },
  ));
  const Lazy = lazy(() => preload().then(
    () => ({ default: loaded as ComponentType<P> }),
    (error) => { reportChunkError(error); return { default: Fallback }; },
  ));
  const Component = (props: P) => {
    const [Type] = useState<ComponentType<P>>(() => (loaded ?? Lazy) as ComponentType<P>);
    return createElement(Type, props);
  };
  return Object.assign(Component, { preload });
}
