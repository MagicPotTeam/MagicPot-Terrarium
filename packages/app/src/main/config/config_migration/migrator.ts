export type Migrator<OUT> = {
  migrate: (config: unknown) => OUT
}
