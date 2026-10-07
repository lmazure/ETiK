import { useEffect } from "preact/hooks";
import { api } from "../api.js";
import { currentStore, liveCount, loadError, navigate, openStore, route, stores, token, treeDocs, deletedDocs } from "../state.js";
import { ErrorMessage, Loading } from "./common.js";
import { DiffView } from "./DiffView.js";
import { DocumentView } from "./DocumentView.js";
import { Header } from "./Header.js";
import { HistoryPanel } from "./HistoryPanel.js";
import { Login } from "./Login.js";
import { SearchResults } from "./SearchResults.js";
import { Sidebar } from "./Sidebar.js";

export function App() {
  if (!token.value) return <Login />;
  return <Main />;
}

function Main() {
  const current = route.value;

  useEffect(() => {
    api.stores().then((list) => {
      stores.value = list;
      if (current.name === "none" && list[0]) navigate({ name: "store", store: list[0].name });
    }, (error: Error) => (loadError.value = error.message));
  }, []);

  useEffect(() => {
    if (current.name !== "none") void openStore(current.store);
  }, [current.name === "none" ? undefined : current.store]);

  const store = currentStore.value;
  return (
    <div class="app">
      <Header />
      <div class="layout">
        <Sidebar />
        <main class="content">
          {loadError.value && <ErrorMessage message={loadError.value} />}
          {!store ? <Loading /> : <Content />}
        </main>
        {(current.name === "doc" || current.name === "diff") && (
          <HistoryPanel key={`${current.store}/${current.id}`} store={current.store} id={current.id}
            diff={current.name === "diff" ? { from: current.from, to: current.to } : undefined} />
        )}
      </div>
    </div>
  );
}

function Content() {
  const current = route.value;
  switch (current.name) {
    case "doc":
      return <DocumentView key={`${current.store}/${current.id}/${current.version ?? ""}`} store={current.store} id={current.id}
        version={current.version} line={current.line} />;
    case "diff":
      return <DiffView store={current.store} id={current.id} from={current.from} to={current.to} />;
    case "search":
      return <SearchResults store={current.store} query={current.query} />;
    default:
      return <StoreHome />;
  }
}

function StoreHome() {
  const docs = [...treeDocs.value.values()];
  const live = docs.filter((d) => !d.gone).length;
  const deleted = deletedDocs.value.length + docs.filter((d) => d.gone === "deleted").length;
  return (
    <article class="home">
      <h2>{currentStore.value}</h2>
      <p>{live} document{live === 1 ? "" : "s"} · {deleted} deleted · {liveCount.value} change{liveCount.value === 1 ? "" : "s"} since load</p>
      <p class="muted">
        Pick a document on the left to read it and browse its history, or open the Activity tab to follow what changes.
        Changes made while this page is open are marked in the tree and listed in Activity and History;
        a document you are reading is never replaced: a banner points to the newer version instead.
      </p>
    </article>
  );
}
