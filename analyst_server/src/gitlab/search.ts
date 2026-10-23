/** Search of work items (issues) and merge requests in a group or a project, through the REST API. */
import { encodePath, type GitLabClient } from "./client.js";
import { parseRef, type Ref, type RefContext } from "./refs.js";

export interface SearchHit {
  ref: Ref;
  title: string;
  state: string;
  labels: string[];
  updatedAt: string;
  url: string;
}

export interface SearchRequest {
  query: string;
  kind: "work_item" | "merge_request";
  state: "opened" | "closed" | "merged" | "all";
  labels: string[];
  /** A project path; undefined: the search group. */
  project: string | undefined;
  limit: number;
}

interface RawHit { title: string; state: string; labels: string[]; updated_at: string; web_url: string }

export class Search {
  constructor(
    private readonly gitlab: GitLabClient,
    private readonly context: RefContext,
    private readonly group: string,
  ) {}

  /** Searched in the title and the description, most recently updated first. */
  async run(request: SearchRequest): Promise<{ scope: string; hits: SearchHit[] }> {
    const scope = request.project ?? this.group;
    const container = request.project ? `/projects/${encodePath(request.project)}` : `/groups/${encodePath(this.group)}`;
    const resource = request.kind === "work_item" ? "issues" : "merge_requests";
    const raw = await this.gitlab.rest<RawHit[]>(`${container}/${resource}`, {
      search: request.query,
      in: "title,description",
      state: request.state === "all" ? undefined : request.state,
      labels: request.labels.length ? request.labels.join(",") : undefined,
      order_by: "updated_at",
      sort: "desc",
      per_page: request.limit,
    });
    return {
      scope,
      hits: raw.map((h) => ({
        ref: parseRef(h.web_url, request.kind, this.context),
        title: h.title,
        state: h.state,
        labels: h.labels,
        updatedAt: h.updated_at,
        url: h.web_url,
      })),
    };
  }
}
