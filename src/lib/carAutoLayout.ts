/**
 * The shape of the car's Home and Library tabs, with nothing fetched: what
 * goes where, under which heading and how many of each. `carAutoTree` gathers
 * the rows and this decides the order, so the decisions about what a driver
 * sees first can be read, and tested, without a server or a store behind them.
 */
import type { CarNode } from './carAuto';

/** One stretch of a tab: its rows, the heading over them and a ceiling. */
export interface CarSection {
  /** Drawn over the rows as a group title; none means plain rows. */
  heading?: string;
  nodes: CarNode[];
  /** How many of the rows are shown. The rest never leave the phone. */
  max?: number;
}

/**
 * The rows of a tab drawn as one list, section after section. A section with
 * nothing in it takes no room, heading included: an empty "Continue listening"
 * is a promise the tab cannot keep. The ceiling is applied here rather than
 * where the rows are gathered, so the same rows can be cut differently for
 * Home and for a folder in the Library.
 */
export function tabLayout(sections: CarSection[]): CarNode[] {
  const out: CarNode[] = [];
  for (const s of sections) {
    const rows = s.max === undefined ? s.nodes : s.nodes.slice(0, s.max);
    for (const node of rows) out.push(s.heading ? { ...node, group: s.heading } : node);
  }
  return out;
}

/** A drawer of the Library and how many rows it opens onto. */
export interface CarDrawer {
  node: CarNode;
  /** What is behind the row, or `null` for a drawer filled in later. */
  count: number | null;
}

/**
 * The Library's rows, without the drawers that open onto nothing: a folder
 * that opens onto an empty list is a worse thing to offer than no folder.
 * `null` is for a drawer whose rows are fetched after the lists, and it stays.
 */
export function drawerLayout(drawers: CarDrawer[]): CarNode[] {
  return drawers.filter((d) => d.count === null || d.count > 0).map((d) => d.node);
}

/**
 * Whether a set of rows has outgrown Home. A few of them sit on Home under
 * "Continue listening"; past that the rest go behind a drawer in the Library,
 * so Home stays a screen and not a scroll.
 */
export function overflowsHome(count: number, homeMax: number): boolean {
  return count > homeMax;
}
