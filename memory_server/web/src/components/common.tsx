import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { formatRoute, type Route } from "../routes.js";

export interface AsyncState<T> {
  data?: T;
  error?: string;
  loading: boolean;
  reload: () => void;
}

/**
 * Runs `load` when the dependencies change (previous data is dropped) or on `reload()` (previous data stays
 * visible until the new one arrives); results of outdated runs are ignored.
 */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [generation, setGeneration] = useState(0);
  const depsKey = JSON.stringify(deps);
  const lastKey = useRef(depsKey);
  useEffect(() => {
    let current = true;
    const changed = lastKey.current !== depsKey;
    lastKey.current = depsKey;
    setState((s) => (changed ? { loading: true } : { ...s, loading: true }));
    load().then(
      (data) => current && setState({ data, loading: false }),
      (error: Error) => current && setState({ error: error.message, loading: false }),
    );
    return () => {
      current = false;
    };
  }, [depsKey, generation]);
  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  return { ...state, reload };
}

export function Link({ to, class: className, title, children }: { to: Route; class?: string; title?: string; children: ComponentChildren }) {
  return <a href={formatRoute(to)} class={className} title={title}>{children}</a>;
}

export function ErrorMessage({ message }: { message: string }) {
  return <div class="error" role="alert">{message}</div>;
}

export function Loading() {
  return <div class="muted">Loading…</div>;
}

export function Tags({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return <span class="tags">{tags.map((t) => <span class="tag" key={t}>{t}</span>)}</span>;
}
