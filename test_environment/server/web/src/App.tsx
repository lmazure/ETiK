import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  type ConfigurationEntry, type ConfigurationSummary, deleteConfiguration, listConfigurations, type SessionState,
  startSession, stopSession, uploadConfiguration,
} from "./api.js";
import { Terminal, type TerminalHandle } from "./Terminal.js";

const isSummary = (entry: ConfigurationEntry): entry is ConfigurationSummary => "name" in entry;

export function App() {
  const [configurations, setConfigurations] = useState<ConfigurationEntry[]>([]);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [state, setState] = useState<SessionState>({ status: "idle" });
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const terminal = useRef<TerminalHandle | undefined>(undefined);
  const upload = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async (select?: string) => {
    try {
      const { configurations } = await listConfigurations();
      setConfigurations(configurations);
      setSelected((current) => {
        const wanted = select ?? current;
        return configurations.some((c) => c.id === wanted) ? wanted : configurations.find(isSummary)?.id;
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => void refresh(), [refresh]);

  const onState = useCallback((next: SessionState) => {
    setState(next);
    if (next.configuration && next.status !== "idle") setSelected(next.configuration);
  }, []);

  const act = async (action: () => Promise<unknown>) => {
    setError(undefined);
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onUpload = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const files = input.files;
    if (!files || files.length === 0) return;
    void act(async () => {
      const summary = await uploadConfiguration(files);
      await refresh(summary.id);
    }).finally(() => { input.value = ""; });
  };

  const current = configurations.find((c) => c.id === selected);
  const idle = state.status === "idle";

  return (
    <div class="layout">
      <aside class="sidebar">
        <h1>ETiK console</h1>

        <section>
          <h2>Configurations</h2>
          {configurations.length === 0 && <p class="muted">No configuration yet: upload a configuration folder (e.g. <code>test_environment/configurations/squashtm</code>).</p>}
          <ul class="configurations">
            {configurations.map((c) => (
              <li key={c.id} class={c.id === selected ? "selected" : ""}>
                <label>
                  <input type="radio" name="configuration" checked={c.id === selected} disabled={!idle}
                    onChange={() => setSelected(c.id)} />
                  <span>{isSummary(c) ? c.name : <em>{c.id} (invalid)</em>} <span class="muted small">{c.id}</span></span>
                </label>
                <button class="link" title="Delete this configuration" disabled={busy || (!idle && state.configuration === c.id)}
                  onClick={() => confirm(`Delete the configuration '${c.id}'?`) && void act(async () => {
                    await deleteConfiguration(c.id);
                    await refresh();
                  })}>delete</button>
              </li>
            ))}
          </ul>
          <input ref={upload} type="file" hidden onChange={onUpload}
            {...{ webkitdirectory: true }} multiple />
          <button disabled={busy} onClick={() => upload.current?.click()}>Upload configuration folder…</button>
          <p class="muted small">Uploading a folder with the name of an existing configuration replaces it.</p>
        </section>

        {current && <Details configuration={current} />}

        <section>
          <h2>Session</h2>
          <p>
            <span class={`status ${state.status}`}>{state.status}</span>
            {state.session && <> <code>{state.session}</code></>}
            {state.configuration && <span class="muted"> ({state.configuration})</span>}
            {!connected && <span class="muted"> — terminal disconnected</span>}
          </p>
          {idle ? (
            <button class="primary" disabled={busy || !current || !isSummary(current)}
              onClick={() => void act(async () => {
                const { cols, rows } = terminal.current?.size() ?? { cols: 120, rows: 40 };
                await startSession(selected!, cols, rows);
                terminal.current?.focus();
              })}>Start a session</button>
          ) : (
            <button class="danger" disabled={busy || state.status !== "running"}
              onClick={() => confirm("Stop Claude Code?") && void act(stopSession)}>Stop the session</button>
          )}
          {state.status === "idle" && state.exitCode !== undefined && <p class="muted small">Claude Code exited with code {state.exitCode}.</p>}
          {error && <pre class="error">{error}</pre>}
        </section>
      </aside>

      <main class="main">
        <Terminal onState={onState} onConnected={setConnected} handle={terminal} />
      </main>
    </div>
  );
}

function Details({ configuration }: { configuration: ConfigurationEntry }) {
  if (!isSummary(configuration)) {
    return (
      <section>
        <h2>{configuration.id}</h2>
        <pre class="error">{configuration.problems.join("\n")}</pre>
      </section>
    );
  }
  const c = configuration;
  return (
    <section class="details">
      <h2>{c.name}</h2>
      <dl>
        <dt>System prompt</dt><dd><code>{c.systemPrompt}</code></dd>
        <dt>Internet domains</dt><dd>{c.domains.length ? c.domains.map((d) => <code key={d}>{d}</code>) : <span class="muted">none</span>} <span class="muted small">+ Anthropic</span></dd>
        <dt>Host ports</dt><dd>{c.hostPorts.length ? c.hostPorts.map((p) => <code key={p}>{p}</code>) : <span class="muted">none</span>}</dd>
        <dt>Built-in tools</dt><dd>{c.tools.builtin === "default" ? <span>all (<code>default</code>)</span> : c.tools.builtin.length ? c.tools.builtin.map((t) => <code key={t}>{t}</code>) : <span class="muted">none</span>}</dd>
        <dt>MCP servers</dt><dd>{c.tools.mcpServers.length ? c.tools.mcpServers.map((s) => <div key={s.name}><code>{s.name}</code> <span class="muted small">{s.type} {s.target}</span></div>) : <span class="muted">none</span>}</dd>
        <dt>Skills</dt><dd>{c.skills.length ? c.skills.map((s) => <code key={s}>{s}</code>) : <span class="muted">none</span>}</dd>
        <dt>Environment</dt><dd>{c.env.length ? c.env.map((e) => <code key={e}>{e}</code>) : <span class="muted">none</span>}</dd>
        <dt>Checks</dt><dd>{c.checks.length ? c.checks.join(", ") : <span class="muted">none</span>}</dd>
      </dl>
      <details>
        <summary class="small">{c.files.length} files, uploaded {new Date(c.uploadedAt).toLocaleString()}</summary>
        <ul class="files small">{c.files.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
      </details>
    </section>
  );
}
