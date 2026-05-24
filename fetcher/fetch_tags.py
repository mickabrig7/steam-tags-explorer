#!/usr/bin/env python3
"""
Incremental Steam Tags Fetcher

Fetches tags for all Steam games, updating existing data and filling in missing games.
Designed to run safely over multiple days without getting banned.

Features:
- Loads existing data from steam_tags.json
- Only fetches tags for missing games
- Conservative rate limiting (configurable)
- Saves progress incrementally (can be resumed)
- Logs progress to a file
"""

import json
import time
import urllib.request
import urllib.error
import logging
from pathlib import Path
from datetime import datetime

# Configuration
GAMES_APPID_URL = "https://raw.githubusercontent.com/jsnli/steamappidlist/master/data/games_appid.json"
TAGS_MAPPING_URL = "https://raw.githubusercontent.com/0wn3dg0d/Stelicas/main/data/tags.txt"
STORE_ENDPOINT = "https://api.steampowered.com/IStoreBrowseService/GetItems/v1"

# Throttling configuration (conservative to avoid bans)
BATCH_SIZE = 50           # App IDs per request (smaller to be safe)
REQUEST_DELAY = 2.0       # Seconds between requests (conservative)
BATCH_DELAY = 5.0         # Seconds between batches
MAX_RETRIES = 3           # Max retries per batch
RETRY_DELAY = 30.0        # Seconds to wait on rate limit (429)

# Output
PROJECT_DIR = Path(__file__).parent.parent
OUTPUT_DIR = PROJECT_DIR / "data"
OUTPUT_FILE = OUTPUT_DIR / "steam_tags.json"
PROGRESS_FILE = OUTPUT_DIR / ".progress.json"
LOG_FILE = OUTPUT_DIR / "fetch.log"

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)


def load_existing_data() -> dict[str, list]:
    """Load existing tag data from steam_tags.json."""
    if OUTPUT_FILE.exists():
        logger.info(f"Loading existing data from {OUTPUT_FILE}...")
        try:
            with open(OUTPUT_FILE, "r") as f:
                data = json.load(f)
            logger.info(f"Loaded {len(data)} games with existing tags")
            return data
        except Exception as e:
            logger.warning(f"Could not load existing data: {e}")
    return {}


def save_data(data: dict[str, list]):
    """Save tag data to steam_tags.json."""
    logger.info(f"Saving {len(data)} games to {OUTPUT_FILE}...")
    with open(OUTPUT_FILE, "w") as f:
        json.dump(data, f, indent=2)


def load_progress() -> dict:
    """Load progress from .progress.json."""
    if PROGRESS_FILE.exists():
        try:
            with open(PROGRESS_FILE, "r") as f:
                return json.load(f)
        except Exception as e:
            logger.warning(f"Could not load progress: {e}")
    return {"last_updated": None, "games_processed": 0, "total_games": 0}


def save_progress(progress: dict):
    """Save progress to .progress.json."""
    with open(PROGRESS_FILE, "w") as f:
        json.dump(progress, f, indent=2)


def load_tag_mapping() -> dict[int, str]:
    """Load tag ID to name mapping from tags.txt."""
    try:
        logger.info(f"Downloading tag mapping from {TAGS_MAPPING_URL}...")
        req = urllib.request.Request(TAGS_MAPPING_URL, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=60) as response:
            text = response.read().decode("utf-8")
        
        mapping = {}
        for line in text.strip().split("\n"):
            parts = line.split("\t", 1)
            if len(parts) == 2:
                tag_id = int(parts[0])
                tag_name = parts[1]
                mapping[tag_id] = tag_name
        logger.info(f"Loaded {len(mapping)} tag mappings")
        return mapping
    except Exception as e:
        logger.warning(f"Could not load tag mapping: {e}")
        return {}


def load_games_appids() -> list[dict]:
    """Load all game app IDs from games_appid.json."""
    try:
        logger.info(f"Downloading games list from {GAMES_APPID_URL}...")
        req = urllib.request.Request(GAMES_APPID_URL, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=60) as response:
            data = json.loads(response.read().decode("utf-8"))
        logger.info(f"Loaded {len(data)} game app IDs")
        return data
    except Exception as e:
        logger.error(f"Error loading games_appid.json: {e}")
        return []


def fetch_tags_batch(appids: list[int]) -> dict:
    """Fetch tags for a batch of app IDs."""
    if not appids:
        return {}

    data = {
        "ids": [{"appid": appid} for appid in appids],
        "context": {
            "language": "english",
            "country_code": "us",
            "steam_realm": 1,
        },
        "data_request": {
            "include_assets": False,
            "include_release": False,
            "include_platforms": False,
            "include_all_purchase_options": False,
            "include_screenshots": False,
            "include_trailers": False,
            "include_ratings": False,
            "include_tag_count": True,
            "include_reviews": False,
            "include_basic_info": False,
            "include_supported_languages": False,
            "include_full_description": False,
            "include_included_items": False,
        },
    }

    input_json = json.dumps(data)
    url = f"{STORE_ENDPOINT}?input_json={urllib.request.quote(input_json)}"

    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})

    retries = 0
    while retries < MAX_RETRIES:
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                result = json.loads(response.read().decode("utf-8"))
                return result
        except urllib.error.HTTPError as e:
            if e.code == 429:
                retries += 1
                wait_time = RETRY_DELAY * (2 ** retries)
                logger.warning(f"Rate limited (429), waiting {wait_time}s...")
                time.sleep(wait_time)
                continue
            elif e.code == 403:
                logger.warning(f"Forbidden (403) for batch starting with {appids[0]}")
                return {}
            else:
                raise
        except Exception as e:
            logger.error(f"Error fetching batch: {e}")
            return {}
        retries += 1

    return {}


def process_batch(appids: list[int], tag_mapping: dict[int, str]) -> dict[str, list]:
    """Process a batch of app IDs and return the results."""
    result = {}
    raw = fetch_tags_batch(appids)

    if not raw:
        return result

    store_items = raw.get("response", {}).get("store_items", [])

    for item in store_items:
        appid = item.get("appid")
        if appid is None:
            continue

        tags = item.get("tags", [])
        if not tags:
            continue

        # Convert tag IDs to names
        tag_list = []
        for tag in tags:
            tagid = tag.get("tagid")
            weight = tag.get("weight")
            tag_name = tag_mapping.get(tagid, f"Tag_{tagid}")
            tag_list.append({
                "tagid": tagid,
                "name": tag_name,
                "weight": weight,
            })

        result[str(appid)] = tag_list

    return result


def main():
    """Main function to fetch all Steam game tags incrementally."""
    logger.info("=" * 60)
    logger.info("Steam Tags Incremental Fetcher")
    logger.info("=" * 60)

    # Load existing data
    logger.info("\n[1/5] Loading existing data...")
    existing_data = load_existing_data()

    # Load progress
    logger.info("\n[2/5] Loading progress...")
    progress = load_progress()

    # Load tag mapping
    logger.info("\n[3/5] Loading tag ID to name mapping...")
    tag_mapping = load_tag_mapping()

    # Load game app IDs
    logger.info("\n[4/5] Loading game app IDs...")
    games = load_games_appids()
    if not games:
        logger.error("No app IDs loaded. Exiting.")
        return

    # Find missing games
    missing_appids = []
    for game in games:
        appid = str(game["appid"])
        if appid not in existing_data:
            missing_appids.append(game["appid"])

    logger.info(f"\nTotal games: {len(games)}")
    logger.info(f"Games with existing tags: {len(existing_data)}")
    logger.info(f"Games missing tags: {len(missing_appids)}")

    if not missing_appids:
        logger.info("\nAll games already have tags! Nothing to do.")
        return

    # Process missing games in batches
    logger.info(f"\n[5/5] Fetching tags for {len(missing_appids)} missing games...")
    logger.info(f"Batch size: {BATCH_SIZE}, Request delay: {REQUEST_DELAY}s, Batch delay: {BATCH_DELAY}s")
    logger.info(f"Estimated time: {len(missing_appids) / BATCH_SIZE * (REQUEST_DELAY + BATCH_DELAY) / 3600:.1f} hours")

    all_results = dict(existing_data)  # Start with existing data
    total_batches = (len(missing_appids) + BATCH_SIZE - 1) // BATCH_SIZE
    completed = 0
    start_time = time.time()

    for i in range(0, len(missing_appids), BATCH_SIZE):
        batch = missing_appids[i : i + BATCH_SIZE]
        batch_num = i // BATCH_SIZE + 1

        logger.info(f"\nBatch {batch_num}/{total_batches} ({len(batch)} games)")

        # Process batch
        result = process_batch(batch, tag_mapping)
        all_results.update(result)

        completed += len(result)
        elapsed = time.time() - start_time
        rate = completed / elapsed if elapsed > 0 else 0

        # Update progress
        progress = {
            "last_updated": datetime.now().isoformat(),
            "games_processed": len(all_results),
            "total_games": len(games),
            "missing_games": len(missing_appids) - len(result),
            "completed_batches": batch_num,
            "total_batches": total_batches,
        }
        save_progress(progress)

        # Save data periodically
        if batch_num % 10 == 0 or batch_num == total_batches:
            save_data(all_results)
            logger.info(f"Saved progress: {len(all_results)} games with tags")

        logger.info(
            f"  Completed: {completed} games, "
            f"Rate: {rate:.1f} games/sec, "
            f"ETA: {(len(missing_appids) - completed) / rate / 3600 if rate > 0 else 0:.1f} hours"
        )

        # Delay between batches
        time.sleep(BATCH_DELAY)

    # Final save
    save_data(all_results)

    # Print summary
    total_games = len(all_results)
    total_tags = sum(len(tags) for tags in all_results.values())
    elapsed = time.time() - start_time

    logger.info("\n" + "=" * 60)
    logger.info("Summary:")
    logger.info(f"  Total games processed: {total_games}")
    logger.info(f"  Total tags collected: {total_tags}")
    logger.info(f"  Time elapsed: {elapsed / 3600:.1f} hours")
    logger.info(f"  Output file: {OUTPUT_FILE}")
    logger.info("=" * 60)


if __name__ == "__main__":
    main()
