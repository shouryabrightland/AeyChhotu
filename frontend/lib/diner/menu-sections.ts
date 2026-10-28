/* The diner menu, grouped the way the manager organised it.

   The admin catalogue is a tree of folders (menu_categories), and every dish
   carries a category_id. This module turns that tree + the live menu into the
   ordered sections the table screen renders: depth-first, siblings by their
   configured order, child folders nested under their parent.

   Fallbacks matter here, because a menu must never disappear because a
   category tree did not load:
     • no tree (fetch failed / older API) → group by the legacy category text
     • a dish whose folder is archived or missing → grouped by its own text
   Both end up in the same MenuSection shape, so the screen has one render
   path. */

import type { MenuItem } from "@/lib/api/types";

export interface MenuCategoryNode {
  category_id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
}

export interface MenuSection {
  /** Folder id, or `legacy:<name>` for fallback groups. */
  id: string;
  name: string;
  /** 0 = root folder / fallback group; each level indents one step. */
  depth: number;
  items: MenuItem[];
}

function sortNodes(nodes: MenuCategoryNode[]): MenuCategoryNode[] {
  return [...nodes].sort(
    (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

function legacySections(menu: MenuItem[], depth = 0): MenuSection[] {
  const groups = new Map<string, MenuItem[]>();
  for (const item of menu) {
    const name = item.category?.trim() || "More from the kitchen";
    const list = groups.get(name) ?? [];
    list.push(item);
    groups.set(name, list);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map(([name, items]) => ({
      id: `legacy:${name.toLowerCase()}`,
      name,
      depth,
      // Within a section the menu order (category, name) is already sensible.
      items,
    }));
}

export function buildMenuSections(
  menu: MenuItem[],
  categories: MenuCategoryNode[] | null,
): MenuSection[] {
  if (menu.length === 0) return [];

  if (!categories || categories.length === 0) {
    return legacySections(menu);
  }

  const known = new Set(categories.map((node) => node.category_id));
  const byParent = new Map<string | null, MenuCategoryNode[]>();
  for (const node of categories) {
    const siblings = byParent.get(node.parent_id) ?? [];
    siblings.push(node);
    byParent.set(node.parent_id, siblings);
  }
  for (const [parent, siblings] of byParent) {
    byParent.set(parent, sortNodes(siblings));
  }

  const sections: MenuSection[] = [];
  const orphanDishes: MenuItem[] = [];

  /* Explicit stack + visited set: a corrupted parent_id cycle must not hang
     the table screen, it should just stop descending. */
  const visited = new Set<string>();
  const walk = (parentId: string | null, depth: number) => {
    for (const node of byParent.get(parentId) ?? []) {
      if (visited.has(node.category_id)) continue;
      visited.add(node.category_id);

      const items = menu.filter((item) => item.category_id === node.category_id);
      if (items.length > 0) {
        sections.push({ id: node.category_id, name: node.name, depth, items });
      }

      walk(node.category_id, depth + 1);
    }
  };
  walk(null, 0);

  /* Dishes whose folder is gone (archived while the menu was cached, or never
     filed) still have to be orderable. */
  for (const item of menu) {
    if (!item.category_id || !known.has(item.category_id)) {
      orphanDishes.push(item);
    }
  }
  if (orphanDishes.length > 0) {
    sections.push(...legacySections(orphanDishes));
  }

  return sections;
}
