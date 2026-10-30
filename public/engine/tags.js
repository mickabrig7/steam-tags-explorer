/**
 * Tag-name normalisation shared by the crawler and the tag dictionary.
 * Steam writes "Design & Illustration"; the catalog stores "Design Illustration".
 */
export function normalizeKey(name) {
  return String(name || '')
    .replace(/[&/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** "Tag_1637" rows come from a crawl that never resolved a name. */
export function isPlaceholderName(name) {
  return /^Tag_\d+$/.test(String(name || ''));
}
