/**
 * A work item (issue, task, epic…) with its context: hierarchy, linked items, merge requests and comments,
 * read through the GraphQL API (`namespace.workItem` serves both project and group work items).
 */
import { AnalystError } from "../errors.js";
import type { GitLabClient } from "./client.js";
import { parseRef, type Ref, type RefContext } from "./refs.js";

export interface MergeRequestSummary {
  ref: Ref;
  title: string;
  state: string;
  url: string;
  sourceBranch: string;
  targetBranch: string;
  mergedAt: string | undefined;
  mergeCommitSha: string | undefined;
  pipelineStatus: string | undefined;
}

export interface ItemSummary {
  ref: Ref;
  title: string;
  state: string;
  type: string;
  url: string;
  labels: string[];
  /**
   * States of the merge requests of the item (closing and related, without duplicates); undefined when they were
   * not read (beyond MAX_RELATED_LOOKUPS items).
   */
  mergeRequestStates: string[] | undefined;
}

export interface Comment {
  author: string;
  createdAt: string;
  body: string;
}

export interface WorkItem extends ItemSummary {
  author: string | undefined;
  createdAt: string;
  updatedAt: string;
  closedAt: string | undefined;
  status: string | undefined;
  milestone: string | undefined;
  assignees: string[];
  weight: number | undefined;
  customFields: { name: string; value: string }[];
  description: string;
  /** From the root down to the parent. */
  ancestors: ItemSummary[];
  /** The other children of the parent. */
  siblings: ItemSummary[];
  children: ItemSummary[];
  linkedItems: { linkType: string; item: ItemSummary }[];
  mergeRequests: MergeRequestSummary[];
  /** The last comments (non-system notes), oldest first. */
  comments: Comment[];
  commentsTotal: number;
}

const MAX_DEPTH = 10;
/** GitLab serves `relatedMergeRequests` for one work item per query: at most this many extra queries per call. */
const MAX_RELATED_LOOKUPS = 30;
const LOOKUP_CONCURRENCY = 6;

const SUMMARY = `
fragment ItemSummary on WorkItem {
  iid title state webUrl
  workItemType { name }
  widgets {
    type
    ... on WorkItemWidgetLabels { labels(first: 50) { nodes { title } } }
    ... on WorkItemWidgetDevelopment {
      closingMergeRequests(first: 20) { nodes { mergeRequest { iid state webUrl } } }
    }
  }
}`;

const MERGE_REQUEST = `
fragment MergeRequestSummary on MergeRequest {
  iid title state webUrl sourceBranch targetBranch mergedAt mergeCommitSha
  headPipeline { status }
}`;

export const WORK_ITEM_QUERY = `
query AnalystWorkItem($fullPath: ID!, $iid: String!) {
  namespace(fullPath: $fullPath) {
    workItem(iid: $iid) {
      ...ItemSummary
      createdAt updatedAt closedAt
      author { username }
      widgets {
        type
        ... on WorkItemWidgetDescription { description }
        ... on WorkItemWidgetAssignees { assignees(first: 20) { nodes { username } } }
        ... on WorkItemWidgetMilestone { milestone { title } }
        ... on WorkItemWidgetStatus { status { name } }
        ... on WorkItemWidgetWeight { weight }
        ... on WorkItemWidgetCustomFields {
          customFieldValues {
            customField { name }
            ... on WorkItemNumberFieldValue { value }
            ... on WorkItemTextFieldValue { value }
            ... on WorkItemSelectFieldValue { selectedOptions { value } }
          }
        }
        ... on WorkItemWidgetHierarchy {
          parent { iid webUrl }
          children(first: 50) { nodes { ...ItemSummary } }
        }
        ... on WorkItemWidgetLinkedItems {
          linkedItems(first: 50) { nodes { linkType workItem { ...ItemSummary } } }
        }
        ... on WorkItemWidgetDevelopment {
          closingMergeRequests(first: 20) { nodes { mergeRequest { ...MergeRequestSummary } } }
          relatedMergeRequests(first: 20) { nodes { ...MergeRequestSummary } }
        }
        ... on WorkItemWidgetNotes {
          discussions(first: 100, filter: ONLY_COMMENTS) {
            nodes { notes(first: 100) { nodes { body system createdAt author { username } } } }
          }
        }
      }
    }
  }
}
${SUMMARY}
${MERGE_REQUEST}`;

export const FAMILY_QUERY = `
query AnalystWorkItemFamily($fullPath: ID!, $iid: String!) {
  namespace(fullPath: $fullPath) {
    workItem(iid: $iid) {
      ...ItemSummary
      widgets {
        type
        ... on WorkItemWidgetHierarchy {
          parent { iid webUrl }
          children(first: 50) { nodes { ...ItemSummary } }
        }
      }
    }
  }
}
${SUMMARY}`;

export const RELATED_QUERY = `
query AnalystRelatedMergeRequests($fullPath: ID!, $iid: String!) {
  namespace(fullPath: $fullPath) {
    workItem(iid: $iid) {
      widgets {
        type
        ... on WorkItemWidgetDevelopment { relatedMergeRequests(first: 20) { nodes { iid state webUrl } } }
      }
    }
  }
}`;

export const UPDATED_AT_QUERY = `
query AnalystWorkItemUpdatedAt($fullPath: ID!, $iid: String!) {
  namespace(fullPath: $fullPath) { workItem(iid: $iid) { iid title state webUrl workItemType { name } updatedAt widgets { type } } }
}`;

/* Raw GraphQL shapes: only what is read. Every widget field is optional, as widgets vary by work item type. */
interface RawWidget {
  type: string;
  description?: string | null;
  labels?: { nodes: { title: string }[] };
  assignees?: { nodes: { username: string }[] };
  milestone?: { title: string } | null;
  status?: { name: string } | null;
  weight?: number | null;
  customFieldValues?: { customField: { name: string }; value?: string | number | null; selectedOptions?: { value: string }[] }[];
  parent?: { iid: string; webUrl: string } | null;
  children?: { nodes: RawWorkItem[] };
  linkedItems?: { nodes: { linkType: string; workItem: RawWorkItem | null }[] };
  closingMergeRequests?: { nodes: { mergeRequest: RawMergeRequest | null }[] };
  relatedMergeRequests?: { nodes: RawMergeRequest[] };
  discussions?: { nodes: { notes: { nodes: { body: string; system: boolean; createdAt: string; author: { username: string } | null }[] } }[] };
}

interface RawWorkItem {
  iid: string;
  title: string;
  state: string;
  webUrl: string;
  workItemType: { name: string };
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string | null;
  author?: { username: string } | null;
  widgets: RawWidget[];
}

interface RawMergeRequest {
  iid: string;
  title?: string;
  state: string;
  webUrl?: string;
  sourceBranch?: string;
  targetBranch?: string;
  mergedAt?: string | null;
  mergeCommitSha?: string | null;
  headPipeline?: { status: string } | null;
}

type NamespaceData = { namespace: { workItem: RawWorkItem | null } | null };

/** The fields of the widgets merged into one object (the main query selects some widgets twice). */
function widgets(raw: RawWorkItem): RawWidget {
  return Object.assign({ type: "" }, ...raw.widgets) as RawWidget;
}

function mergeRequestSummary(raw: RawMergeRequest, context: RefContext): MergeRequestSummary {
  const url = raw.webUrl ?? "";
  return {
    ref: parseRef(url, "merge_request", context),
    title: raw.title ?? "",
    state: raw.state,
    url,
    sourceBranch: raw.sourceBranch ?? "",
    targetBranch: raw.targetBranch ?? "",
    mergedAt: raw.mergedAt ?? undefined,
    mergeCommitSha: raw.mergeCommitSha ?? undefined,
    pipelineStatus: raw.headPipeline?.status,
  };
}

/** Closing and related merge requests, without duplicates (closing ones first). */
function rawMergeRequests(w: RawWidget): RawMergeRequest[] {
  const all = [
    ...(w.closingMergeRequests?.nodes ?? []).map((n) => n.mergeRequest).filter((mr): mr is RawMergeRequest => mr !== null),
    ...(w.relatedMergeRequests?.nodes ?? []),
  ];
  const seen = new Set<string>();
  return all.filter((mr) => {
    const key = mr.webUrl ?? mr.iid;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The merge requests a summary was built from, to merge the related ones read later without duplicates. */
const mergeRequestsOf = new WeakMap<ItemSummary, RawMergeRequest[]>();

function summary(raw: RawWorkItem, context: RefContext): ItemSummary {
  const w = widgets(raw);
  const item: ItemSummary = {
    ref: parseRef(raw.webUrl, "work_item", context),
    title: raw.title,
    state: raw.state,
    type: raw.workItemType.name,
    url: raw.webUrl,
    labels: (w.labels?.nodes ?? []).map((l) => l.title),
    mergeRequestStates: rawMergeRequests(w).map((mr) => mr.state),
  };
  mergeRequestsOf.set(item, rawMergeRequests(w));
  return item;
}

/** Runs `task` on each item, at most `concurrency` at a time. */
async function eachLimited<T>(items: T[], concurrency: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

function customValue(field: NonNullable<RawWidget["customFieldValues"]>[number]): string | undefined {
  if (field.selectedOptions?.length) return field.selectedOptions.map((o) => o.value).join(", ");
  return field.value === null || field.value === undefined ? undefined : String(field.value);
}

export class WorkItems {
  constructor(
    private readonly gitlab: GitLabClient,
    private readonly context: RefContext,
  ) {}

  private async fetch(query: string, ref: Ref): Promise<RawWorkItem> {
    const data = await this.gitlab.graphql<NamespaceData>(query, { fullPath: ref.path, iid: String(ref.iid) });
    const item = data.namespace?.workItem;
    if (!item) throw new AnalystError("NOT_FOUND", `Work item ${ref.path}#${ref.iid} not found, or not readable with the analyst's token.`);
    return item;
  }

  /**
   * Completes the summaries, which only carry the closing merge requests, with the related ones:
   * one query per item, for the first MAX_RELATED_LOOKUPS items; the others get undefined.
   */
  private async addRelatedMergeRequests(items: ItemSummary[]): Promise<void> {
    for (const item of items.slice(MAX_RELATED_LOOKUPS)) item.mergeRequestStates = undefined;
    await eachLimited(items.slice(0, MAX_RELATED_LOOKUPS), LOOKUP_CONCURRENCY, async (item) => {
      const related = widgets(await this.fetch(RELATED_QUERY, item.ref)).relatedMergeRequests?.nodes ?? [];
      const known = mergeRequestsOf.get(item) ?? [];
      const urls = new Set(known.map((mr) => mr.webUrl));
      item.mergeRequestStates = [...known, ...related.filter((mr) => !urls.has(mr.webUrl))].map((mr) => mr.state);
    });
  }

  /** When the work item was last updated (its description, labels, comments…). */
  async updatedAt(ref: Ref): Promise<string> {
    return (await this.fetch(UPDATED_AT_QUERY, ref)).updatedAt ?? "";
  }

  async get(ref: Ref, maxComments: number): Promise<WorkItem> {
    const raw = await this.fetch(WORK_ITEM_QUERY, ref);
    const w = widgets(raw);

    const ancestors: ItemSummary[] = [];
    let siblings: ItemSummary[] = [];
    let parent = w.parent ?? null;
    while (parent && ancestors.length < MAX_DEPTH) {
      const family = await this.fetch(FAMILY_QUERY, parseRef(parent.webUrl, "work_item", this.context));
      const fw = widgets(family);
      if (ancestors.length === 0) {
        siblings = (fw.children?.nodes ?? []).filter((c) => c.webUrl !== raw.webUrl).map((c) => summary(c, this.context));
      }
      ancestors.unshift(summary(family, this.context));
      parent = fw.parent ?? null;
    }

    const notes = (w.discussions?.nodes ?? [])
      .flatMap((d) => d.notes.nodes)
      .filter((n) => !n.system)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const children = (w.children?.nodes ?? []).map((c) => summary(c, this.context));
    const linkedItems = (w.linkedItems?.nodes ?? [])
      .filter((l) => l.workItem !== null)
      .map((l) => ({ linkType: l.linkType, item: summary(l.workItem!, this.context) }));
    // Ancestors first: the closest context matters most when the lookups are capped.
    await this.addRelatedMergeRequests([...ancestors.slice().reverse(), ...children, ...siblings, ...linkedItems.map((l) => l.item)]);

    return {
      ...summary(raw, this.context),
      author: raw.author?.username,
      createdAt: raw.createdAt ?? "",
      updatedAt: raw.updatedAt ?? "",
      closedAt: raw.closedAt ?? undefined,
      status: w.status?.name,
      milestone: w.milestone?.title,
      assignees: (w.assignees?.nodes ?? []).map((a) => a.username),
      weight: w.weight ?? undefined,
      customFields: (w.customFieldValues ?? [])
        .map((f) => ({ name: f.customField.name, value: customValue(f) }))
        .filter((f): f is { name: string; value: string } => f.value !== undefined),
      description: w.description ?? "",
      ancestors,
      siblings,
      children,
      linkedItems,
      mergeRequests: rawMergeRequests(w).map((mr) => mergeRequestSummary(mr, this.context)),
      comments: notes.slice(-maxComments).map((n) => ({ author: n.author?.username ?? "unknown", createdAt: n.createdAt, body: n.body })),
      commentsTotal: notes.length,
    };
  }
}
