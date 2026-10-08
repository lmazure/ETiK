import { useEffect, useState } from "preact/hooks";
import { currentStore, liveCount, liveStatus, logOut, navigate, route, sidebarTab, stores } from "../state.js";

export function Header() {
  const store = currentStore.value;
  const current = route.value;
  const [query, setQuery] = useState(current.name === "search" ? current.query : "");
  useEffect(() => {
    if (current.name === "search") setQuery(current.query);
  }, [current]);

  const status = liveStatus.value;
  const count = liveCount.value;

  return (
    <header class="topbar">
      <span class="brand">Memory</span>
      {stores.value.length > 1 ? (
        <select aria-label="Store" value={store} onChange={(e) => navigate({ name: "store", store: (e.target as HTMLSelectElement).value })}>
          {stores.value.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
        </select>
      ) : (
        <span class="store-name">{store}</span>
      )}
      <form class="search" role="search" onSubmit={(e) => {
        e.preventDefault();
        if (store && query.trim()) navigate({ name: "search", store, query: query.trim() });
      }}>
        <input type="search" placeholder="Search the memory…" aria-label="Search" value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
      </form>
      <button type="button" class={`live live-${status}`} onClick={() => (sidebarTab.value = "activity")}
        title="Changes are checked every few seconds; the open document is never replaced">
        <span class="dot" aria-hidden="true" />
        {status === "live" ? "live" : status === "error" ? "connection lost, retrying" : "connecting"}
        {" · "}{count === 0 ? "no change since load" : `${count} change${count === 1 ? "" : "s"} since load`}
      </button>
      <button type="button" class="link" onClick={logOut}>Log out</button>
    </header>
  );
}
