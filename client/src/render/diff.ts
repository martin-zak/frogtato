// Pure entity-id diffing — no Phaser import, no side effects, no DOM
// requirement. Kept in its own module (separate from entities.ts) so it can
// be unit-tested under plain Node/vitest: importing Phaser eagerly touches
// `navigator` at module-load time, which blows up outside a browser/DOM
// environment, so entities.ts (which does `import Phaser from "phaser"`)
// cannot be imported from a DOM-less test.

export interface EntityDiff<T> {
  create: T[];
  update: T[];
  destroy: string[];
}

/**
 * Diffs the previously-known set of entity ids against the current snapshot
 * array (keyed by `id`), returning which entities are new (create), still
 * present (update), or gone (destroy).
 */
export function diffEntities<T extends { id: string }>(
  prevIds: ReadonlySet<string>,
  current: readonly T[],
): EntityDiff<T> {
  const create: T[] = [];
  const update: T[] = [];
  const seen = new Set<string>();

  for (const entity of current) {
    seen.add(entity.id);
    if (prevIds.has(entity.id)) {
      update.push(entity);
    } else {
      create.push(entity);
    }
  }

  const destroy: string[] = [];
  for (const id of prevIds) {
    if (!seen.has(id)) destroy.push(id);
  }

  return { create, update, destroy };
}
