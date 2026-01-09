// assets/config.js
export const JFSC_OAUTH = {
	clientId: "6806384196462851166",
	redirectPath: "pages/callback/",
	scopes: ["openid", "profile"],
}

export const JFSC_NET = {
	// Try official Roblox endpoints first…
	friendsBase: "https://friends.roblox.com",
	thumbnailsBase: "https://thumbnails.roblox.com",

	// …but fall back automatically if the browser blocks CORS.
	// (RoProxy mirrors Roblox subdomains and typically adds permissive CORS headers.)
	friendsFallbackBase: "https://friends.roproxy.com",
	thumbnailsFallbackBase: "https://thumbnails.roproxy.com",
}
