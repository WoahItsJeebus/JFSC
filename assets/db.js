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

		prev.lastSeenMs = now
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