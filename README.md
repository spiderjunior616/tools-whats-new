# Tools What's New

Millennium plugin that adds public Steam news from local Tools games to the Steam Library home "What's New" carousel.

It reads AppIDs from local script manifest files, prioritizes recently played or recently added games for the news feed, fetches public Steam news via `ISteamNews/GetNewsForApp`, resolves the native Steam partner event IDs, and merges those events into Steam's own Library home feed loader.

For the native Library home Play Next shelf, it uses the `balanced-play-next-v2` strategy: never-played and long-neglected Tools games are favored, titles played in the last two weeks are penalized, recently added Tools games get a small boost, and recommendations are diversified so one series is less likely to occupy the whole row.

The backend only fetches Steam-owned news/image URLs, and the frontend only opens Steam-owned URLs. Local file paths and playtime timestamps are used internally for ranking but are not returned to the frontend.
