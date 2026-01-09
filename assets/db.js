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

export function setRecordedFriendsSince(db, friendUserId, dateOrMs) {
	if (!db || !isObj(db)) db = makeEmptyDb()

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

export function clearRecordedFriendsSince(db, friendUserId) {
	if (!db || !isObj(db)) db = makeEmptyDb()

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
			} else {
				db.friends[id].lastSeenMs = now
				updated.push(idNum)
			}
		}

		db.baselineCapturedMs = now
		saveDb(db)
		return { db, added, updated, removed, baseline: true }
	}

	// After baseline, new friends get observed timestamp
	for (const idNum of ids) {
		const id = String(idNum)
		const rec = db.friends[id]

		if (!rec) {
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

		rec.lastSeenMs = now

		// If it was legacy/not_recorded, upgrade to observed if we have no timestamp
		if (!rec.friendsSinceMs && rec.source !== "manual") {
			rec.friendsSinceMs = now
			rec.source = "observed"
			updated.push(idNum)
		}
	}

	// Mark removals (optional bookkeeping)
	for (const [k, rec] of Object.entries(db.friends || {})) {
		const idNum = Number(rec?.userId || 0)
		if (!Number.isFinite(idNum) || idNum <= 0) continue
		if (!seen.has(String(idNum))) {
			removed.push(idNum)
		}
	}

	saveDb(db)
	return { db, added, updated, removed, baseline: false }
}

export function loadFriendsCache(db) {
	if (!db || !isObj(db)) db = loadDb()

	const c = db?.friendsCache
	if (!isObj(c) || !Array.isArray(c.friends) || !isObj(c.headshots)) return null

	const updatedAtMs = Number(c.updatedAtMs || 0) || 0

	const friends = c.friends
		.map((f) => ({
			id: Number(f?.id ?? 0),
			name: String(f?.name ?? ""),
			displayName: String(f?.displayName ?? ""),
		}))
		.filter((f) => Number.isFinite(f.id) && f.id > 0)

	const headshotMap = new Map()
	for (const [k, v] of Object.entries(c.headshots || {})) {
		const id = Number(k)
		if (Number.isFinite(id) && id > 0 && v) headshotMap.set(id, String(v))
	}

	if (!friends.length) return null
	return { friends, headshotMap, updatedAtMs }
}

export function saveFriendsCache(db, friends, headshotMap, { now = nowMs() } = {}) {
	if (!db || !isObj(db)) db = makeEmptyDb()

	const normalizedFriends = (friends || [])
		.map((f) => ({
			id: Number(f?.id ?? 0),
			name: String(f?.name ?? ""),
			displayName: String(f?.displayName ?? ""),
		}))
		.filter((f) => Number.isFinite(f.id) && f.id > 0)

	const headshots = {}
	if (headshotMap && typeof headshotMap.entries === "function") {
		for (const [id, url] of headshotMap.entries()) {
			const n = Number(id)
			if (Number.isFinite(n) && n > 0 && url) headshots[String(n)] = String(url)
		}
	}

	db.friendsCache = {
		updatedAtMs: now,
		friends: normalizedFriends,
		headshots,
	}

	saveDb(db)
	return db
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
} = {}) {
	if (!Number.isFinite(ms) || ms <= 0) return "—"
	const d = Math.max(0, now - ms)

	const sec = Math.floor(d / 1000)
	const min = Math.floor(sec / 60)
	const hr = Math.floor(min / 60)
	const day = Math.floor(hr / 24)

	if (day > 0) return `${day}d ${hr % 24}h`
	if (hr > 0) return `${hr}h ${min % 60}m`
	if (min > 0) return `${min}m ${sec % 60}s`
	return `${sec}s`
}