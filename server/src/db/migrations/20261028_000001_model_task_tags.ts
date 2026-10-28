// Migration: verified task tags for model discovery and selection
// Created: 2026-10-28
//
// Task tags are optional metadata supplied by the signed catalog. They are
// separate from runtime availability and from supports_vision (which means
// image input, not image generation). Empty tags mean "not classified", not
// "unsupported". Catalog documents predating taskTags must not erase tags
// already applied by a newer catalog.
//
// Guarded because migrations may be replayed over a live schema.

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(col => col.name === column);
}

export function up(db: Db): void {
  if (!hasColumn(db, 'models', 'task_tags_json')) {
    db.prepare("ALTER TABLE models ADD COLUMN task_tags_json TEXT NOT NULL DEFAULT '[]'").run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'models', 'task_tags_json')) {
    db.prepare('ALTER TABLE models DROP COLUMN task_tags_json').run();
  }
}
