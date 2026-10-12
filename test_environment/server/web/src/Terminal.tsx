import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef } from "preact/hooks";
import type { SessionState } from "./api.js";

export interface TerminalHandle {
  size(): { cols: number; rows: number };
  focus(): void;
}

/**
 * The terminal of the session, attached to /api/terminal. It reconnects when the connection drops;
 * the server replays its scrollback, so a reload gets the screen back.
 */
export function Terminal({ onState, onConnected, handle }: {
  onState: (state: SessionState) => void;
  onConnected: (connected: boolean) => void;
  handle: { current: TerminalHandle | undefined };
}) {
  const container = useRef<HTMLDivElement>(null);
  // The latest callbacks, without re-creating the terminal.
  const callbacks = useRef({ onState, onConnected });
  callbacks.current = { onState, onConnected };

  useEffect(() => {
    const term = new XTerm({
      cursorBlink: true,
      fontFamily: 'ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      scrollback: 10_000,
      theme: { background: "#15181e" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container.current!);
    fit.fit();
    handle.current = { size: () => ({ cols: term.cols, rows: term.rows }), focus: () => term.focus() };

    let socket: WebSocket | undefined;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const send = (message: object) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };

    const connect = () => {
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/terminal`);
      socket = ws;
      let first = true;
      ws.onopen = () => {
        callbacks.current.onConnected(true);
        send({ type: "resize", cols: term.cols, rows: term.rows });
      };
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data as string);
        if (message.type === "state") {
          const state = message.state as SessionState;
          // A new session, or a reconnection that replays the scrollback: start from a clean screen.
          if (first || state.status === "starting") term.reset();
          first = false;
          callbacks.current.onState(state);
        } else if (message.type === "output") {
          term.write(message.data as string);
        }
      };
      ws.onclose = () => {
        callbacks.current.onConnected(false);
        if (!closed) retry = setTimeout(connect, 2000);
      };
    };
    connect();

    const input = term.onData((data) => send({ type: "input", data }));
    const observer = new ResizeObserver(() => {
      fit.fit();
      send({ type: "resize", cols: term.cols, rows: term.rows });
    });
    observer.observe(container.current!);

    return () => {
      closed = true;
      clearTimeout(retry);
      observer.disconnect();
      input.dispose();
      socket?.close();
      term.dispose();
      handle.current = undefined;
    };
  }, []);

  return <div class="terminal-host" ref={container} />;
}
