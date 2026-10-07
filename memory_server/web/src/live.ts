import { api, type Change } from "./api.js";

export type LiveStatus = "connecting" | "live" | "error";

const VISIBLE_INTERVAL = 3_000;
const HIDDEN_INTERVAL = 30_000;
const BATCH = 200;

/**
 * Polls the change feed of a store from `cursor`: every 3 s while the tab is visible, every 30 s when hidden,
 * immediately when it becomes visible again. Returns a function that stops polling.
 */
export function startPolling(
  store: string,
  cursor: number,
  onChanges: (changes: Change[]) => void,
  onStatus: (status: LiveStatus) => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const schedule = (delay: number) => {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(() => void tick(), delay);
  };

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    let delay = document.hidden ? HIDDEN_INTERVAL : VISIBLE_INTERVAL;
    try {
      const result = await api.changes(store, { since: cursor, limit: BATCH });
      if (stopped) return;
      if (result.changes.length > 0) {
        cursor = result.changes[result.changes.length - 1]!.id;
        onChanges(result.changes);
        if (result.changes.length === BATCH) delay = 0;
      }
      onStatus("live");
    } catch {
      if (!stopped) onStatus("error");
    } finally {
      running = false;
      schedule(delay);
    }
  };

  const onVisibility = () => {
    if (!document.hidden) schedule(0);
  };
  document.addEventListener("visibilitychange", onVisibility);
  schedule(0);

  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
