/** `@/lib/query`: a query client that runs every query and caches nothing. */
export const queryClient = {
  invalidated: 0,
  async invalidateQueries(): Promise<void> {
    this.invalidated++;
  },
  fetchQuery<T>(options: { queryKey: unknown[]; queryFn: () => Promise<T> }): Promise<T> {
    return options.queryFn();
  },
};
