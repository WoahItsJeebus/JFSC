// assets/api.js
import { JFSC_OAUTH, JFSC_NET } from "./config.js"

const TOKENS_KEY = "JFSC_OAUTH_TOKENS_v1"

function normBase(s) {
	return String(s || "").replace(/\/+$/, "")
}

function isLikelyCorsError(e) {
	const msg = String(e?.message || e || "")
	// In browsers, CORS blocks commonly show up as TypeError + “Failed to fetch”
	return (e instanceof TypeError) || /failed to fetch|networkerror|cors|blocked/i.test(msg)
}

async function tryWithFallback(makeUrl, fetchOpts, bases) {
	let lastErr = null

	for (const base of bases) {
		if (!base) continue
		try {
			return await robloxFetch(makeUrl(normBase(base)), fetchOpts)
		} catch (e) {
			lastErr = e
			// Only fall back if it smells like CORS/network. Otherwise, surface real errors immediately.
			if (!isLikelyCorsError(e)) throw e
		}
	}

	throw lastErr || new Error("Request failed (no base URLs available).")
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms))
}

function safeJsonParse(str) {
	try { return JSON.parse(str) } catch { return null }
}

function nowMs() {
	return Date.now()
}

function isObj(v) {
	return v && typeof v === "object"
}

export function getStoredTokens() {
	const raw = localStorage.getItem(TOKENS_KEY)
	return raw ? safeJsonParse(raw) : null
}

export function setStoredTokens(tokensObj) {
	if (!isObj(tokensObj)) throw new Error("setStoredTokens expected an object")
	localStorage.setItem(TOKENS_KEY, JSON.stringify(tokensObj))
}

export function clearStoredTokens() {
	localStorage.removeItem(TOKENS_KEY)
}

export function hasAccessToken() {
	const t = getStoredTokens()
	return !!(t && t.accessToken)
}

export function isAccessTokenExpired(tokens, skewMs = 30000) {
	if (!tokens?.accessToken) return true
	const exp = Number(tokens?.expiresAtMs || 0)
	if (!exp) return false // if unknown, assume valid (Roblox returns expires_in normally)
	return (nowMs() + skewMs) >= exp
}

async function robloxFetch(url, {
	method = "GET",
	headers = {},
	body = null,
	auth = false,
	expectJson = true,
	retries = 4,
	retryBaseMs = 450,
	timeoutMs = 20000,
} = {}) {
	const h = new Headers(headers || {})

	if (auth) {
		const token = await getAccessToken()
		h.set("Authorization", `Bearer ${token}`)
	}

	const ctrl = new AbortController()
	const to = setTimeout(() => ctrl.abort(), timeoutMs)

	try {
		let lastErr = null

		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				let res
				try {
					res = await fetch(url, {
						method,
						headers: h,
						body,
						signal: ctrl.signal,
					})
				} catch (e) {
					throw new Error(`Fetch failed (likely CORS/network) for ${url}: ${e?.message || e}`)
				}

				// Retryable statuses
				if ([429, 500, 502, 503, 504].includes(res.status) && attempt < retries) {
					const wait = retryBaseMs * Math.pow(2, attempt)
					await sleep(wait)
					continue
				}

				const text = await res.text()

				if (!res.ok) {
					let detail = text
					const maybe = safeJsonParse(text)
					if (maybe?.error_description) detail = maybe.error_description
					else if (maybe?.error) detail = maybe.error
					throw new Error(`HTTP ${res.status} ${res.statusText}: ${detail}`)
				}

				if (!expectJson) return text

				const data = safeJsonParse(text)
				if (data == null) throw new Error("Expected JSON but got non-JSON response.")
				return data
			}
			catch (e) {
				lastErr = e
				if (attempt >= retries) throw e
				await sleep(retryBaseMs * Math.pow(2, attempt))
			}
		}

		throw lastErr || new Error("robloxFetch failed.")
	}
	finally {
		clearTimeout(to)
	}
}

async function refreshTokens(refreshToken) {
	const body = new URLSearchParams()
	body.set("grant_type", "refresh_token")
	body.set("client_id", JFSC_OAUTH.clientId)
	body.set("refresh_token", refreshToken)

	const data = await robloxFetch("https://apis.roblox.com/oauth/v1/token", {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body,
		auth: false,
		expectJson: true,
	})

	if (!data?.access_token) throw new Error("Refresh succeeded but access_token is missing.")

	const expiresIn = Number(data.expires_in || 0)
	const n = nowMs()

	const next = {
		version: 1,
		obtainedAtMs: n,
		expiresAtMs: n + Math.max(0, expiresIn * 1000) - 15000,
		tokenType: data.token_type || "Bearer",
		scope: data.scope || "",
		accessToken: data.access_token,
		refreshToken: data.refresh_token || refreshToken || "",
		idToken: data.id_token || "",
	}

	setStoredTokens(next)
	return next
}

export async function getAccessToken({ allowRefresh = true } = {}) {
	const tokens = getStoredTokens()
	if (!tokens?.accessToken) throw new Error("Not signed in (no access token stored).")

	if (!isAccessTokenExpired(tokens)) return tokens.accessToken

	if (!allowRefresh) throw new Error("Access token expired.")
	if (!tokens.refreshToken) throw new Error("Access token expired and no refresh token is available.")

	const next = await refreshTokens(tokens.refreshToken)
	return next.accessToken
}

export async function fetchUserInfo() {
	// Requires: openid (+profile if you want name/nickname/etc)
	return await robloxFetch("https://apis.roblox.com/oauth/v1/userinfo", {
		auth: true,
		expectJson: true,
	})
}

export async function fetchFriendsList(userId, { limit = 100, cursor = "" } = {}) {
	const bases = [
		JFSC_NET?.friendsBase,
		JFSC_NET?.friendsFallbackBase,
	]

	return await tryWithFallback((base) => {
		const u = new URL(`${base}/v1/users/${encodeURIComponent(userId)}/friends`)
		u.searchParams.set("limit", String(limit))
		if (cursor) u.searchParams.set("cursor", cursor)
		return u.toString()
	}, {
		auth: false,
		expectJson: true,
	}, bases)
}

export async function fetchAllFriends(userId, { pageLimit = 100, hardCap = 2000 } = {}) {
	const out = []
	let cursor = ""
	let guard = 0

	while (guard++ < 100) {
		const data = await fetchFriendsList(userId, { limit: pageLimit, cursor })

		const items = Array.isArray(data?.data) ? data.data : []
		out.push(...items)

		// Roblox uses variants across endpoints; handle a few common ones
		const next =
			data?.nextPageCursor ??
			data?.nextCursor ??
			data?.nextPageToken ??
			null

		if (!next) break
		cursor = next

		if (out.length >= hardCap) break
	}

	// Normalize to simplest shape
	return out.map((f) => ({
		id: Number(f?.id ?? f?.userId ?? 0),
		name: String(f?.name ?? f?.username ?? ""),
		displayName: String(f?.displayName ?? f?.display_name ?? ""),
	}))
		.filter((f) => Number.isFinite(f.id) && f.id > 0)
}

export async function fetchAvatarHeadshots(userIds, {
	size = "48x48",
	format = "Png",
	isCircular = true,
} = {}) {
	const ids = (userIds || [])
		.map((n) => Number(n))
		.filter((n) => Number.isFinite(n) && n > 0)

	if (!ids.length) return new Map()

	const bases = [
		JFSC_NET?.thumbnailsBase,
		JFSC_NET?.thumbnailsFallbackBase,
	]

	const data = await tryWithFallback((base) => {
		const u = new URL(`${base}/v1/users/avatar-headshot`)
		u.searchParams.set("userIds", ids.join(","))
		u.searchParams.set("size", size)
		u.searchParams.set("format", format)
		u.searchParams.set("isCircular", String(!!isCircular))
		return u.toString()
	}, {
		auth: false,
		expectJson: true,
	}, bases)

	const m = new Map()
	const arr = Array.isArray(data?.data) ? data.data : []
	for (const it of arr) {
		const id = Number(it?.targetId ?? it?.userId ?? 0)
		const url = it?.imageUrl || it?.imageUrlFinal || it?.url || ""
		if (id > 0 && url) m.set(id, url)
	}

	return m
}
