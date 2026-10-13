import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkId, CONFIG_FILE, type ConfigFile, ConfigurationError, relativePath, skillNames, validateConfiguration } from "./configuration.js";

export interface Configuration {
  id: string;
  config: ConfigFile;
  /** Names of its skills (its folders `skills/<name>/`), sorted. */
  skills: string[];
  /** Paths of its files, relative to its folder, sorted. */
  files: string[];
  uploadedAt: string;
  /** Absolute path of its folder. */
  dir: string;
}

/** The uploaded configurations, one folder each under `<stateDir>/configurations`. */
export class ConfigurationStore {
  private readonly root: string;

  constructor(stateDir: string) {
    this.root = join(stateDir, "configurations");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  /** Validates and stores a configuration, replacing the one with the same id. */
  save(id: string, files: ReadonlyMap<string, Buffer>): Configuration {
    checkId(id);
    validateConfiguration(files);
    const staging = join(this.root, `.${id}.upload`);
    rmSync(staging, { recursive: true, force: true });
    for (const [path, content] of files) {
      const target = join(staging, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    const dir = join(this.root, id);
    rmSync(dir, { recursive: true, force: true });
    renameSync(staging, dir);
    return this.get(id);
  }

  get(id: string): Configuration {
    checkId(id);
    const dir = join(this.root, id);
    if (!existsSync(join(dir, CONFIG_FILE))) throw new ConfigurationError([`unknown configuration '${id}'`], 404);
    const files = new Map<string, Buffer>();
    for (const path of listFiles(dir)) files.set(path, readFileSync(join(dir, path)));
    // Validated again: a new image may have new rules.
    const config = validateConfiguration(files);
    const paths = [...files.keys()].sort();
    return { id, config, skills: skillNames(paths), files: paths, uploadedAt: statSync(dir).mtime.toISOString(), dir };
  }

  /** Content of one file of a configuration (path relative to its folder). */
  readFile(id: string, path: string): Buffer {
    const configuration = this.get(id);
    const relative = relativePath(path);
    if (!configuration.files.includes(relative)) throw new ConfigurationError([`unknown file '${relative}'`], 404);
    return readFileSync(join(configuration.dir, relative));
  }

  list(): Array<Configuration | { id: string; problems: string[] }> {
    return readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort()
      .map((id) => {
        try {
          return this.get(id);
        } catch (error) {
          return { id, problems: error instanceof ConfigurationError ? error.problems : [String(error)] };
        }
      });
  }

  delete(id: string): void {
    checkId(id);
    const dir = join(this.root, id);
    if (!existsSync(dir)) throw new ConfigurationError([`unknown configuration '${id}'`], 404);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Paths of the files under `dir`, relative to it, with '/' separators. */
export function listFiles(dir: string, prefix = ""): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) paths.push(...listFiles(dir, path));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}
