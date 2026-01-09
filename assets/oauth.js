// assets/oauth.js
import { JFSC_OAUTH } from "./config.js"

const LS_CLIENT_ID = "jfsc.oauth.clientId"
const SS_STATE = "jfsc.oauth.state"
const SS_VERIFIER = "jfsc.pkce.verifier"
const PENDING_KEY = "JFSC_OAUTH_PENDING_v1"

function base64UrlEncode(bytes) {
	let bin = ""
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

async function sha256Bytes(str) {
	const enc = new TextEncoder().encode(str)
	const hash = await crypto.subtle.digest("SHA-256", enc)
	return new Uint8Array(hash)
}

function randomBytes(len) {
	const arr = new Uint8Array(len)
	crypto.getRandomValues(arr)
	return arr
}

function makeState() {
	return base64UrlEncode(randomBytes(16))
}

function makeVerifier() {
	return base64UrlEncode(randomBytes(32))
}

function getClientId() {
	// Allow local override for dev, otherwise use shipped config
	return localStorage.getItem(LS_CLIENT_ID) || JFSC_OAUTH.clientId || ""
}

export function getRedirectUri() {
	return new URL(JFSC_OAUTH.redirectPath, window.location.href).toString()
}

export function explainClientIdSetup() {
	return [
		"Missing OAuth Client ID.",
		"",
		"Set it via config.js (recommended), or temporarily via console:",
		`localStorage.setItem("${LS_CLIENT_ID}","YOUR_CLIENT_ID")`,
	].join("\n")
}

export async function startOAuthLogin({
	scopes = JFSC_OAUTH.scopes || ["openid", "profile"],
	promptIfMissing = true,
} = {}) {
	const clientId = getClientId()
	if (!clientId) {
		if (promptIfMissing) alert(explainClientIdSetup())
		throw new Error("Missing OAuth clientId (config.js or localStorage jfsc.oauth.clientId).")
	}

	const redirectUri = getRedirectUri()
	const state = makeState()
	const verifier = makeVerifier()
	const challengeBytes = await sha256Bytes(verifier)
	const challenge = base64UrlEncode(challengeBytes)

	// Session checks (extra safety)
	sessionStorage.setItem(SS_STATE, state)
	sessionStorage.setItem(SS_VERIFIER, verifier)

	// Callback expects this
	localStorage.setItem(PENDING_KEY, JSON.stringify({
		state,
		codeVerifier: verifier,
		clientId,
		redirectUri,
	}))

	const u = new URL("https://apis.roblox.com/oauth/v1/authorize")
	u.searchParams.set("client_id", clientId)
	u.searchParams.set("redirect_uri", redirectUri)
	u.searchParams.set("response_type", "code")
	u.searchParams.set("scope", scopes.join(" "))
	u.searchParams.set("state", state)
	u.searchParams.set("code_challenge", challenge)
	u.searchParams.set("code_challenge_method", "S256")

	window.location.assign(u.toString())
}