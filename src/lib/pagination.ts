/**
 * PRSprint 26 (docs/prsprints/PRSPRINT_26_SEARCH_FILTER_PAGINATION_RECORD_MANAGEMENT.md): shared
 * server-side pagination contract — "Do not load an unbounded production dataset into the browser.
 * Pagination must occur server-side/database-side where appropriate." No "server-only" import so this
 * can also be imported by a client component that needs to build the next page's query string.
 *
 * Repositories fetch `limit + 1` rows and this module's `toPage` helper drops the extra row while
 * setting `hasMore` — a single query per page, no separate COUNT(*) round trip (avoiding the N+1-
 * adjacent "one query to page, one query to count" pattern the spec explicitly asks to avoid).
 */

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export interface PageParams {
  limit: number;
  offset: number;
}

export interface Page<T> {
  items: T[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

/** Parses and clamps `limit`/`offset` query params. Malformed/out-of-range input falls back to safe defaults rather than throwing — pagination is a UX convenience, not a field a client request should be rejected over. */
export function parsePageParams(searchParams: URLSearchParams): PageParams {
  const rawLimit = Number(searchParams.get("limit"));
  const rawOffset = Number(searchParams.get("offset"));
  const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_PAGE_LIMIT) : DEFAULT_PAGE_LIMIT;
  const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  return { limit, offset };
}

/** Given rows fetched with `limit: params.limit + 1`, returns the page (at most `params.limit` items) and whether more exist. */
export function toPage<T>(rowsFetchedWithLimitPlusOne: T[], params: PageParams): Page<T> {
  const hasMore = rowsFetchedWithLimitPlusOne.length > params.limit;
  return {
    items: hasMore ? rowsFetchedWithLimitPlusOne.slice(0, params.limit) : rowsFetchedWithLimitPlusOne,
    limit: params.limit,
    offset: params.offset,
    hasMore,
  };
}
