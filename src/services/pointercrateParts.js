/**
 * The three parts of the Pointercrate Demon List, and how to read them.
 *
 * Pointercrate publishes one ranked sequence of 702 demons and splits it into
 * three named lists by position, not as three separate datasets. The single API
 * endpoint paginates that whole sequence with `after=<position>`, so a part is a
 * slice of one series rather than a different query:
 *
 *   Main      positions 1-75     the ranked list proper
 *   Extended  positions 76-150   the hard end of it, listed separately
 *   Legacy    positions 151-702  everything that has since been pushed off
 *
 * These are read off the site's own index page, which renders all three in the
 * dropdowns at the top (`mainlist`, `extended`, `legacy`), and their union is
 * exactly 1-702 with no gaps and no overlap.
 *
 * The 75/75 split is the site's, not a rounding of the top 150: the "Main List"
 * dropdown holds 75 rows and the "Extended List" dropdown holds the next 75.
 * Reading the whole ranked top 150 as Main is wrong, and it was wrong here for a
 * while -- the visible page renders all 150 rows, which is what makes it look
 * like one list. The dropdowns are the part the site actually offers.
 *
 * Because the three do not overlap, ticking two of them is always worth
 * something, and there is never a demon to de-duplicate. See
 * `pointercratePartRanges`, which still collapses overlap rather than assuming
 * there is none.
 *
 * Nothing here hardcodes a demon count as the source of truth. A range whose end
 * is past the last position the API actually returned is simply cut short when
 * the parts are applied, so Pointercrate growing or shrinking never breaks a
 * saved preference -- it just moves the edge.
 */

/** The parts, in the order the site lists them. `id` is what the cookie stores. */
export const POINTERCRATE_PARTS = [
  {
    id: 'main',
    label: 'Main list',
    key: 'lists.pointercrateMain',
    from: 1,
    to: 75,
    // Shown under the tick boxes. Deliberately short: three of these sit in a
    // row, and a sentence each would push the rest of the form off screen.
    note: 'The ranked list, positions 1 to 75.',
  },
  {
    id: 'extended',
    label: 'Extended list',
    key: 'lists.pointercrateExtended',
    from: 76,
    to: 150,
    note: 'The rest of the ranked list, positions 76 to 150.',
  },
  {
    id: 'legacy',
    label: 'Legacy list',
    key: 'lists.pointercrateLegacy',
    from: 151,
    to: 702,
    note: 'Everything that has since been pushed off the list. Positions 151 and below.',
  },
]

/**
 * The default: the whole ranked list, and nothing else.
 *
 * Both of the ranked parts are on by default rather than just Main, because
 * together they are the top 150 -- which is what this source played before the
 * parts existed. Defaulting to Main alone would quietly shrink the pool from 150
 * to 75 for everyone who never touches the boxes, which is a change to the game
 * dressed up as a default.
 */
export const DEFAULT_POINTERCRATE_PARTS = ['main', 'extended']

const KNOWN_IDS = new Set(POINTERCRATE_PARTS.map((part) => part.id))

/**
 * The ticked parts, in the site's own order, from whatever was stored.
 *
 * A missing cookie means the default rather than "nothing ticked": an empty
 * selection would leave Pointercrate with no levels at all and the run button
 * would have nothing to draw from. An unrecognised id is dropped rather than
 * trusted, so a hand-edited cookie cannot ask for a part that does not exist.
 * Order is normalised so the draw is the same however the cookie was written.
 */
export const normalizePointercrateParts = (value) => {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const chosen = raw.map((part) => String(part).trim()).filter((part) => KNOWN_IDS.has(part))

  if (!chosen.length) {
    return [...DEFAULT_POINTERCRATE_PARTS]
  }

  // Site order, not the order they were ticked in: two players who chose the
  // same three parts should get the same draw, and `Set` collapses the case
  // where someone ticks a box that is already on.
  return POINTERCRATE_PARTS.filter((part) => chosen.includes(part.id)).map((part) => part.id)
}

/**
 * The parts as position ranges, clipped to what actually loaded.
 *
 * The three lists do not overlap, so ticking any combination is additive and no
 * demon is ever handed out twice. The overlap handling below is kept anyway: it
 * is a few lines, and a range that grew into its neighbour later would otherwise
 * quietly double every demon in the overlap. Cheap insurance, and the test below
 * holds it to that.
 *
 * Ranges are clipped to the highest position actually loaded, so a part whose
 * end runs past the end of the list simply stops there.
 */
export const pointercratePartRanges = (parts, highestPosition) => {
  const wanted = new Set(normalizePointercrateParts(parts))
  const ceiling = Number.isFinite(Number(highestPosition)) && Number(highestPosition) > 0
    ? Math.trunc(Number(highestPosition))
    : Number.POSITIVE_INFINITY

  const ranges = []
  for (const part of POINTERCRATE_PARTS) {
    if (!wanted.has(part.id)) continue

    const from = part.from
    const to = Math.min(part.to, ceiling)
    if (to < from) continue

    /* Already covered by an earlier part. The three ranges are disjoint today,
     * so this never fires -- it is here so that widening one range into its
     * neighbour cannot silently hand the same demon to the roulette twice. */
    const previous = ranges[ranges.length - 1]
    if (previous && from <= previous.to) {
      previous.to = Math.max(previous.to, to)
      continue
    }

    ranges.push({ id: part.id, from, to })
  }

  return ranges
}

/** True when the selection covers the whole ranked sequence, i.e. every position. */
export const isEveryPosition = (ranges, highestPosition) => {
  if (!ranges.length) return false
  const first = ranges[0]
  const last = ranges[ranges.length - 1]
  return first.from <= 1 && last.to >= Number(highestPosition)
}

/** The part labels as a map, for anything that needs to name a part. */
const PART_LABELS = Object.fromEntries(POINTERCRATE_PARTS.map((part) => [part.id, part.label]))

/**
 * The short names for a selection, e.g. "Main + Extended", or '' when there is
 * nothing to say.
 *
 * Lives here rather than in the badge component so that file only exports a
 * component: a module exporting both is one where React Fast Refresh cannot
 * work, which shows up as the whole page reloading on every edit in
 * development. The " list" suffix is dropped because a badge reading "Main list +
 * Extended list" is twice the width of one reading "Main + Extended".
 */
export const pointercratePartsLabel = (parts) => {
  if (!Array.isArray(parts) || !parts.length) return ''

  const names = parts
    .map((id) => PART_LABELS[id])
    .filter(Boolean)
    .map((label) => label.replace(/ list$/i, ''))

  return names.length ? names.join(' + ') : ''
}