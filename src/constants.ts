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
 * Path prefix for TDX's Metro (捷運) real-time operational status / service
 * disruption feed ("營運通阻") — confirmed via WebSearch, not guessed from
 * memory: an official tdx.transportdata.tw topic/example page's own title
 * includes the literal path `v2/Rail/Metro/Alert/TRTC` (this sandbox has no
 * direct network access to tdx.transportdata.tw — same restriction already
 * documented throughout this project — so only the WebSearch result
 * snippet, not a full page fetch, was available; the path itself is still a
 * verbatim quote from an official source, not invented). systemId is a
 * required path segment, supplied per-request by `metroAlertEntry.
 * buildPathSegments` (registry/tdx.ts) via `TDX_METRO_SYSTEM_ID_BY_NAME`.
 *
 * Deliberately NOT the static Line/Station/Network endpoints (also found via
 * WebSearch: `v2/Rail/Metro/Line/{systemId}`, `v2/Rail/Metro/Station/
 * {systemId}`) — this session's task is "is the metro running normally right
 * now", which this dynamic Alert feed answers directly. Whether a second,
 * joined entry for line/station names ends up necessary (e.g. if the real
 * Alert response only carries bare line/station IDs with no human-readable
 * name) is a decision deferred until a real dispatch shows what the
 * response actually contains — not built speculatively, per AGENTS.md §2's
 * guidance on multi-endpoint joins.
 */
export const TDX_METRO_ALERT_PATH_PREFIX = "v2/Rail/Metro/Alert";

/**
 * The three metro systems this session covers, per the task's explicit
 * scope (台北/高雄/桃園) — a caller-facing Chinese name mapped to the TDX
 * systemId its URL path segment actually needs. Codes confirmed via
 * WebSearch against multiple independent sources: TDX's own example URLs
 * use "TRTC"/"KRTC"/"TYMC" verbatim, independently corroborated by the
 * ChiaJung-Yeh/TDX_Guide R package documentation (which also notes Taichung
 * Metro's schedule data "尚未匯入 TDX" as of this session's research — no
 * Alert-capable systemId for it was found either, so it's excluded here
 * rather than guessed).
 */
export const TDX_METRO_SYSTEMS = ["台北", "高雄", "桃園"] as const;

export type TdxMetroSystemName = (typeof TDX_METRO_SYSTEMS)[number];

export const TDX_METRO_SYSTEM_ID_BY_NAME: Record<TdxMetroSystemName, string> = {
  台北: "TRTC",
  高雄: "KRTC",
  桃園: "TYMC"
};

/**
 * Cache TTL for Metro Alert. A real capture (Taipei/TRTC) turned up
 * stronger evidence than any other TDX entry in this project: TDX's
 * response itself self-reports its batch republish interval via
 * `UpdateInterval`/`SrcUpdateInterval` — both 60 (seconds) in the real
 * capture, not inferred from a SrcUpdateTime/UpdateTime gap the way
 * BUS_ETA_CACHE_TTL_SECONDS/YOUBIKE_CACHE_TTL_SECONDS/
 * RAIL_LIVEBOARD_CACHE_TTL_SECONDS had to. Matching that self-declared
 * interval exactly means this server's cache never stacks additional
 * staleness on top of what TDX already discloses.
 */
export const METRO_ALERT_CACHE_TTL_SECONDS = 60;

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
 * NOT registered this session — see the PR for the full story. TDX's
 * off-street (路外/立體) parking lot dataset path was confirmed via
 * WebSearch (`v1/Parking/OffStreet/CarPark/City/{City}`, a real example URL
 * found; note the genuine `v1` version group, not a typo) and the endpoint
 * itself responds correctly (200, well-formed batch wrapper: UpdateTime/
 * UpdateInterval/AuthorityCode/VersionID/CarParks) — but two independent
 * real dispatches, against Taipei (AuthorityCode "TPE") and New Taipei
 * ("NWT"), both came back with `CarParks: []`. Empty for Taiwan's two
 * largest, most digitally mature cities is strong enough evidence that this
 * "basic" resource isn't meaningfully populated, not a per-city gap worth
 * probing further — and with zero real records ever observed, no per-record
 * field structure (name, address, capacity, live space count) could be
 * confirmed either, so there's nothing real to type or fixture. Registering
 * a dataset that can only ever be shown to return zero results, with an
 * unconfirmed record shape, fails this project's real-fixture standard
 * (AGENTS.md §5) for no practical benefit — dropped rather than kept as a
 * permanently-empty skeleton. On-street (路邊) parking was investigated in
 * the same research pass — TDX's own R-package documentation
 * (ChiaJung-Yeh/TDX_Guide) confirms an on-street parking dataset exists
 * conceptually (`Car_Park(street="on")`), but no WebSearch query surfaced an
 * actual literal on-street REST path, so it was never registered either.
 */

/**
 * Path prefix for TDX's road CMS (可變訊息標誌 / changeable message signs)
 * dataset under the "路況資訊 v2" resource group — the closest real,
 * WebSearch-confirmed dataset to this session's "道路交通事件/施工封路"
 * ask. Multiple independent WebSearch results confirmed TDX's Road Traffic
 * v2 API group covers exactly five sibling resources: VD (vehicle
 * detectors), CCTV, CMS, ETag (toll gantries), and Section — with a real,
 * literal example URL confirming CCTV's exact path convention
 * (`tdx.transportdata.tw/api/basic/v2/Road/Traffic/CCTV/City/Hsinchu`).
 * No distinct "TrafficEvent"/"事件"/"施工封路" resource was found anywhere
 * in this resource group despite extensive searching — the only adjacent
 * hit was a *reporting/admin backend* ("交通部道路交通事件填報系統管理
 * 後臺") for authorities to file incidents, not a public read API for
 * querying them. This path (`.../Traffic/CMS/City/{City}`) is extrapolated
 * from CCTV's confirmed sibling convention applied to CMS's confirmed
 * resource name.
 *
 * IMPORTANT — corrected after the real capture, don't re-introduce this
 * mistake: this endpoint does NOT carry the actual message text currently
 * displayed on each sign. A real dispatch (Taipei, ~180 records) confirmed
 * every record is pure sign-location metadata (CMSID, LinkID, LocationType,
 * coordinates, optional RoadID/RoadName/RoadClass/RoadDirection) — no
 * message/display-content field anywhere. This is a static sign *inventory*
 * (closer to YouBike's Station half than its Availability half), not a live
 * board-content feed, and it does NOT answer "is there a road
 * event/closure right now" the way the task that asked for this dataset
 * wanted — see registry/tdx.ts's module comment on roadTrafficCmsEntry for
 * how this reshaped the entry's title/notes to stay honest about what it
 * actually contains.
 */
export const TDX_ROAD_TRAFFIC_CMS_PATH_PREFIX = "v2/Road/Traffic/CMS/City";

/**
 * Cache TTL for road CMS sign locations. A real capture showed TDX's own
 * self-reported `UpdateInterval` of 21600 seconds (6 hours) — matched
 * exactly, the same evidence-trusting approach as
 * METRO_ALERT_CACHE_TTL_SECONDS/RAIL_LIVEBOARD_CACHE_TTL_SECONDS, rather
 * than assuming a shorter TTL that would just add pointless refetching of
 * data TDX itself says only republishes every 6 hours. (The same response
 * also carried a slower `SrcUpdateInterval` of 86400s/24h for the
 * underlying source data — 6h is still the right number to cache against,
 * since that's the rate *this* endpoint actually republishes at.)
 */
export const ROAD_TRAFFIC_CMS_CACHE_TTL_SECONDS = 21600;

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

// --- 交通部高速公路局「交通資料庫」(tisvcloud.freeway.gov.tw) ---
//
// First source in this project with zero authentication (no API key, no
// OAuth) and the first with an XML wire format (see registry/highway.ts's
// choice of `fast-xml-parser`) — every prior source (CWA/MOENV/TDX) is
// JSON-over-API-key-or-OAuth.
//
// Path-finding here took real dispatch, not documentation, because the
// documentation itself was hard to use: this host silently drops
// connections from cloud/datacenter source IPs (confirmed unreachable from
// both this repo's dev sandbox and GitHub Actions — see the extra-delay
// comment below and AGENTS.md §6), AND separately refuses robots.txt-
// respecting fetch tools (a client-behavior gate, not an IP block — this
// is why WebFetch/WebSearch kept hitting 403s researching this platform's
// own docs, not because the docs don't exist). The one environment that
// could actually reach it was this project's own deployed Cloudflare
// Worker, so a temporary debug route (`GET /debug/probe-tisvcloud`,
// removed once its job was done — see git history) was used to explore
// real responses directly instead: root turned out to be a JS-rendered
// (Bootstrap + tisvcloud.js) landing page with no filenames in it, not a
// real directory listing; `/history/motc20/` turned out to be a genuine
// bare-autoindex "Index of ..." page (once the probe's body-extraction
// targeted its `id="indexlist"` table instead of a flat character slice
// that never got past a boilerplate usage-disclaimer preceding it) —
// THAT listing is what revealed `LiveEvents.xml` as the real, live-updating
// (last-modified minutes old at discovery time) road event feed, not any
// of the `*_value.xml.gz` names guessed earlier from a third-party R
// package's unrelated `Freeway_Shape()` helper.
export const HIGHWAY_API_BASE_URL = "https://tisvcloud.freeway.gov.tw";

/**
 * Real-time road event feed (事故/施工/管制), confirmed via the real
 * autoindex listing at /history/motc20/ — see the module comment above for
 * how that path was found. Nationwide (all freeways), not per-city like
 * TDX's entries; the only client-side filter this dataset supports is by
 * road name (see `HighwayLiveEventsParams.road` in registry/highway.ts),
 * because there is no county/city field on any record.
 */
export const HIGHWAY_LIVE_EVENTS_PATH = "history/motc20/LiveEvents.xml";

/**
 * Cache TTL for live road events. The real response's own `UpdateInterval`
 * field says 60 seconds — matched exactly, same evidence-trusting approach
 * as METRO_ALERT_CACHE_TTL_SECONDS/ROAD_TRAFFIC_CMS_CACHE_TTL_SECONDS. This
 * also comfortably clears this platform's own usage rule (its terms
 * require repeated fetches of the same file to be spaced at least 40
 * seconds apart) rather than merely happening to satisfy it — 60 was
 * chosen because it's what the data itself says, not because it's ≥ 40.
 */
export const HIGHWAY_LIVE_EVENTS_CACHE_TTL_SECONDS = 60;

// --- 政府標案（g0v 社群維護的非官方鏡像） ---
//
// THIS IS THE FIRST NON-OFFICIAL SOURCE IN THIS PROJECT. Every other source
// (CWA/MOENV/TDX/highway) is an agency publishing its own data directly.
// This one is a community-run mirror of 政府電子採購網's announcements,
// maintained by g0v/開放文化基金會 — see `SOURCE_PROVENANCE` in
// registry/index.ts, which is what actually makes that distinction
// machine-readable rather than leaving it as a comment here.
//
// Endpoints/params below were verified against the service's own OpenAPI
// spec (webdata/swagger.json) and the PHP implementation
// (webdata/controllers/ApiController.php) in openfunltd/pcc.g0v.ronny.tw,
// not from memory — the live site is unreachable from this sandbox (the
// egress proxy denies the domain outright), so the repo was the only
// verifiable source available at build time.
export const PCC_SITE_BASE_URL = "https://pcc.g0v.ronny.tw";
export const PCC_API_BASE_URL = `${PCC_SITE_BASE_URL}/api`;

/** The authoritative official source. Every response tells the caller to defer to this for anything binding. */
export const PCC_OFFICIAL_SITE_URL = "https://web.pcc.gov.tw/";

/** Search-by-tender-title endpoint. Verified in swagger.json as `/api/searchbytitle` taking `query` + optional `page`. */
export const PCC_TENDER_SEARCH_PATH = "searchbytitle";

/**
 * Verbatim 著作權聲明 as published by pcc.g0v.ronny.tw itself (its homepage
 * template, webdata/views/index/index.phtml), quoting 政府電子採購網's own
 * statement. Reproduced exactly — this is deliberately NOT the
 * 政府資料開放授權條款第 1 版 that every other source in this project uses;
 * it is a narrower, 著作權法 fair-use-based permission, and paraphrasing it
 * would misstate the terms.
 */
export const PCC_COPYRIGHT_NOTICE = [
  "(1)本採購網上所刊載以行政院公共工程委員會名義公開發表之著作，即著作人為行政院公共工程委員會者，在合理範圍內，得重製、公開播送或公開傳輸，利用時，並請註明出處。",
  "(2)本採購網上之資訊，可為個人或家庭非營利之目的而重製。",
  "(3)為報導、評論、教學、研究或其他正當目的，在合理範圍內，得引用本採購網上之資訊，引用時，並請註明出處。",
  "(4)其他合理使用情形，請參考著作權法第44條至第65條之規定。"
] as const;

/**
 * Source-credibility disclosure. Unlike the delay/latency disclaimers on
 * tw_typhoon / tw_metro_status / tw_highway_traffic, this one is about
 * *who published the data*, not how fresh it is — so it has to travel with
 * the data itself. `tools/tender.ts` puts this into both the formatted text
 * and `structuredContent.data`, not just the tool description (see AGENTS.md
 * on the tw_rail lesson: a disclosure that lives only in a description is
 * one the caller's LLM can drop when it summarizes).
 */
export const PCC_SOURCE_NOTICE =
  "資料來源為 g0v 社群維護之非官方鏡像服務（pcc.g0v.ronny.tw），非行政院公共工程委員會直接提供，" +
  `資料可能有延遲或缺漏，正式決標資訊請以政府電子採購網（${PCC_OFFICIAL_SITE_URL}）為準。`;

/**
 * 30 minutes. Tender announcements are published on a daily cadence (this
 * mirror re-crawls 政府電子採購網 rather than receiving a push feed), so a
 * short TTL buys nothing but load on a volunteer-run service. Deliberately
 * more conservative than any official source's TTL here: the API code
 * contains a usage-metering hook (`OpenFunAPIHelper::checkUsage`) whose
 * actual thresholds are not publicly documented, so "be a light client" is
 * the only safe posture — we cannot verify how close we are to a limit.
 */
export const TENDER_SEARCH_CACHE_TTL_SECONDS = 30 * 60;

/**
 * Upstream returns a fixed 100 records per page (hardcoded `'size' => 100`
 * in ApiController.php). That blows the ≤2,000-token response budget in
 * docs/ARCHITECTURE.md §2.3, so the transform truncates and tells the
 * caller to narrow the query — same approach as YOUBIKE_MAX_STATIONS_RETURNED
 * and RAIL_LIVEBOARD_MAX_TRAINS_RETURNED.
 */
export const TENDER_SEARCH_MAX_RESULTS_RETURNED = 10;

export type TaiwanCity = (typeof TAIWAN_CITIES)[number];
