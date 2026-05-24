"""
Steam Tags Explorer — Web UI for finding rare tag combinations.
"""

import json
import math
import time
from collections import Counter
from itertools import combinations
from pathlib import Path

from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

DATA_FILE = Path(__file__).parent.parent / "data" / "steam_tags.json"

# Global data (loaded once)
data = {}
tag_freq = {}
tag_to_games = {}  # tag_name -> set of app_ids
total_games = 0
pair_cache = {}  # (tag1, tag2) -> intersection size


def load_data():
    global data, tag_freq, tag_to_games, total_games, pair_cache
    with open(DATA_FILE) as f:
        data = json.load(f)
    total_games = len(data)

    # Compute tag frequencies and reverse index (as sets for fast intersection)
    tag_freq = Counter()
    tag_to_games = {}
    for app_id, tags in data.items():
        for t in tags:
            name = t["name"]
            tag_freq[name] += 1
            if name not in tag_to_games:
                tag_to_games[name] = set()
            tag_to_games[name].add(app_id)

    # Pre-compute pairwise intersection sizes for all tag pairs
    # This is O(T^2 * avg_set_size) but only done once at startup
    print("Pre-computing pairwise intersections...")
    start = time.time()
    tag_names = list(tag_freq.keys())
    for i, t1 in enumerate(tag_names):
        s1 = tag_to_games[t1]
        for t2 in tag_names[i + 1:]:
            s2 = tag_to_games[t2]
            pair_cache[(t1, t2)] = len(s1 & s2)
    elapsed = time.time() - start
    print(f"  Computed {len(pair_cache)} pairwise intersections in {elapsed:.1f}s")


def find_games_with_tags(tag_names):
    """Find games that have ALL of the given tags."""
    if not tag_names:
        return []
    # Start with the smallest tag set for efficiency
    tag_sets = []
    for tag in tag_names:
        if tag in tag_to_games:
            tag_sets.append(tag_to_games[tag])  # already a set
        else:
            return []  # tag doesn't exist
    if not tag_sets:
        return []
    # Intersect all sets (smallest first)
    tag_sets.sort(key=len)
    result = tag_sets[0]
    for s in tag_sets[1:]:
        result = result & s
        if not result:
            return []
    return sorted(result, key=lambda x: int(x) if x.isdigit() else 0)


def _get_pair_count(t1, t2):
    """Get the intersection size for a pair of tags from cache."""
    if t1 == t2:
        return tag_freq.get(t1, 0)
    key = (t1, t2) if (t1, t2) in pair_cache else (t2, t1)
    return pair_cache.get(key, 0)


def _make_result(combo, count):
    """Build a result dict for a combination."""
    n = len(combo)
    freqs = [tag_freq[t] for t in combo]
    expected = math.prod(freqs) / (total_games ** (n - 1))
    lift = count / expected if expected > 0 else 0
    pmi = None if count == 0 else math.log2(count / total_games) - math.log2(expected / total_games)
    return {
        "tags": list(combo),
        "count": count,
        "expected": round(expected, 2),
        "lift": round(lift, 4),
        "pmi": pmi,
        "freqs": freqs,
        "unexplored": count == 0,
    }


def compute_rare_combinations(tag_names, n, min_count=0, max_count=200):
    """
    Find all combinations of n tags from the given tag_names,
    ranked by rarity (fewest co-occurrences first).
    Uses pairwise cache for fast lookups and smart pruning.
    Supports min_count=0 for unexplored combinations.
    """
    if len(tag_names) < n:
        return []

    results = []
    start = time.time()

    if n == 2:
        # Direct pairwise lookup from cache — O(T^2)
        for i, t1 in enumerate(tag_names):
            for t2 in tag_names[i + 1:]:
                count = _get_pair_count(t1, t2)
                if count < min_count or count > max_count:
                    continue
                results.append(_make_result((t1, t2), count))

    elif n == 3:
        # For n=3, iterate over all pairs first, compute pair intersection once,
        # then intersect with each third tag. Reuses the pair intersection set.
        can_prune = min_count > 0

        for i, t1 in enumerate(tag_names):
            for j in range(i + 1, len(tag_names)):
                t2 = tag_names[j]
                pair_count = _get_pair_count(t1, t2)
                if can_prune and pair_count < min_count:
                    continue
                if pair_count > max_count:
                    continue
                # Compute pair intersection once
                pair_set = tag_to_games[t1] & tag_to_games[t2]
                for k in range(j + 1, len(tag_names)):
                    t3 = tag_names[k]
                    if can_prune:
                        if _get_pair_count(t1, t3) < min_count or _get_pair_count(t2, t3) < min_count:
                            continue
                    # Intersect pair_set with third tag
                    count = len(pair_set & tag_to_games[t3])
                    if count < min_count or count > max_count:
                        continue
                    results.append(_make_result((t1, t2, t3), count))

    else:
        # For n >= 4, brute force with pairwise pruning
        can_prune = min_count > 0
        for combo in combinations(tag_names, n):
            if can_prune:
                skip = False
                for i in range(n):
                    for j in range(i + 1, n):
                        if _get_pair_count(combo[i], combo[j]) == 0:
                            skip = True
                            break
                    if skip:
                        break
                if skip:
                    continue
            games = find_games_with_tags(combo)
            count = len(games)
            if count < min_count or count > max_count:
                continue
            results.append(_make_result(combo, count))

    elapsed = time.time() - start
    print(f"  Computed {len(results)} combinations in {elapsed:.1f}s")

    # Sort: unexplored first (by expected desc), then rare (by count asc)
    results.sort(key=lambda r: (0 if r["count"] == 0 else 1, -r["expected"], r["count"]))
    return results


def get_all_tags_sorted():
    """Return all tags sorted by frequency (descending)."""
    return [{"name": name, "count": count} for name, count in tag_freq.most_common()]


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/tags")
def api_tags():
    """Get all tags with frequencies."""
    min_count = int(request.args.get("min", 0))
    tags = get_all_tags_sorted()
    if min_count > 0:
        tags = [t for t in tags if t["count"] >= min_count]
    return jsonify(tags)


@app.route("/api/combinations")
def api_combinations():
    """
    Find rare combinations of N tags.
    Query params:
      - n: number of tags in combination (2, 3, 4, ...)
      - tags: comma-separated list of tag names to search within (optional)
      - max_count: maximum co-occurrence count (default 200)
      - min_count: minimum co-occurrence count (default 1, use 0 for unexplored)
      - include_unexplored: set to "1" to include 0-count combinations
      - limit: max results to return (default 200)
    """
    n = int(request.args.get("n", 2))
    max_count = int(request.args.get("max_count", 200))
    min_count = int(request.args.get("min_count", 1))
    include_unexplored = request.args.get("include_unexplored", "0") == "1"
    limit = int(request.args.get("limit", 200))

    if include_unexplored:
        min_count = 0

    # Get the pool of tags to search within
    tag_filter = request.args.get("tags", "")
    if not tag_filter:
        return jsonify({"error": "Select at least N tags before searching"}), 400
    tag_pool = [t.strip() for t in tag_filter.split(",")]

    # Hard limit based on n to prevent timeout
    from math import comb
    max_tags_by_n = {2: 432, 3: 200, 4: 50, 5: 25}
    max_tags = max_tags_by_n.get(n, 25)
    if len(tag_pool) > max_tags:
        total = comb(len(tag_pool), n)
        return jsonify({"error": f"Too many tags ({len(tag_pool)}). "
                                   f"C({len(tag_pool)},{n}) = {total:,} combinations. "
                                   f"Select ≤{max_tags} tags for n={n}."}), 400

    results = compute_rare_combinations(tag_pool, n, min_count, max_count)
    return jsonify(results[:limit])


@app.route("/api/games")
def api_games():
    """
    Get games that have ALL of the given tags.
    Query params:
      - tags: comma-separated list of tag names
      - limit: max games to return (default 100)
    """
    tag_filter = request.args.get("tags", "")
    if not tag_filter:
        return jsonify({"error": "No tags specified"}), 400

    limit = int(request.args.get("limit", 100))

    tag_names = [t.strip() for t in tag_filter.split(",")]
    games = find_games_with_tags(tag_names)

    # Limit results to avoid huge responses
    total_count = len(games)
    games = games[:limit]

    # Get tag details for each game
    results = []
    for app_id in games:
        tags = data.get(app_id, [])
        tag_names_list = [t["name"] for t in tags]
        results.append({
            "app_id": app_id,
            "tags": tag_names_list,
            "url": f"https://store.steampowered.com/app/{app_id}/",
        })

    return jsonify({
        "count": total_count,
        "games": results,
    })


@app.route("/api/stats")
def api_stats():
    """Get overall statistics."""
    return jsonify({
        "total_games": total_games,
        "total_tags": len(tag_freq),
    })


@app.route("/api/search")
def api_search():
    """Search for tags by name."""
    q = request.args.get("q", "").lower()
    if not q:
        return jsonify([])
    results = []
    for name, count in tag_freq.items():
        if q in name.lower():
            results.append({"name": name, "count": count})
    results.sort(key=lambda x: x["count"], reverse=True)
    return jsonify(results[:50])


@app.route("/api/random_combination")
def api_random_combination():
    """Get a random rare/unexplored combination for the random mode."""
    import random

    # Pick a random combination size (2-3 for speed)
    n = random.randint(2, 3)

    # Use a small random subset of tags to keep it fast
    # C(10,3) = 120 combos, C(15,3) = 455 - very fast
    all_tags = list(tag_freq.keys())
    pool_size = min(random.randint(8, 15), len(all_tags))
    tag_pool = random.sample(all_tags, pool_size)

    # Find rare combinations with a tight timeout
    start = time.time()
    results = compute_rare_combinations(tag_pool, n, 0, 500)
    elapsed = time.time() - start
    print(f"  Random combo: {len(results)} results in {elapsed:.1f}s")

    if not results:
        return jsonify({"error": "No rare combinations found"}), 404

    # Pick a random result
    return jsonify(random.choice(results))


if __name__ == "__main__":
    print("Loading Steam tags data...")
    load_data()
    print(f"Loaded {total_games} games with {len(tag_freq)} unique tags")
    print("Starting server on http://localhost:5000")
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
