# Steam Tags Explorer

Discover unexplored game design spaces by analyzing tag co-occurrence patterns across 167K+ Steam games.

```
┌─────────────────────────────────────────────────────────┐
│  Steam Tags Explorer                                     │
│  ┌──────────────┐  ┌──────────────────────────────────┐ │
│  │  Fetcher     │  │  Web UI                          │ │
│  │              │  │                                  │ │
│  │ • Incremental│  │ • Select tags                    │ │
│  │ • Rate-safe  │  │ • Find rare combinations         │ │
│  │ • Resumable  │  │ • Explore 0-game opportunities   │ │
│  └──────┬───────┘  └──────────────┬───────────────────┘ │
│         │                          │                     │
│         ▼                          ▼                     │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  data/steam_tags.json                                │ │
│  │  {app_id: [{tagid, name, weight}, ...], ...}        │ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Install dependencies
python3 -m venv venv
venv/bin/pip install -r requirements.txt

# Launch the web UI
venv/bin/python web/app.py
# → http://localhost:5000
```

## Project Structure

```
steam_tags/
├── README.md
├── requirements.txt
├── data/
│   └── steam_tags.json          # Game tag database (~200MB)
├── fetcher/
│   └── fetch_tags.py            # Incremental tag fetcher
└── web/
    ├── app.py                   # Flask web application
    └── templates/
        └── index.html           # Interactive UI
```

## Web UI

The web application lets you explore tag combinations interactively:

- **Select tags** — Search and pick tags from the full Steam tag database
- **Find combinations** — Choose combination size (2–5 tags), rarity filters, and sort order
- **Explore results** — Click any combination to see the games that implement it
- **Unexplored spaces** — Toggle "Include unexplored (0 games)" to find combinations with no existing games but high expected demand

### API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/tags?min=N` | All tags with frequency ≥ N |
| `GET /api/combinations?n=2&tags=A,B,C&max_count=200&include_unexplored=1` | Rare/unexplored tag combinations |
| `GET /api/games?tags=A,B` | Games with all specified tags |
| `GET /api/stats` | Overall statistics |
| `GET /api/search?q=query` | Search tags by name |

## Fetcher

Incrementally fetches tags for all Steam games. Designed to run safely over multiple days without getting banned.

```bash
# Run the fetcher (resumes from existing data automatically)
python3 fetcher/fetch_tags.py
```

### Features

- **Incremental** — Loads existing `steam_tags.json` and only fetches missing games
- **Resumable** — Saves progress to `.progress.json`; safe to interrupt and restart
- **Rate-safe** — Conservative throttling with exponential backoff on 429s
- **Logged** — All progress logged to `fetch.log`

### Configuration

Edit these constants in `fetcher/fetch_tags.py`:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `BATCH_SIZE` | 50 | App IDs per request |
| `REQUEST_DELAY` | 2.0 | Seconds between requests |
| `BATCH_DELAY` | 5.0 | Seconds between batches |
| `MAX_RETRIES` | 3 | Max retries per batch |
| `RETRY_DELAY` | 30.0 | Seconds to wait on rate limit |

### Data Sources

- **[SteamAppIDList](https://github.com/jsnli/SteamAppIDList)** — List of all game app IDs (updated daily)
- **[IStoreBrowseService/GetItems/v1](https://api.steampowered.com/IStoreBrowseService/GetItems/v1)** — Steam's internal endpoint for fetching game metadata including tags with weights
- **[Stelicas](https://github.com/0wn3dg0d/Stelicas)** — Tag ID to name mapping

## Data Format

```json
{
  "730": [
    {"tagid": 1663, "name": "FPS", "weight": 1160},
    {"tagid": 1774, "name": "Shooter", "weight": 834}
  ],
  "570": [
    {"tagid": 113, "name": "Free to Play", "weight": 3014}
  ]
}
```

## Notes

- Game names are not included in the dataset (only App IDs + tags)
- Some tag IDs may not have names in the mapping (shown as `Tag_<id>`)
- Not all app IDs return tags (some are DLC, tools, or non-game content)
- The tag mapping file is not exhaustive and may miss newer tags

## Research Sources

- [FronkonGames/Steam-Games-Scraper](https://github.com/FronkonGames/Steam-Games-Scraper) — Rate limiting research
- [Steam Web API](https://developer.valvesoftware.com/wiki/Steam_Web_API) — Official documentation

## License

MIT
