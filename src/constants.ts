export const CWA_API_BASE_URL = "https://opendata.cwa.gov.tw/api/v1/rest/datastore";

/** Page for applying for / managing a CWA Open Data API key. */
export const CWA_AUTH_KEY_URL = "https://opendata.cwa.gov.tw/user/authkey";

export const F_C0032_001_DATASET_ID = "F-C0032-001";
export const E_A0015_001_DATASET_ID = "E-A0015-001";
/** Tide forecast (未來1個月潮汐預報) — generic-layer only, see registry/cwa.ts. */
export const F_A0021_001_DATASET_ID = "F-A0021-001";
/** Weather warnings (天氣特報) — generic-layer only, see registry/cwa.ts. */
export const W_C0033_001_DATASET_ID = "W-C0033-001";
/** Automated weather station observations (自動氣象站-氣象觀測資料) — generic-layer only, see registry/cwa.ts. */
export const O_A0001_001_DATASET_ID = "O-A0001-001";
/** Daily maximum UV index (紫外線指數-每日紫外線指數最大值) — generic-layer only, see registry/cwa.ts. */
export const O_A0005_001_DATASET_ID = "O-A0005-001";
/** Typhoon news/bulletin (颱風消息與警報-颱風消息) — powers tw_typhoon, see registry/cwa.ts and tools/typhoon.ts. */
export const W_C0034_005_DATASET_ID = "W-C0034-005";
/** Typhoon warning (颱風消息與警報-颱風警報) — generic-layer only, see registry/cwa.ts. */
export const W_C0034_001_DATASET_ID = "W-C0034-001";

/**
 * TDX (交通部運輸資料流通服務) OAuth2 client_credentials token endpoint.
 * Confirmed via the task's own pre-verified spec (not re-searched this
 * session) and cross-checked against TDX's official onboarding docs during
 * research: HTTP POST, application/x-www-form-urlencoded body with
 * grant_type=client_credentials + client_id + client_secret.
 */
export const TDX_TOKEN_URL = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";

/** TDX's "basic" data API base — confirmed via WebSearch against the official Swagger docs (tdx.transportdata.tw/api-service/swagger), not memory. */
export const TDX_API_BASE_URL = "https://tdx.transportdata.tw/api/basic";

/** TDX member portal — where to register and create a client id/secret pair. */
export const TDX_SIGNUP_URL = "https://tdx.transportdata.tw/register";

/**
 * Path prefix for the bus estimated-time-of-arrival dataset, including the
 * `v2` API version segment TDX's basic data API uses for this resource
 * group (confirmed via multiple real example URLs found by WebSearch, e.g.
 * `tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/City/
 * Taipei/202?$format=JSON` — not assumed from TDX_API_BASE_URL alone).
 * Full documented path: `/v2/Bus/EstimatedTimeOfArrival/City/{City}`
 * (city as a required URL path segment, not a query param — unlike CWA/
 * MOENV). The `{City}` segment itself is supplied per-request by
 * `busEtaEntry.buildPathSegments` (see registry/tdx.ts), not baked in here.
 */
export const TDX_BUS_ETA_PATH_PREFIX = "v2/Bus/EstimatedTimeOfArrival/City";

/**
 * Path prefix for the public bike-sharing (YouBike etc.) real-time
 * availability dataset.
 *
 * WebSearch initially suggested `/v2/Bike/Availability/{City}` (no literal
 * "City/" segment before the city value, unlike bus ETA's `.../City/
 * {City}`) — a REAL dispatch of fixtures-refresh.yml disproved this with a
 * genuine HTTP 404 (`{"message":"Resouce Not Found"}`, upstream's own
 * typo). Corrected to include the "City/" segment, matching bus ETA's
 * convention (`.../Availability/City/{City}`), pending re-confirmation via
 * another real dispatch — exactly the "don't trust research-derived paths
 * without a real response" discipline AGENTS.md already establishes for
 * field *shapes*, now shown to apply to URL *paths* too.
 */
export const TDX_BIKE_AVAILABILITY_PATH_PREFIX = "v2/Bike/Availability/City";

/**
 * Path prefix for the public bike-sharing STATION METADATA dataset
 * (name/address/coordinates/capacity) — a separate endpoint from
 * availability, confirmed necessary by a real dispatch of the Availability
 * endpoint above: its response has no station name at all, only
 * StationUID/StationID + numeric counts (see registry/tdx.ts's module
 * comment on youBikeEntry for the full story). Assumed to follow the same
 * `.../City/{City}` convention confirmed for both bus ETA and bike
 * availability — pending its own real-dispatch confirmation before this
 * stops being a skeleton assumption.
 */
export const TDX_BIKE_STATION_PATH_PREFIX = "v2/Bike/Station/City";

/**
 * Path for the nationwide TRA (台鐵) station list — confirmed via WebSearch
 * against TDX's official Swagger docs and independent real example URLs
 * (e.g. `tdx.transportdata.tw/api/basic/v2/Rail/TRA/Station?
 * $select=StationID,StationAddress`). Unlike bus/bike, this is a single
 * nationwide list with no per-city or per-station path segment — the whole
 * point of this entry is to let `tw_rail` resolve a station NAME (what a
 * caller would actually type) to the StationID the LiveBoard endpoint
 * requires.
 */
export const TDX_RAIL_TRA_STATION_PATH = "v2/Rail/TRA/Station";

/**
 * Path prefix for TRA's real-time arrival/departure board (LiveBoard) —
 * confirmed via WebSearch against TDX's official Swagger docs and multiple
 * independent real example URLs (e.g. `tdx.transportdata.tw/api/basic/v2/
 * Rail/TRA/LiveBoard/Station/1000?$filter=Direction eq 1&$format=JSON`).
 * StationID is a required path segment, supplied per-request by
 * `railTraLiveboardEntry.buildPathSegments` (registry/tdx.ts) — not a
 * station NAME, which is why `tw_rail` needs `railTraStationEntry` above to
 * resolve one to the other first.
 *
 * TDX's own documentation (per the task that specified this session's
 * scope, already confirmed — not re-searched) states this LiveBoard has a
 * known ~2 minute latency and is not guaranteed to exactly match a
 * station's own physical platform display (TIDS) — this must be disclosed
 * in tw_rail's tool description, not just this code comment.
 *
 * THSR (高鐵) does NOT get an equivalent entry this session: WebSearch
 * found no THSR endpoint matching this "live delay board" shape — THSR's
 * TDX endpoints found were DailyTimetable (scheduled, not live) and
 * AvailableSeatStatus (seat inventory), structurally different from what
 * this session's task asked for (即時到離站看板 + 誤點分鐘數). Scoped out
 * rather than forced to fit — see the PR for the full reasoning.
 */
export const TDX_RAIL_TRA_LIVEBOARD_PATH_PREFIX = "v2/Rail/TRA/LiveBoard/Station";

/**
 * TDX's English city/county path-segment codes. The six special
 * municipalities (Taipei/NewTaipei/Taoyuan/Taichung/Tainan/Kaohsiung) are
 * confirmed with high confidence — identical spelling appeared across every
 * independent source checked. The remaining counties/cities are confirmed
 * with moderate confidence (consistent across sources found, but TDX's own
 * Swagger/city-code reference page could not be fetched directly — blocked
 * by the sites queried returning 403 to automated fetches). Hsinchu and
 * Chiayi are the two names most likely to be wrong if this list has an
 * error (city vs. county naming: "Hsinchu"/"Chiayi" for the cities,
 * "HsinchuCounty"/"ChiayiCounty" for the counties) — this wasn't
 * independently re-verified via a real TDX response in this session (only
 * "Taipei", used as sampleParams, was), so a wrong entry here would surface
 * as a normal empty-result/404 for that one city, not a systemic failure.
 */
export const TDX_CITIES = [
  "Taipei",
  "NewTaipei",
  "Taoyuan",
  "Taichung",
  "Tainan",
  "Kaohsiung",
  "Keelung",
  "Hsinchu",
  "HsinchuCounty",
  "MiaoliCounty",
  "ChanghuaCounty",
  "NantouCounty",
  "YunlinCounty",
  "Chiayi",
  "ChiayiCounty",
  "PingtungCounty",
  "YilanCounty",
  "HualienCounty",
  "TaitungCounty",
  "PenghuCounty",
  "KinmenCounty",
  "LienchiangCounty"
] as const;

export type TdxCity = (typeof TDX_CITIES)[number];

/** TDX access tokens are reported to last ~1 day; refresh this much earlier than the upstream `expires_in` to avoid a request landing right at the boundary. */
export const TDX_TOKEN_EXPIRY_BUFFER_SECONDS = 60;

/** Cloudflare Workers KV's documented minimum TTL for `expirationTtl` — a computed token-cache TTL below this would make the KV `put` call fail. */
export const KV_MIN_TTL_SECONDS = 60;

export const MOENV_API_BASE_URL = "https://data.moenv.gov.tw/api/v2";

/** MOENV open data platform home — register here, then copy the API key from the member area. */
export const MOENV_SIGNUP_URL = "https://data.moenv.gov.tw/";

export const AQX_P_432_DATASET_ID = "aqx_p_432";
/** Air quality forecast (空氣品質預報, distinct from the real-time aqx_p_432) — generic-layer only, see registry/moenv.ts. */
export const AQF_P_01_DATASET_ID = "aqf_p_01";
/** Real-time UV index by station (紫外線即時監測資料) — generic-layer only, see registry/moenv.ts. */
export const UV_S_01_DATASET_ID = "UV_S_01";

/**
 * Records requested per aqx_p_432 call so client-side filtering (see
 * air-quality.ts) sees the whole nationwide station list, not a partial
 * page. Taiwan's general ambient network has ~83-90 stations as of 2021-
 * 2026 (source: MOENV dataset docs and observed API traffic), so this
 * leaves well over 10x headroom for network growth. It's also, per MOENV's
 * own API documentation, the maximum `limit` the v2 API accepts in a single
 * request — so this is already the most we could ask for either way.
 */
export const AQX_P_432_FETCH_LIMIT = 1000;

/**
 * Cache TTLs (seconds), matched to each dataset's own update cadence:
 * F-C0032-001 updates a few times per day, E-A0015-001 on each significant
 * quake, aqx_p_432 hourly.
 */
export const WEATHER_CACHE_TTL_SECONDS = 30 * 60;
export const EARTHQUAKE_CACHE_TTL_SECONDS = 5 * 60;
export const AIR_QUALITY_CACHE_TTL_SECONDS = 10 * 60;
/** F-A0021-001 covers a rolling 1-month window and changes rarely within a day. */
export const TIDE_FORECAST_CACHE_TTL_SECONDS = 6 * 60 * 60;
/** aqf_p_01 is published 3x/day (10:30/16:30/22:00) with ad-hoc updates between. */
export const AIR_QUALITY_FORECAST_CACHE_TTL_SECONDS = 30 * 60;
/** UV_S_01 is hourly station data. */
export const UV_REALTIME_CACHE_TTL_SECONDS = 30 * 60;
/** W-C0033-001 update cadence is unverified (issued/lifted on an irregular schedule) — kept short since a stale warning is worse than an extra fetch. */
export const WEATHER_WARNING_CACHE_TTL_SECONDS = 10 * 60;
/** O-A0001-001 is hourly automated station data, same cadence class as UV_S_01/aqx_p_432. */
export const STATION_OBSERVATION_CACHE_TTL_SECONDS = 15 * 60;
/** O-A0005-001 is a same-day rolling maximum that updates as new readings come in (confirmed via real API response), not a static once-daily value — same cadence class as UV_S_01. */
export const UV_DAILY_MAX_CACHE_TTL_SECONDS = 30 * 60;
/** W-C0034-005 updates every 6 hours when a tropical cyclone is active (per its own dataset description); short TTL matters most during that window. */
export const TYPHOON_NEWS_CACHE_TTL_SECONDS = 10 * 60;
/** W-C0034-001 is issued hourly once a typhoon warning is in effect — same urgency class as weather warnings. */
export const TYPHOON_WARNING_CACHE_TTL_SECONDS = 10 * 60;
/** Bus ETA is genuinely real-time (TDX's own dataset description calls it "動態資料"); a short TTL matters more than for any other dataset in this server. */
export const BUS_ETA_CACHE_TTL_SECONDS = 30;

/**
 * Cap on how many matched stops a single tw_bus_eta call returns. Confirmed
 * via a real dispatch of fixtures-refresh.yml that an unfiltered city query
 * (no routeName/stopName) can return tens of thousands of records for a
 * major city (Taipei alone: 28,731) — without a cap this would blow the
 * response-size budget (docs/ARCHITECTURE.md §2.3: "單次工具回應目標 ≤
 * 2,000 tokens") and be useless to a caller anyway. Chosen generously above
 * what a single real route's stop count looks like in practice (a real
 * captured route, "615", had 78 records across both directions) while
 * still bounding the worst case of an unfiltered city query.
 */
export const BUS_ETA_MAX_STOPS_RETURNED = 100;

/**
 * Cache TTL for bike STATION METADATA (tdx:youbike-station) — name,
 * address, coordinates, capacity. Confirmed via the same real dispatch
 * that confirmed availability's cadence (see YOUBIKE_CACHE_TTL_SECONDS)
 * that TDX republishes this in the same kind of batch, but the *content*
 * itself is near-static (a station's name/address/capacity essentially
 * never changes between polls, unlike availability's live counts) — so
 * this deliberately uses a much longer TTL than the batch-republish
 * cadence alone would suggest, since refetching unchanging metadata every
 * ~1 minute would be pure waste. 1 day, revisited if this server ever
 * needs same-day station additions/removals to show up faster.
 */
export const YOUBIKE_STATION_CACHE_TTL_SECONDS = 24 * 60 * 60;

/**
 * Evidence-based TTL for bike availability (tdx:youbike-availability),
 * derived the same way as BUS_ETA_CACHE_TTL_SECONDS but landing on a
 * different number because the real evidence itself differs: a real
 * capture (Taipei, 1,775 stations) showed TDX republishes this dataset in
 * one batch (every currently-in-service station shared one identical
 * `UpdateTime`), with a median 153s gap between each station's own
 * `SrcUpdateTime` and that shared `UpdateTime` — consistent with YouBike's
 * commonly documented ~1-minute refresh cadence. Coarser than bus ETA's
 * observed ~7s SrcUpdateTime-to-UpdateTime gap (TTL 30s), so this is set
 * higher — see registry/tdx.ts's module comment on youBikeAvailabilityEntry
 * for the full reasoning.
 */
export const YOUBIKE_CACHE_TTL_SECONDS = 60;

/** Cap on how many matched stations a single tw_youbike call returns — same response-budget reasoning as BUS_ETA_MAX_STOPS_RETURNED. Taipei alone has 1,775 real stations (confirmed via dispatch), so an unfiltered/broad query needs this cap. */
export const YOUBIKE_MAX_STATIONS_RETURNED = 100;

/** Nationwide TRA station list — near-static (station name/location essentially never changes between polls), same reasoning as YOUBIKE_STATION_CACHE_TTL_SECONDS. */
export const RAIL_TRA_STATION_CACHE_TTL_SECONDS = 24 * 60 * 60;

/**
 * Cache TTL for TRA LiveBoard. A real capture (Taipei Station, 8 trains)
 * showed all 8 sharing one identical `UpdateTime` (one batch snapshot) with
 * per-train `SrcUpdateTime` trailing it by roughly 25s-7min — a single
 * snapshot can't directly show the batch's own republish interval, so this
 * doesn't derive a tighter number from that gap the way
 * BUS_ETA_CACHE_TTL_SECONDS/YOUBIKE_CACHE_TTL_SECONDS did. Instead this
 * stays at the task's own explicit hard ceiling: TDX's LiveBoard already
 * carries a documented ~2 minute latency of its own, so this server's cache
 * must not stack meaningfully more staleness on top of that — 60s max,
 * consistent with the module comment on railTraLiveboardEntry
 * (registry/tdx.ts) and the 2-minute-delay disclosure required in tw_rail's
 * tool description.
 */
export const RAIL_LIVEBOARD_CACHE_TTL_SECONDS = 60;

/**
 * The ~2-minute-delay / platform-display disclosure, as fixed text embedded
 * directly in tw_rail's own response data (`RailResult.delayNotice`), not
 * just in the tool's `description` or a code comment. A tool's `description`
 * is guidance for an LLM caller on *how* to use the tool — it is not
 * guaranteed to be relayed to the end user on every call, and in production
 * this notice was found to be reliably missing from what the caller actually
 * saw (only present in `formatRailText`'s human-readable string, which some
 * MCP clients don't surface as prominently as `structuredContent`). Putting
 * it in the data itself means it survives regardless of which representation
 * (content text vs structuredContent) a caller reads. This is a compliance
 * requirement (氣象法-style faithful-disclosure discipline, same as the
 * typhoon tool), not an optional nicety — see the fix that added this field.
 */
export const RAIL_LIVEBOARD_DELAY_NOTICE =
  "⚠️ 本資料為交通部 TDX 轉載之台鐵即時到離站看板，官方文件註明約有 2 分鐘延遲，" +
  "且不保證與車站月台實際看板（TIDS）完全一致，實際到離站狀況請以車站月台顯示為準。";

/** Cap on how many trains a single tw_rail call returns for one station's board — same response-budget reasoning as BUS_ETA_MAX_STOPS_RETURNED/YOUBIKE_MAX_STATIONS_RETURNED, though a real per-station capture (Taipei, 8 trains) suggests this is generous headroom rather than a commonly-hit limit. */
export const RAIL_LIVEBOARD_MAX_TRAINS_RETURNED = 50;

/** How many candidate station names tw_rail's ambiguous-match error lists, so the caller can pick a more specific one without the error message itself becoming huge. */
export const RAIL_STATION_AMBIGUOUS_CANDIDATES_SHOWN = 10;

/**
 * Taiwan's 22 counties/cities as used by CWA's `locationName` parameter.
 * CWA uses the traditional character "臺" (not the common variant "台") in
 * 臺北市, 臺中市, 臺南市, and 臺東縣 — this must match exactly or the API
 * returns an empty result.
 */
export const TAIWAN_CITIES = [
  "臺北市",
  "新北市",
  "桃園市",
  "臺中市",
  "臺南市",
  "高雄市",
  "基隆市",
  "新竹市",
  "嘉義市",
  "新竹縣",
  "苗栗縣",
  "彰化縣",
  "南投縣",
  "雲林縣",
  "嘉義縣",
  "屏東縣",
  "宜蘭縣",
  "花蓮縣",
  "臺東縣",
  "澎湖縣",
  "金門縣",
  "連江縣"
] as const;

export type TaiwanCity = (typeof TAIWAN_CITIES)[number];
