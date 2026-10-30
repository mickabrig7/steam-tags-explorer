/**
 * The snapshot file's shape, in one place.
 *
 * Two homes touch this format: the page and the local server read it, and
 * `scripts/update-snapshot.js` reads and rewrites it to keep the catalog current.
 * So the packing and unpacking live here rather
 * than being written two or three times, and this module stays portable — no
 * `node:` import, no `process` — because the browser loads these same bytes.
 * Only inflation is shared across both homes (`DecompressionStream` exists in the
 * browser and in Node alike); gzipping stays a Node-side choice, because level 9
 * is what the committed file is measured at.
 *
 * ## The container
 *
 *     "STEX" | u16 format | u32 header length | header JSON | 4-byte-aligned chunks
 *
 * The header names every chunk with its offset and length, so a loader is a stack
 * of subarray views rather than a parser, and a later version can add or reorder
 * chunks without guessing. Integer arrays start on a 4-byte boundary so either
 * side can wrap them in typed arrays without copying.
 *
 * ## Format 2: what makes the file self-updating
 *
 * Format 1 carried everything the *answers* need and nothing else. For the file
 * to update itself from Steam's public lists it also has to know what it has
 * already seen, per game, so format 2 adds one column:
 *
 *   `seen` — the `last_modified` Steam's own app list reported for that game the
 *            last time its storefront page was read. 0 means "this row came from a
 *            format 1 file", and the header's `last_sync` is the floor instead.
 *
 * With that one column the file is self-sufficient: Steam's app list says which
 * games exist and when each was last touched, so "which are new" and "which have
 * changed" are both answered from the file alone — no server, no second copy of
 * the data anywhere. Everything else in the file is exactly what it was.
 */

import { PAIR_BASE, pairKey } from './store.js';
import { normalizeKey } from './tags.js';

export const SNAPSHOT_MAGIC = 'STEX';
export const SNAPSHOT_FORMAT = 2;
export const SNAPSHOT_FORMAT_1 = 1;

/* ------------------------------- compression -------------------------------- */

/** gzip starts with these two bytes wherever it came from. */
export function looksGzipped(bytes) {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Inflate if the bytes are gzipped; pass anything else straight through. Decided
 *  from the bytes, not the filename: a host that re-encodes a `.gz`, or a Node
 *  script handing over whatever it read, both land here. */
export async function inflateIfNeeded(bytes) {
  if (!looksGzipped(bytes)) return bytes;
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('this environment cannot inflate the catalog snapshot: no DecompressionStream');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ---------------------------------- varints --------------------------------- */

/** Delta varints, LSB-first LEB128 over the differences: successive app ids are
 *  usually a handful apart, so 3.13M ids cost ~4.9 MB instead of 12.5. */
export function writeDeltaVarints(sortedValues) {
  const bytes = [];
  let prev = 0;
  for (const value of sortedValues) {
    let delta = value - prev;
    prev = value;
    while (delta >= 128) {
      bytes.push((delta & 127) | 128);
      delta >>>= 7;
    }
    bytes.push(delta & 127);
  }
  return bytes;
}

export function readDeltaVarints(bytes, from, to, count, label = 'a posting list') {
  const list = new Int32Array(count);
  let at = 0;
  let value = 0;
  let shift = 0;
  for (let k = from; k < to; k++) {
    const byte = bytes[k];
    value += (byte & 127) << shift;
    if (byte & 128) {
      shift += 7;
      continue;
    }
    list[at++] = value;
    shift = 0;
  }
  if (at !== count) {
    // Counts that disagree with the postings would make the beam search prune
    // against the wrong numbers, so stop rather than answer.
    throw new Error(`snapshot is corrupt: ${label} declares ${count} games and holds ${at}`);
  }
  return list;
}

/* --------------------------------- the parts -------------------------------- */

/** Read the container: magic, format, header, and the body the chunks live in. */
export function readContainer(raw) {
  if (raw.length < 10) throw new Error('that is not a catalog snapshot: too short');
  const magic = String.fromCharCode(raw[0], raw[1], raw[2], raw[3]);
  if (magic !== SNAPSHOT_MAGIC) throw new Error('that is not a catalog snapshot');
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const format = view.getUint16(4, true);
  if (format !== SNAPSHOT_FORMAT && format !== SNAPSHOT_FORMAT_1) {
    throw new Error(
      `catalog snapshot format ${format}, this build understands ${SNAPSHOT_FORMAT_1} and ${SNAPSHOT_FORMAT}`,
    );
  }
  const headerLength = view.getUint32(6, true);
  if (10 + headerLength > raw.length) throw new Error('catalog snapshot header runs past the file');
  const header = JSON.parse(new TextDecoder('utf-8').decode(raw.subarray(10, 10 + headerLength)));
  if (!Array.isArray(header.layout) || !header.counts) throw new Error('catalog snapshot header is unreadable');

  // Chunk offsets are measured from the start of the body, and the body has to
  // start on a 4-byte boundary for the typed-array views to be legal. A format 1
  // file inherited that rule from whenever its header happened to end on a
  // boundary — the container records `body_offset` from format 2 onward precisely
  // so this cannot be luck again.
  const bodyOffset = header.body_offset || 10 + headerLength;
  let body = raw.subarray(bodyOffset);
  if (bodyOffset % 4 !== 0) {
    body = new Uint8Array(body); // one aligned copy, for a legacy header only
  }
  return { format, header, body, bodyOffset };
}

/** One chunk's bytes, or null when the format does not carry it. */
export function chunkBytes(header, body, name, { required = true } = {}) {
  const entry = header.layout.find((c) => c.name === name);
  if (!entry) {
    if (required) throw new Error(`catalog snapshot has no ${name} chunk`);
    return null;
  }
  if (entry.offset + entry.length > body.length) {
    throw new Error(`catalog snapshot is corrupt: chunk ${name} runs past the file`);
  }
  return body.subarray(entry.offset, entry.offset + entry.length);
}

/** Typed-array views over a chunk, no copy. */
export const typedView = (bytes, Ctor, length) => new Ctor(bytes.buffer, bytes.byteOffset, length);

/* ------------------------------- reading a file ------------------------------ */

/**
 * Inflate a snapshot and read it into a plain `catalog` object — the same shape
 * `packSnapshot` writes, and deliberately *not* the shared `store`: `store` is a
 * singleton the counting reads, a catalog is a value something can edit and write
 * back. `public/js/browser-index.js` fills `store` from this; the updater edits
 * this. Either way there is one parser.
 *
 * Derived views (per-game tag lists, app-id lookup, per-tag counts) are rebuilt
 * here rather than shipped, which is what keeps 3.13M links out of the file twice.
 */
export async function readSnapshotCatalog(bytesOrUrl) {
  let bytes = bytesOrUrl;
  if (typeof bytesOrUrl === 'string' || bytesOrUrl instanceof URL) {
    const res = await fetch(bytesOrUrl);
    if (!res.ok) throw new Error(`catalog snapshot failed to load (${res.status})`);
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  const raw = await inflateIfNeeded(bytes);
  const { format, header, body } = readContainer(raw);
  const { games: nGames, tags: nTags, links } = header.counts;
  if (nTags >= PAIR_BASE) {
    throw new Error(`catalog snapshot holds ${nTags} tags, at the pair-key base (${PAIR_BASE})`);
  }

  const tagNames = new TextDecoder('utf-8').decode(chunkBytes(header, body, 'tagNames')).split('\n');
  if (tagNames.length !== nTags) {
    throw new Error(`snapshot is corrupt: ${nTags} tags declared, ${tagNames.length} names in the blob`);
  }
  const tagIds = typedView(chunkBytes(header, body, 'tagIds'), Int32Array, nTags);
  const tagCount = typedView(chunkBytes(header, body, 'tagCount'), Uint32Array, nTags);

  const postOff = typedView(chunkBytes(header, body, 'postOff'), Uint32Array, nTags + 1);
  const postBytes = chunkBytes(header, body, 'postings');
  if (postOff[0] !== 0 || postOff[nTags] !== postBytes.length) {
    throw new Error(
      `snapshot is corrupt: posting offsets span 0…${postOff[nTags]} over ${postBytes.length} bytes`,
    );
  }
  const postings = [];
  for (let i = 0; i < nTags; i++) {
    postings.push(readDeltaVarints(postBytes, postOff[i], postOff[i + 1], tagCount[i], `tag ${tagIds[i]}`));
  }

  const appId = typedView(chunkBytes(header, body, 'appId'), Int32Array, nGames);
  const nameBlob = chunkBytes(header, body, 'nameBlob');
  const nameOff = typedView(chunkBytes(header, body, 'nameOff'), Uint32Array, nGames + 1);
  const nameText = new TextDecoder('utf-8');
  const name = new Array(nGames);
  // Trimmed here, once, rather than in every view: a few hundred store titles
  // carry a stray space, and `combos.js`'s `az` comparator sorts on these strings.
  for (let r = 0; r < nGames; r++) name[r] = nameText.decode(nameBlob.subarray(nameOff[r], nameOff[r + 1])).trim();

  const flags = typedView(chunkBytes(header, body, 'flags'), Uint8Array, nGames);
  const year = typedView(chunkBytes(header, body, 'year'), Uint16Array, nGames);
  const reviews = typedView(chunkBytes(header, body, 'reviews'), Int32Array, nGames);
  const percent = typedView(chunkBytes(header, body, 'percent'), Int8Array, nGames);
  const label = typedView(chunkBytes(header, body, 'label'), Uint8Array, nGames);

  // `seen` is format 2. A format 1 file gets zeros, and the update rules read that
  // as "this row has never been re-read since the file started keeping track".
  const seenBytes = chunkBytes(header, body, 'seen', { required: false });
  const seen = seenBytes
    ? typedView(seenBytes, Uint32Array, nGames)
    : new Uint32Array(nGames);

  const pairBytes = chunkBytes(header, body, 'pairs');
  const pairView = new DataView(pairBytes.buffer, pairBytes.byteOffset, pairBytes.byteLength);
  const nPairs = header.counts.pairs ?? pairBytes.length / 8;
  const pairs = [];
  for (let n = 0; n < nPairs; n++) {
    const at = n * 8;
    pairs.push([pairView.getUint16(at, true), pairView.getUint16(at + 2, true), pairView.getUint32(at + 4, true)]);
  }

  const catalog = {
    format,
    // Views over the inflated buffer, not copies: the page builds its index
    // straight off these, and 196k rows copied into JS arrays is 15 MB and a
    // slower first paint for no reason. Anything that needs to *grow* a column —
    // an update adding games — builds a new typed array and hands it back here.
    tagIds,
    tagNames,
    tagCount,
    postings,
    appId,
    name,
    flags,
    year,
    reviews,
    percent,
    label,
    seen,
    pairs,
    generatedAt: header.generated_at || null,
    lastSync: header.last_sync || null,
    counts: header.counts,
  };
  buildPairViews(catalog);
  refreshDerived(catalog);
  return catalog;
}

/**
 * The beam walk reads `pairKeys`/`pairCounts` in count order and a tie keeps the
 * order the source had, which is why the sort here is by count alone and stable:
 * a file written in that order comes out of this untouched, and a catalog whose
 * pairs were just recounted comes out in the order the search expects.
 */
export function buildPairViews(catalog) {
  const sorted = [...catalog.pairs];
  sorted.sort((a, b) => a[2] - b[2]);
  const pairKeys = new Int32Array(sorted.length);
  const pairCounts = new Int32Array(sorted.length);
  const pairOf = new Map();
  for (let n = 0; n < sorted.length; n++) {
    const [a, b, count] = sorted[n];
    const key = pairKey(a, b);
    pairKeys[n] = key;
    pairCounts[n] = count;
    pairOf.set(key, count);
  }
  catalog.pairKeys = pairKeys;
  catalog.pairCounts = pairCounts;
  catalog.pairOf = pairOf;
  return catalog;
}

/**
 * Rebuild everything that is a function of the posting lists. Walking the postings
 * in tag order is what makes each game's tag list ascending, which is the order
 * `gamesWithAll` and the pair scan assume, and the same order the postings are
 * written back out in.
 */
export function refreshDerived(catalog) {
  const nGames = catalog.appId.length;
  const rowOfApp = new Map();
  for (let r = 0; r < nGames; r++) rowOfApp.set(catalog.appId[r], r);
  const tagIndexOf = new Map();
  catalog.tagIds.forEach((id, i) => tagIndexOf.set(id, i));

  const counts = new Int32Array(nGames);
  for (const list of catalog.postings) {
    for (const id of list) {
      const r = rowOfApp.get(id);
      if (r === undefined) throw new Error(`snapshot is corrupt: posting for app ${id} has no game row`);
      counts[r]++;
    }
  }
  const appTagStart = new Uint32Array(nGames + 1);
  for (let r = 0; r < nGames; r++) appTagStart[r + 1] = appTagStart[r] + counts[r];
  const flat = new Uint16Array(appTagStart[nGames]);
  const fillAt = appTagStart.slice(0, nGames);
  for (let i = 0; i < catalog.postings.length; i++) {
    for (const id of catalog.postings[i]) flat[fillAt[rowOfApp.get(id)]++] = i;
  }
  if (nGames && fillAt[nGames - 1] !== flat.length) {
    throw new Error(`snapshot is corrupt: ${flat.length} links placed of ${appTagStart[nGames]} expected`);
  }

  catalog.rowOfApp = rowOfApp;
  catalog.tagIndexOf = tagIndexOf;
  catalog.appTagStart = appTagStart;
  catalog.appTagFlat = flat;
  catalog.tagCountOfApp = counts;
  catalog.nLinks = appTagStart[nGames];
  catalog.tagIds.forEach((_, i) => {
    catalog.tagCount[i] = catalog.postings[i].length;
  });
  return catalog;
}

/* -------------------------------- writing one -------------------------------- */

const int32 = (values) => {
  const buf = new Uint8Array(values.length * 4);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < values.length; i++) view.setInt32(i * 4, values[i] | 0, true);
  return buf;
};
const uint32 = (values) => {
  const buf = new Uint8Array(values.length * 4);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < values.length; i++) view.setUint32(i * 4, values[i] >>> 0, true);
  return buf;
};
const uint16 = (values) => {
  const buf = new Uint8Array(values.length * 2);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < values.length; i++) view.setUint16(i * 2, values[i] & 0xffff, true);
  return buf;
};
const uint8 = (values) => Uint8Array.from(values, (v) => v & 0xff);
const int8 = (values) => Uint8Array.from(values, (v) => (v | 0) & 0xff);

const concatBytes = (parts, total) => {
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/**
 * Pack a catalog into the container. Always format 2, so a format 1 file promoted
 * by an update keeps the new column forever.
 *
 * Pairs are sorted by count here with the stable sort the loader expects, because
 * the beam walk reads `pairKeys`/`pairCounts` in that order and a tie's order comes
 * from the file's own order.
 */
export function packSnapshot(catalog, { generated_at, last_sync, format = SNAPSHOT_FORMAT } = {}) {
  const nTags = catalog.tagIds.length;
  const nGames = catalog.appId.length;
  if (nTags >= PAIR_BASE) {
    // The snapshot mirrors pairKey's base, so say so rather than ship silently
    // colliding pair keys.
    throw new Error(
      `refusing to write the snapshot: ${nTags} indexed tags reaches the pair-key base (${PAIR_BASE}). ` +
        'Raise PAIR_BASE in public/engine/store.js first.',
    );
  }

  const enc = new TextEncoder();
  const chunks = [];
  const push = (name, bytes) => chunks.push([name, bytes]);

  push('tagNames', enc.encode(catalog.tagNames.join('\n')));
  push('tagIds', int32(catalog.tagIds));
  push('tagCount', uint32(catalog.tagCount));

  const postBytes = [];
  const postOff = [0];
  for (const list of catalog.postings) {
    // Pushed one byte at a time on purpose: `push(...encoded)` over a 4.9 MB
    // posting list blows the argument limit.
    for (const byte of writeDeltaVarints(list)) postBytes.push(byte);
    postOff.push(postBytes.length);
  }
  push('postings', Uint8Array.from(postBytes));
  push('postOff', uint32(postOff));

  push('appId', int32(catalog.appId));

  // Game names: one blob plus offsets, which is what keeps 196k short strings from
  // costing a JSON quote and comma each.
  const nameChunks = [];
  const nameOff = [0];
  let nameTotal = 0;
  for (let r = 0; r < nGames; r++) {
    const encoded = enc.encode(String(catalog.name[r] ?? ''));
    nameChunks.push(encoded);
    nameTotal += encoded.length;
    nameOff.push(nameTotal);
  }
  push('nameBlob', concatBytes(nameChunks, nameTotal));
  push('nameOff', uint32(nameOff));

  push('flags', uint8(catalog.flags));
  push('year', uint16(catalog.year));
  push('reviews', int32(catalog.reviews));
  push('percent', int8(catalog.percent));
  push('label', uint8(catalog.label));

  const pairs = [...catalog.pairs];
  pairs.sort((a, b) => a[2] - b[2]);
  const pairBytes = new Uint8Array(pairs.length * 8);
  {
    const view = new DataView(pairBytes.buffer);
    let at = 0;
    for (const [a, b, count] of pairs) {
      if (a >= PAIR_BASE || b >= PAIR_BASE) {
        throw new Error(`refusing to write the snapshot: pair (${a}, ${b}) is past the pair-key base`);
      }
      view.setUint16(at, a, true);
      view.setUint16(at + 2, b, true);
      view.setUint32(at + 4, count, true);
      at += 8;
    }
  }
  push('pairs', pairBytes);

  if (format >= SNAPSHOT_FORMAT) push('seen', uint32(catalog.seen));

  // Pad each chunk to a 4-byte boundary so every integer array starts aligned.
  let cursor = 0;
  const layout = [];
  const bodies = [];
  for (const [name, buf] of chunks) {
    layout.push({ name, offset: cursor, length: buf.length });
    bodies.push(buf);
    cursor += buf.length;
    const pad = (4 - (cursor % 4)) % 4;
    if (pad) {
      bodies.push(new Uint8Array(pad));
      cursor += pad;
    }
  }

  const header = {
    format,
    generated_at: generated_at || new Date().toISOString(),
    last_sync: last_sync ?? catalog.lastSync ?? null,
    counts: {
      games: nGames,
      tags: nTags,
      links: catalog.postings.reduce((sum, list) => sum + list.length, 0),
      pairs: pairs.length,
    },
    layout,
  };

  // The body starts on a 4-byte boundary, and the header says where. Lengths
  // depend on each other here — the padding depends on the header's length, which
  // depends on the padding — so it settles rather than being computed once.
  let headerBuf = enc.encode(JSON.stringify(header));
  let bodyOffset = 10 + headerBuf.length;
  for (let attempt = 0; attempt < 5; attempt++) {
    header.body_offset = bodyOffset;
    headerBuf = enc.encode(JSON.stringify(header));
    const pad = (4 - ((10 + headerBuf.length) % 4)) % 4;
    const next = 10 + headerBuf.length + pad;
    if (next === bodyOffset) break;
    bodyOffset = next;
  }
  const headerPad = bodyOffset - 10 - headerBuf.length;

  const magic = new Uint8Array(10);
  magic.set(enc.encode(SNAPSHOT_MAGIC), 0);
  new DataView(magic.buffer).setUint16(4, format, true);
  new DataView(magic.buffer).setUint32(6, headerBuf.length, true);

  const out = new Uint8Array(bodyOffset + cursor);
  out.set(magic, 0);
  out.set(headerBuf, 10);
  // `headerPad` zero bytes are already zero, and they are what keeps every integer
  // chunk aligned for a typed-array view.
  let at = bodyOffset;
  for (const buf of bodies) {
    out.set(buf, at);
    at += buf.length;
  }
  return { bytes: out, header };
}

/* --------------------------- pair counts and invariant ----------------------- */

/**
 * Pair counts, counted from scratch off the per-game tag lists. A finished catalog
 * implies 26M pair-links across 81k distinct pairs, which is a couple of seconds —
 * affordable enough that an update *recounts* everything instead of maintaining
 * deltas, and the invariant then holds by construction rather than by bookkeeping.
 */
export function recountPairs(catalog, { onProgress } = {}) {
  const counts = new Map();
  const { appTagStart, appTagFlat, tagCountOfApp } = catalog;
  for (let r = 0; r < catalog.appId.length; r++) {
    const n = tagCountOfApp[r];
    const start = appTagStart[r];
    for (let a = 0; a < n; a++) {
      const ia = appTagFlat[start + a];
      for (let b = a + 1; b < n; b++) {
        const key = pairKey(ia, appTagFlat[start + b]);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    if (onProgress && r % 25000 === 0) onProgress(r);
  }
  catalog.pairs = [...counts.entries()].map(([key, count]) => {
    const a = Math.floor(key / PAIR_BASE);
    const b = key % PAIR_BASE;
    return a < b ? [a, b, count] : [b, a, count];
  });
  return catalog.pairs;
}

/** Σ n(n−1)/2 over the games — the right-hand side of the invariant. */
export function pairInvariantImplied(tagCountOfApp) {
  let implied = 0;
  for (const n of tagCountOfApp) implied += (n * (n - 1)) / 2;
  return implied;
}

/** The pair-links the stored pair counts add up to. */
export function pairInvariantCounted(pairs) {
  let counted = 0;
  for (const [, , count] of pairs) counted += count;
  return counted;
}

/* -------------------------------- the tag book ------------------------------- */

/**
 * Steam's tag dictionary, kept in the catalog file itself.
 *
 * A tag Steam names but the catalog has never seen gets a provisional *negative*
 * id — Steam's own ids are positive, so nothing can collide — and the search layer
 * hides those by name (`isPlaceholderName`) until a game carries it and the next
 * update gives it a real id from the dictionary.
 */
export function tagBook(catalog) {
  const byKey = new Map();
  const byExactName = new Map();
  const byId = new Map();
  for (let i = 0; i < catalog.tagIds.length; i++) {
    const entry = { tag_id: catalog.tagIds[i], name: catalog.tagNames[i], name_source: 'catalog' };
    byId.set(entry.tag_id, entry);
    const key = normalizeKey(entry.name);
    if (!byKey.has(key)) byKey.set(key, entry.tag_id);
    if (!byExactName.has(entry.name)) byExactName.set(entry.name, entry.tag_id);
  }

  let synthetic = -1;
  const book = {
    byKey,
    byExactName,
    byId,
    added: new Map(), // name -> provisional id, for the log line

    /** Fold in Steam's own dictionary without overwriting anything we already call
     *  by that name — the catalog's names are what the interface shows. */
    mergeSteamDictionary(mapping) {
      for (const [key, entry] of mapping) {
        if (!byKey.has(key)) byKey.set(key, entry.id);
        if (!byId.has(entry.id)) byId.set(entry.id, { tag_id: entry.id, name: entry.name, name_source: 'mapping' });
      }
    },

    /** Steam's tag id for a storefront tag name, assigning a provisional one when
     *  the name is genuinely new. */
    resolve(name) {
      const text = String(name).trim();
      if (!text) return null;
      const key = normalizeKey(text);
      if (byExactName.has(text)) return byExactName.get(text);
      if (byKey.has(key)) return byKey.get(key);
      const id = synthetic--;
      byKey.set(key, id);
      byExactName.set(text, id);
      byId.set(id, { tag_id: id, name: text, name_source: 'unresolved' });
      book.added.set(text, id);
      return id;
    },

    idsForNames(names) {
      const ids = new Set();
      for (const name of names) {
        const id = book.resolve(name);
        if (id !== null) ids.add(id);
      }
      return [...ids].sort((a, b) => a - b);
    },
  };
  return book;
}
