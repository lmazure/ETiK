export interface ConfigurationSummary {
  id: string;
  name: string;
  systemPrompt: string;
  domains: string[];
  hostPorts: number[];
  tools: {
    builtin: "default" | string[];
    mcpServers: Array<{ name: string; type: string; target: string }>;
  };
  skills: string[];
  env: string[];
  checks: string[];
  files: string[];
  uploadedAt: string;
}

/** A file of a configuration; `content` is null for a binary file. */
export interface ConfigurationFile {
  path: string;
  size: number;
  content: string | null;
}

/** A stored configuration that no longer validates (e.g. a field that a new image no longer accepts). */
export interface BrokenConfiguration {
  id: string;
  problems: string[];
}

export type ConfigurationEntry = ConfigurationSummary | BrokenConfiguration;

export interface RunState {
  status: "idle" | "starting" | "running" | "stopping";
  configuration?: string;
  startedAt?: string;
  error?: string;
  exitCode?: number;
}

export class ApiError extends Error {}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    ...(body !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (response.status === 204) return undefined as T;
  const json = await response.json().catch(() => ({ error: response.statusText }));
  if (!response.ok) {
    const problems: string[] | undefined = json.problems;
    throw new ApiError(problems && problems.length > 1 ? problems.join("\n") : json.error ?? `HTTP ${response.status}`);
  }
  return json as T;
}

export const listConfigurations = () =>
  call<{ builtinSkills: string[]; configurations: ConfigurationEntry[] }>("GET", "/api/configurations");

export const readConfigurationFile = (id: string, path: string) =>
  call<ConfigurationFile>("GET", `/api/configurations/${encodeURIComponent(id)}/files/${path.split("/").map(encodeURIComponent).join("/")}`);

export const deleteConfiguration = (id: string) => call<void>("DELETE", `/api/configurations/${encodeURIComponent(id)}`);

export const startRun = (configuration: string, cols: number, rows: number) =>
  call<RunState>("POST", "/api/run", { configuration, cols, rows });

export const stopRun = () => call<RunState>("DELETE", "/api/run");

function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Uploads the folder picked with <input webkitdirectory>: its name is the configuration id,
 * the paths are relative to it.
 */
export async function uploadConfiguration(files: FileList): Promise<ConfigurationSummary> {
  const all = [...files];
  const root = all[0]?.webkitRelativePath.split("/")[0];
  if (!root) throw new ApiError("no folder selected");
  const payload = await Promise.all(all.map(async (file) => ({
    path: file.webkitRelativePath.slice(root.length + 1),
    content: base64(await file.arrayBuffer()),
  })));
  return call<ConfigurationSummary>("PUT", `/api/configurations/${encodeURIComponent(root)}`, { files: payload });
}
