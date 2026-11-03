// Infinite catalogue query for the Browse tab.
//
// The page owns the filter state (pure, serialisable) and this hook turns it
// into `GET /jobs/catalogue` pages. `placeholderData` keeps the previous rows
// and facet counts on screen while a new filtered set loads, so the rail never
// blanks between checkbox clicks; React Query still re-keys the query on every
// filter change, which is what makes "Load more" append only the current set.

import { useInfiniteQuery } from '@tanstack/react-query';
import { jobsApi } from '@/services/api/jobs';
import type { CatalogueResponse } from '@/services/api/jobs';
import {
  buildCatalogueParams,
  catalogueQueryKey,
  type CatalogueFilterState,
} from '@/features/jobs/catalogueParams';

export function useCatalogue(filters: CatalogueFilterState, enabled = true) {
  return useInfiniteQuery<CatalogueResponse>({
    queryKey: catalogueQueryKey(filters),
    queryFn: ({ pageParam }) =>
      jobsApi.catalogue({ ...buildCatalogueParams(filters), page: pageParam as number }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const { page, total, limit } = lastPage.meta;
      const pageSize = limit > 0 ? limit : filters.limit;
      return page * pageSize < total ? page + 1 : undefined;
    },
    placeholderData: (previousData) => previousData,
    staleTime: 30_000,
    enabled,
  });
}
