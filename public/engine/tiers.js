/**
 * Rarity tiers shared by server and client.
 * A tier is defined by how many games in the whole catalog carry a combination.
 * Ordered from rarest to most common.
 *
 * Every `id` says the same thing as its `name`, in snake_case: the ids are API
 * surface (`?forceBand=`, `tier.id` in responses), so they are kept in step with
 * the labels on purpose.
 */

export const TIERS = [
  {
    id: 'empty',
    name: 'Empty',
    min: 0,
    max: 0,
    color: '#64f5c8',
    glow: 'rgba(100, 245, 200, 0.55)',
    blurb: 'No game in the catalog has this combination.',
    // Its share of a roll when the option admits gaps. Not on the same log ladder as the
    // other bands — a gap is one outcome among a catalog of gaps — so this number is chosen
    // for how often a press should come out Empty, and the rarity bias deliberately does not
    // multiply it (`combos.js rollWeights`).
    weight: 5,
  },
  {
    id: 'almost_empty',
    name: 'Almost empty',
    min: 1,
    max: 4,
    color: '#f7ce46',
    glow: 'rgba(247, 206, 70, 0.65)',
    blurb: '1 to 4 games in the catalog.',
    weight: 1.2,
  },
  {
    id: 'very_rare',
    name: 'Very rare',
    min: 5,
    max: 24,
    color: '#eb4b4b',
    glow: 'rgba(235, 75, 75, 0.6)',
    blurb: '5 to 24 games in the catalog.',
    weight: 3.2,
  },
  {
    id: 'rare',
    name: 'Rare',
    min: 25,
    max: 99,
    color: '#e457b1',
    glow: 'rgba(228, 87, 177, 0.55)',
    blurb: '25 to 99 games in the catalog.',
    weight: 6,
  },
  {
    id: 'uncommon',
    name: 'Uncommon',
    min: 100,
    max: 499,
    color: '#a763ff',
    glow: 'rgba(167, 99, 255, 0.5)',
    blurb: '100 to 499 games in the catalog.',
    weight: 11,
  },
  {
    id: 'fairly_common',
    name: 'Fairly common',
    min: 500,
    max: 2499,
    color: '#4b7bff',
    glow: 'rgba(75, 123, 255, 0.45)',
    blurb: '500 to 2,499 games in the catalog.',
    weight: 18,
  },
  {
    id: 'common',
    name: 'Common',
    min: 2500,
    max: 9999,
    color: '#4fc3f7',
    glow: 'rgba(79, 195, 247, 0.4)',
    blurb: '2,500 to 9,999 games in the catalog.',
    weight: 25,
  },
  {
    id: 'very_common',
    name: 'Very common',
    min: 10000,
    max: Infinity,
    color: '#aab2c0',
    glow: 'rgba(170, 178, 192, 0.35)',
    blurb: '10,000 or more games in the catalog.',
    weight: 35,
  },
];

export function tierForCount(count) {
  for (const t of TIERS) {
    const max = t.max === Infinity ? Number.MAX_SAFE_INTEGER : t.max;
    if (count >= t.min && count <= max) return t;
  }
  return TIERS[TIERS.length - 1];
}

/**
 * Log-position (0..1) of a count inside its tier — drives bar fill and
 * animation intensity so a 4-game pull feels different from a 1-game pull.
 */
export function serializeTiers() {
  return TIERS.map((t) => ({
    id: t.id,
    name: t.name,
    min: t.min,
    max: t.max === Infinity ? null : t.max,
    color: t.color,
    glow: t.glow,
    blurb: t.blurb,
    weight: t.weight,
  }));
}
