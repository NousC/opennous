// lib/preloadable keeps a mounted variant's state when its chunk arrives (GET-754), pinned.
//
// The review finding on PR #663: the wrapper rendered `loaded ?? Lazy`, so a mount that committed
// the lazy wrapper before the chunk arrived would switch element type (Lazy -> the real
// component) on the parent's next render, and React would remount the subtree and drop its state
// (a typed search on /accounts, the account record's open tab). Each mount now keeps the type it
// started with.
//
// Measured: on the app's own root (createRoot, React 18.3) the old wrapper did not lose state,
// because a suspended first mount is never committed and is re-rendered after `loaded` is set.
// It does on a root that commits the suspended tree (the legacy root), which is how the second
// case below fails against the old wrapper. Both cases pin "no remount" for whichever root runs.
//
// No DOM library in this repo, so React renders into a minimal stand-in document: enough nodes
// for react-dom to create, append, update text and remove. Run:
//   node --test apps/frontend/tests/preloadable.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

// ── a stand-in DOM, just what react-dom's client renderer touches ─────────────────────────────
class FakeNode {
  nodeType: number;
  nodeName: string;
  tagName?: string;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  ownerDocument: FakeNode | null = null;
  style: Record<string, unknown> & { setProperty: (k: string, v: string) => void } = { setProperty() {} };
  attrs: Record<string, string> = {};
  private text = "";
  constructor(nodeType: number, name: string) {
    this.nodeType = nodeType;
    this.nodeName = name;
    if (nodeType === 1) this.tagName = name;
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling() {
    const sibs = this.parentNode?.childNodes ?? [];
    return sibs[sibs.indexOf(this) + 1] ?? null;
  }
  appendChild(c: FakeNode) { c.parentNode?.removeChild(c); this.childNodes.push(c); c.parentNode = this; return c; }
  insertBefore(c: FakeNode, ref: FakeNode | null) {
    if (!ref) return this.appendChild(c);
    c.parentNode?.removeChild(c);
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild(c: FakeNode) { this.childNodes = this.childNodes.filter((n) => n !== c); c.parentNode = null; return c; }
  get textContent(): string { return this.nodeType === 3 ? this.text : this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v: string) {
    if (this.nodeType === 3) { this.text = v; return; }
    this.childNodes = [];
    if (v) { const t = new FakeNode(3, "#text"); t.text = v; this.appendChild(t); }
  }
  get nodeValue() { return this.text; }
  set nodeValue(v: string) { this.text = v; }
  get data() { return this.text; }
  set data(v: string) { this.text = v; }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
  removeAttribute(k: string) { delete this.attrs[k]; }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener() {}
  removeEventListener() {}
}
const doc = new FakeNode(9, "#document") as FakeNode & Record<string, unknown>;
Object.assign(doc, {
  createElement: (tag: string) => { const n = new FakeNode(1, tag.toUpperCase()); n.ownerDocument = doc; return n; },
  createTextNode: (text: string) => { const n = new FakeNode(3, "#text"); n.textContent = text; n.ownerDocument = doc; return n; },
});
const g = globalThis as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
// react-dom reads window.event for update priority; no window.document keeps it off the DOM-only paths.
g.window ??= { HTMLIFrameElement: class {} };

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const ReactDOM = (await import("react-dom")).default;
const { preloadable } = await import("../src/lib/preloadable.ts");
const h = React.createElement;
const act = React.act;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// The "chunk": a component with its own state and a mount counter, like AccountsList's search.
let mounts = 0;
let setQuery: (q: string) => void = () => {};
function Inner({ view }: { view: string }) {
  const [query, set] = React.useState("");
  setQuery = set;
  React.useEffect(() => { mounts += 1; }, []);
  return h("span", null, `${view}|${query}`);
}

type RootKind = "createRoot" | "legacy root";
function newContainer() {
  const container = new FakeNode(1, "DIV");
  container.ownerDocument = doc;
  return container;
}
function newRoot(container: FakeNode, kind: RootKind = "createRoot") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const el = container as any;
  if (kind === "createRoot") return createRoot(el);
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render: (node: React.ReactElement) => (ReactDOM as any).render(node, el),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    unmount: () => (ReactDOM as any).unmountComponentAtNode(el),
  };
}

function setup(kind: RootKind = "createRoot") {
  mounts = 0;
  const chunk = deferred<{ default: typeof Inner }>();
  const Variant = preloadable(() => chunk.promise);
  let setView: (v: string) => void = () => {};
  function Parent() {
    const [view, set] = React.useState("all");
    setView = set;
    return h(React.Suspense, { fallback: null }, h(Variant, { view }));
  }
  const container = newContainer();
  const root = newRoot(container, kind);
  return { chunk, Variant, root, container, Parent, setView: (v: string) => setView(v) };
}

// ReactDOM.render's deprecation warning is expected noise in the legacy case.
async function quietly<T>(fn: () => Promise<T>) {
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    if (String(args[0]).includes("ReactDOM.render is no longer supported")) return;
    if (String(args[0]).includes("unmountComponentAtNode is deprecated")) return;
    realError(...args);
  };
  try { return await fn(); } finally { console.error = realError; }
}

for (const kind of ["createRoot", "legacy root"] as const) {
  test(`${kind}: a mount that rendered before the chunk arrived keeps its state on the parent's next render`, () => quietly(async () => {
    const { chunk, root, container, Parent, setView } = setup(kind);
    await act(async () => { root.render(h(Parent)); });
    assert.equal(container.textContent, "", "suspended while the chunk is in flight");

    await act(async () => { chunk.resolve({ default: Inner }); await chunk.promise; });
    assert.equal(container.textContent, "all|");
    assert.equal(mounts, 1);

    await act(async () => { setQuery("acme"); });            // the user types a search
    await act(async () => { setView("customers"); });        // then a view chip re-renders the parent
    assert.equal(container.textContent, "customers|acme", "the typed search survives");
    assert.equal(mounts, 1, "no remount");
    await act(async () => { root.unmount(); });
  }));
}

test("a mount after preload() renders straight away, without suspending", async () => {
  const { chunk, Variant, root, container, Parent } = setup();
  chunk.resolve({ default: Inner });
  await Variant.preload();
  await act(async () => { root.render(h(Parent)); });
  assert.equal(container.textContent, "all|");
  assert.equal(mounts, 1);
  await act(async () => { root.unmount(); });
});

test("a chunk that fails renders the fallback in place and preload() rejects", async () => {
  const errors: unknown[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const Variant = preloadable<{ view: string }>(() => Promise.reject(new Error("stale chunk")), () => h("i", null, "failed"));
    await assert.rejects(Variant.preload(), /stale chunk/);
    const container = newContainer();
    const root = newRoot(container);
    await act(async () => { root.render(h(React.Suspense, { fallback: null }, h(Variant, { view: "all" }))); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.equal(container.textContent, "failed");
    assert.ok(errors.some((e) => String((e as unknown[])[0]).includes("Failed to load chunk")));
    await act(async () => { root.unmount(); });
  } finally {
    console.error = realError;
  }
});

test("lazyOr: a lazy panel whose chunk fails renders its fallback, not an error for the app", async () => {
  const { lazyOr } = await import("../src/lib/lazyChunk.ts");
  const realError = console.error;
  const errors: unknown[] = [];
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const Panel = lazyOr<object>(() => Promise.reject(new Error("stale chunk")), () => h("i", null, "panel failed"));
    const Dock = lazyOr<object>(() => Promise.reject(new Error("stale chunk")));
    const container = newContainer();
    const root = newRoot(container);
    await act(async () => { root.render(h(React.Suspense, { fallback: null }, h("b", null, "app"), h(Panel), h(Dock))); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.equal(container.textContent, "apppanel failed", "the app stays up; the dock renders nothing");
    assert.equal(errors.filter((e) => String((e as unknown[])[0]).includes("Failed to load chunk")).length, 2);
    await act(async () => { root.unmount(); });
  } finally {
    console.error = realError;
  }
});
