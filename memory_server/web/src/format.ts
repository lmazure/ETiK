/** "14:03:12" today, "Oct 6, 14:03" otherwise. */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export function formatDelta(bytes: number): string {
  return bytes === 0 ? "±0" : bytes > 0 ? `+${bytes}` : `${bytes}`;
}

export const OP_LABEL: Record<string, string> = {
  create: "created",
  overwrite: "overwritten",
  edit: "edited",
  move: "moved",
  delete: "deleted",
  restore: "restored",
};
