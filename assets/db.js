// assets/db.js
const DB_KEY = "JFSC_DB_v1"
const DB_VERSION = 1

function nowMs() {
	return Date.now()
}

function safeJsonParse(str) {
	try { return JSON.parse(str) } catch { return null }
}

function isObj(v) {
	return v && typeof v === "object"
}

function isFinitePosInt(n) {
	return Number.isFinite(n) && n > 0
}

function toNum(v, fallback = 0) {
	const n = Number(v)
	return Number.isFinite(n) ? n : fallback
}

export function makeEmptyDb() {
	const n = nowMs()
	return {
		version: DB_VERSION,
		createdAtMs: n,
		updatedAtMs: n,
		ownerUserId: null,

		// First time we successfully sync friends for this owner.
		// Friends found during baseline are marked "not_recorded".
		baselineCapturedMs: null,

		friends: {}, // { [userId]: FriendRec }

		// Cached "last known" friend list + thumbnails for instant load.
		friendsCache: {
			updatedAtMs: null,
			friends: [],
			headshots: {},
		},
	}
}

export function loadDb() {
	const raw = localStorage.getItem(DB_KEY)
	if (!raw) return makeEmptyDb()

	const db = safeJsonParse(raw)
	if (!isObj(db) || db.version !== DB_VERSION || !isObj(db.friends)) {
		return makeEmptyDb()
	}

	if (!("baselineCapturedMs" in db)) db.baselineCapturedMs = null

	// Backfill cache structure
	if (!("friendsCache" in db) || !isObj(db.friendsCache)) {
		db.friendsCache = { updatedAtMs: null, friends: [], headshots: {} }
	} else {
		if (!("updatedAtMs" in db.friendsCache)) db.friendsCache.updatedAtMs = null
		if (!Array.isArray(db.friendsCache.friends)) db.friendsCache.friends = []
		if (!isObj(db.friendsCache.headshots)) db.friendsCache.headshots = {}
	}

	return db
}

export function saveDb(db) {
	if (!isObj(db)) throw new Error("saveDb expected an object")
	db.updatedAtMs = nowMs()
	localStorage.setItem(DB_KEY, JSON.stringify(db))
	return db
}

export function resetDb() {
	localStorage.removeItem(DB_KEY)
	return makeEmptyDb()
}

export function ensureOwner(db, ownerUserId) {
	if (!db || !isObj(db)) db = makeEmptyDb()

	const uid = Number(ownerUserId)
	if (!Number.isFinite(uid) || uid <= 0) throw new Error("ensureOwner requires a valid ownerUserId")

	if (db.ownerUserId == null) {
		db.ownerUserId = uid
		return saveDb(db)
	}

	// If user switches accounts, start a fresh DB
	if (db.ownerUserId !== uid) {
		const fresh = makeEmptyDb()
		fresh.ownerUserId = uid
		return saveDb(fresh)
	}

	return db
}

/**
 * FriendRec:
 * {
 *		userId: number,
 *		firstSeenMs: number,
 *		lastSeenMs: number,
 *		friendsSinceMs: number|null,
 *		source: "not_recorded"|"observed"|"manual",
 * }
 */

export function setManualFriendsSince(db, friendUserId, dateOrMs) {
	const uidNum = Number(friendUserId)
	if (!Number.isFinite(uidNum) || uidNum <= 0) throw new Error("Invalid friendUserId")

	let ms = null
	if (typeof dateOrMs === "number") ms = dateOrMs
	else if (dateOrMs instanceof Date) ms = dateOrMs.getTime()
	else if (typeof dateOrMs === "string") {
		const t = Date.parse(dateOrMs)
		if (Number.isFinite(t)) ms = t
	}

	if (!Number.isFinite(ms) || ms <= 0) throw new Error("Invalid date/ms provided.")

	const uid = String(uidNum)
	const n = nowMs()

	const prev = db.friends[uid]
	db.friends[uid] = {
		userId: uidNum,
		firstSeenMs: prev?.firstSeenMs ?? n,
		lastSeenMs: prev?.lastSeenMs ?? n,
		friendsSinceMs: ms,
		source: "manual",
	}

	return saveDb(db)
}

// Alias (older code uses setManualFriendsSince; newer code may call setRecordedFriendsSince)
export const setRecordedFriendsSince = setManualFriendsSince

export function clearRecordedFriendsSince(db, friendUserId) {
	const uidNum = Number(friendUserId)
	if (!Number.isFinite(uidNum) || uidNum <= 0) throw new Error("Invalid friendUserId")
	const uid = String(uidNum)

	const rec = db.friends[uid]
	if (!rec) return db

	rec.friendsSinceMs = null
	rec.source = "not_recorded"
	return saveDb(db)
}

function normalizeIds(friendUserIds) {
	return (friendUserIds || [])
		.map((n) => Number(n))
		.filter((n) => Number.isFinite(n) && n > 0)
}

/**
 * syncFriends:
 * - If baseline not captured yet: create records for all current friends as not_recorded (no friendsSince)
 * - After baseline: new IDs become observed (friendsSince = now)
 */
export function syncFriends(db, friendUserIds, { now = nowMs() } = {}) {
	const ids = normalizeIds(friendUserIds)
	const seen = new Set(ids.map(String))

	const added = []
	const updated = []
	const removed = []

	// Baseline capture
	if (!db.baselineCapturedMs) {
		for (const idNum of ids) {
			const id = String(idNum)
			if (!db.friends[id]) {
				db.friends[id] = {
					userId: idNum,
					firstSeenMs: now,
					lastSeenMs: now,
					friendsSinceMs: null,
					source: "not_recorded",
				}
				added.push(idNum)
			}
			else {
				db.friends[id].lastSeenMs = now
				updated.push(idNum)
			}
		}

		db.baselineCapturedMs = now
		saveDb(db)

		// Track removals (none meaningful on baseline)
		return { db, added, updated, removed, baseline: true }
	}

	// Normal sync (after baseline)
	for (const idNum of ids) {
		const id = String(idNum)
		const prev = db.friends[id]

		if (!prev) {
			db.friends[id] = {
				userId: idNum,
				firstSeenMs: now,
				lastSeenMs: now,
				friendsSinceMs: now,
				source: "observed",
			}
			added.push(idNum)
			continue
		}

		// Always mark last seen
		prev.lastSeenMs = now

		// If the record is baseline "not_recorded" but not manual, we can upgrade it to observed
		// once we see it after baseline and it still has no timestamp recorded.
		if (prev.source !== "manual" && (prev.friendsSinceMs == null || !Number.isFinite(prev.friendsSinceMs))) {
			prev.friendsSinceMs = now
			prev.source = "observed"
		}

		updated.push(idNum)
	}

	for (const idStr of Object.keys(db.friends)) {
		if (!seen.has(idStr)) {
			removed.push(Number(idStr))
		}
	}

	saveDb(db)
	return { db, added, updated, removed, baseline: false }
}

/**
 * Cache helpers
 * - Stores a snapshot of friends + thumbnails for instant load
 * - Does NOT store friendsSinceMs here; that's in db.friends records.
 */
export function saveFriendsCache(db, friends, headshotMap) {
	if (!db || !isObj(db)) throw new Error("saveFriendsCache requires db object")

	const list = Array.isArray(friends) ? friends : []
	const hs = {}
	if (headshotMap && typeof headshotMap.entries === "function") {
		for (const [k, v] of headshotMap.entries()) {
			if (k == null) continue
			hs[String(k)] = String(v || "")
		}
	}

	db.friendsCache = {
		updatedAtMs: nowMs(),
		friends: list.map((f) => ({
			id: Number(f.id),
			name: String(f.name || ""),
			displayName: String(f.displayName || ""),
		})).filter((f) => Number.isFinite(f.id) && f.id > 0),
		headshots: hs,
	}

	return saveDb(db)
}

export function loadFriendsCache(db) {
	if (!db || !isObj(db) || !isObj(db.friendsCache)) {
		return { friends: [], headshotMap: new Map(), updatedAtMs: null }
	}

	const c = db.friendsCache
	const friends = Array.isArray(c.friends) ? c.friends : []
	const headshots = isObj(c.headshots) ? c.headshots : {}

	const headshotMap = new Map()
	for (const k of Object.keys(headshots)) {
		const id = Number(k)
		if (!Number.isFinite(id) || id <= 0) continue
		const url = String(headshots[k] || "")
		if (url) headshotMap.set(id, url)
	}

	return {
		updatedAtMs: Number(c.updatedAtMs) || null,
		friends,
		headshotMap,
	}
}

/**
 * Export/Import helpers
 *
 * Export format:
 * {
 *		format: "JFSC_TRACK_EXPORT",
 *		version: 1,
 *		exportedAtMs: number,
 *		ownerUserId: number|null,
 *		baselineCapturedMs: number|null,
 *		records: [
 *			{ userId: number, friendsSinceMs: number, source: "manual"|"observed"|"not_recorded" }
 *		]
 * }
 */

export function exportTrackedData(db, {
	manualOnly = false,
} = {}) {
	if (!db || !isObj(db)) db = loadDb()

	const records = []
	for (const [k, rec] of Object.entries(db.friends || {})) {
		const userId = toNum(rec?.userId ?? k, 0)
		const ms = toNum(rec?.friendsSinceMs ?? 0, 0)
		const source = String(rec?.source ?? "not_recorded")

		if (!isFinitePosInt(userId)) continue
		if (!Number.isFinite(ms) || ms <= 0) continue

		if (manualOnly && source !== "manual") continue

		records.push({
			userId,
			friendsSinceMs: ms,
			source: (source === "manual") ? "manual" : (source === "observed") ? "observed" : "not_recorded",
		})
	}

	records.sort((a, b) => a.userId - b.userId)

	return {
		format: "JFSC_TRACK_EXPORT",
		version: 1,
		exportedAtMs: nowMs(),
		ownerUserId: db.ownerUserId ?? null,
		baselineCapturedMs: db.baselineCapturedMs ?? null,
		records,
	}
}

function parseImportPayload(payload) {
	if (!payload) return []

	// Case 1: preferred export format
	if (isObj(payload) && Array.isArray(payload.records)) {
		return payload.records
	}

	// Case 2: raw db dump compatibility (friends object)
	if (isObj(payload) && isObj(payload.friends)) {
		const out = []
		for (const [k, rec] of Object.entries(payload.friends)) {
			out.push({
				userId: toNum(rec?.userId ?? k, 0),
				friendsSinceMs: toNum(rec?.friendsSinceMs ?? 0, 0),
				source: String(rec?.source ?? "observed"),
			})
		}
		return out
	}

	return []
}

/**
 * importTrackedData:
 * - Only applies records where userId is present in allowedFriendIds (Set or array)
 * - If incoming.source === "manual": ALWAYS override local (even if local manual)
 * - If incoming is not manual: never overwrite local manual
 * - Otherwise: apply only if local missing OR incoming earlier (useful restore)
 *
 * Returns:
 * { db, applied, skippedNotFriend, skippedBad, skippedProtected }
 */
export function importTrackedData(db, payload, {
	allowedFriendIds = null,		// Set<number> or number[]
	manualOverrides = true,		// manual always wins
} = {}) {
	if (!db || !isObj(db)) db = loadDb()

	let allowed = null
	if (allowedFriendIds instanceof Set) {
		allowed = allowedFriendIds
	} else if (Array.isArray(allowedFriendIds)) {
		allowed = new Set(allowedFriendIds.map(Number).filter((n) => isFinitePosInt(n)))
	} else if (allowedFriendIds == null) {
		// If not provided, treat as "no restriction" (caller should pass current friend IDs)
		allowed = null
	} else {
		allowed = null
	}

	const incoming = parseImportPayload(payload)

	let applied = 0
	let skippedNotFriend = 0
	let skippedBad = 0
	let skippedProtected = 0

	const n = nowMs()

	for (const r of incoming) {
		const userId = toNum(r?.userId ?? r?.id ?? 0, 0)
		const ms = toNum(r?.friendsSinceMs ?? r?.sinceMs ?? 0, 0)
		const src = String(r?.source ?? "observed")

		if (!isFinitePosInt(userId) || !Number.isFinite(ms) || ms <= 0) {
			skippedBad++
			continue
		}

		if (allowed && !allowed.has(userId)) {
			skippedNotFriend++
			continue
		}

		const key = String(userId)
		const local = db.friends[key] || null

		// Manual import always overrides (requirement)
		if (manualOverrides && src === "manual") {
			const prev = local
			db.friends[key] = {
				userId,
				firstSeenMs: prev?.firstSeenMs ?? n,
				lastSeenMs: prev?.lastSeenMs ?? n,
				friendsSinceMs: ms,
				source: "manual",
			}
			applied++
			continue
		}

		// Do not let non-manual overwrite local manual
		if (local?.source === "manual") {
			skippedProtected++
			continue
		}

		// Apply if local missing or missing timestamp
		if (!local || !Number.isFinite(local.friendsSinceMs) || !local.friendsSinceMs) {
			db.friends[key] = {
				userId,
				firstSeenMs: local?.firstSeenMs ?? n,
				lastSeenMs: n,
				friendsSinceMs: ms,
				source: (src === "not_recorded") ? "not_recorded" : "observed",
			}
			applied++
			continue
		}

		// Apply if incoming is earlier (better data)
		if (ms < Number(local.friendsSinceMs)) {
			local.friendsSinceMs = ms
			local.lastSeenMs = n
			local.source = (src === "not_recorded") ? "not_recorded" : "observed"
			applied++
			continue
		}
	}

	saveDb(db)
	return { db, applied, skippedNotFriend, skippedBad, skippedProtected }
}

export function formatLocalDateTime(ms, {
	locale = undefined,
	timeZone = undefined,
} = {}) {
	if (!Number.isFinite(ms) || ms <= 0) return "—"
	try {
		return new Intl.DateTimeFormat(locale, {
			year: "numeric",
			month: "short",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			timeZone,
		}).format(new Date(ms))
	}
	catch {
		return new Date(ms).toLocaleString()
	}
}

export function formatDurationSince(ms, {
	now = nowMs(),
	maxParts = 2,
} = {}) {
	if (!Number.isFinite(ms) || ms <= 0) return "Not yet recorded"
	const delta = Math.max(0, now - ms)

	const sec = Math.floor(delta / 1000)
	const min = Math.floor(sec / 60)
	const hr = Math.floor(min / 60)
	const day = Math.floor(hr / 24)

	const years = Math.floor(day / 365)
	const daysAfterYears = day - years * 365
	const months = Math.floor(daysAfterYears / 30)
	const daysAfterMonths = daysAfterYears - months * 30

	const parts = []
	if (years) parts.push(`${years}y`)
	if (months) parts.push(`${months}mo`)
	if (!years && !months && daysAfterMonths) parts.push(`${daysAfterMonths}d`)
	if (!years && !months && !daysAfterMonths && hr) parts.push(`${hr}h`)
	if (!years && !months && !daysAfterMonths && !hr && min) parts.push(`${min}m`)
	if (!years && !months && !daysAfterMonths && !hr && !min) parts.push(`${sec}s`)

	return parts.slice(0, maxParts).join(" ")
}