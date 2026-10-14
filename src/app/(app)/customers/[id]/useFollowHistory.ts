"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { loadFollowHistory, readFollowHistoryRow, type FollowHistoryCursor } from "./follow-history-actions";
import type { FollowUpRow } from "./types";

type HistoryState = { customerId: string; rows: FollowUpRow[]; hidden: string[]; cursor: FollowHistoryCursor | undefined; hasMore: boolean; paged: boolean };
const cursorOf = (row?: FollowUpRow): FollowHistoryCursor | undefined => row && { occurredAt: row.occurredAt, id: row.id };
function mergeRows(...groups: FollowUpRow[][]): FollowUpRow[] {
  const rows = new Map<string, FollowUpRow>();
  for (const group of groups) for (const row of group) {
    const previous = rows.get(row.id);
    if (!previous || row.updatedAt >= previous.updatedAt) rows.set(row.id, row);
  }
  return [...rows.values()].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

export function useFollowHistory(customerId: string, head: FollowUpRow[], headHasMore: boolean) {
  const [state, setState] = useState<HistoryState | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const currentCustomer = useRef<string | null>(customerId);
  useLayoutEffect(() => { currentCustomer.current = customerId; return () => { currentCustomer.current = null; }; }, [customerId]);
  const request = useRef<symbol | null>(null);
  const current = state?.customerId === customerId ? state : null;
  const rows = mergeRows(current?.rows ?? [], head).filter(row => !current?.hidden.includes(row.id));

  async function loadMore() {
    if (pending === customerId) return;
    const ticket = Symbol(); request.current = ticket; setPending(customerId);
    const base: HistoryState = current ?? { customerId, rows: head, hidden: [], cursor: cursorOf(head.at(-1)), hasMore: headHasMore, paged: false };
    try {
      const result = await loadFollowHistory(customerId, base.cursor);
      if (currentCustomer.current !== customerId || request.current !== ticket) return;
      if (!result.ok) throw new Error(result.error);
      setState(previous => {
        const valid = previous?.customerId === customerId ? previous : base;
        return { ...valid, rows: mergeRows(valid.rows, head, result.rows), cursor: cursorOf(result.rows.at(-1)) ?? base.cursor, hasMore: result.hasMore, paged: true };
      });
    } finally { if (request.current === ticket) setPending(null); }
  }

  function remove(id: string) {
    setState(previous => {
      const valid = previous?.customerId === customerId ? previous : { customerId, rows: head, hidden: [], cursor: cursorOf(head.at(-1)), hasMore: headHasMore, paged: false };
      return { ...valid, hidden: [...new Set([...valid.hidden, id])] };
    });
  }

  async function refreshRow(id: string) {
    const result = await readFollowHistoryRow(customerId, id);
    if (currentCustomer.current !== customerId) return;
    if (!result.ok) throw new Error(result.error);
    if (!result.row) { remove(id); return; }
    const row = result.row;
    setState(previous => {
      const valid = previous?.customerId === customerId ? previous : { customerId, rows: head, hidden: [], cursor: cursorOf(head.at(-1)), hasMore: headHasMore, paged: false };
      return { ...valid, rows: mergeRows(valid.rows, [row]), hidden: valid.hidden.filter(value => value !== id) };
    });
  }

  function reset() { request.current = null; setPending(null); setState(null); }
  return { rows, paged: current?.paged ?? false, hasMore: current?.paged ? current.hasMore : headHasMore, loading: pending === customerId, loadMore, remove, refreshRow, reset };
}
