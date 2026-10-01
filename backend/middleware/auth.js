import { ClerkExpressRequireAuth } from "@clerk/clerk-sdk-node";
import dotenv from "dotenv";

dotenv.config();

console.log("CLERK_SECRET_KEY loaded:", !!process.env.CLERK_SECRET_KEY);

// SECURITY: tokens must be cryptographically VERIFIED by Clerk.
// The old behaviour decoded the JWT payload without checking the
// signature whenever NODE_ENV !== "production" (which includes the common
// case where NODE_ENV is simply unset) — any forged token with an
// arbitrary `sub` claim was accepted as any user.
//
// Fail-closed default: every request goes through Clerk verification.
// The unverified decoder exists ONLY for offline local development and
// must be explicitly enabled with ALLOW_DEV_AUTH_BYPASS=true. Never set
// that variable in staging or production.
const ALLOW_DEV_BYPASS =
  process.env.ALLOW_DEV_AUTH_BYPASS === "true" &&
  process.env.NODE_ENV !== "production";

if (ALLOW_DEV_BYPASS) {
  console.warn(
    "⚠️  ALLOW_DEV_AUTH_BYPASS=true: auth tokens are DECODED WITHOUT signature verification. Local dev only."
  );
}

export const clerkAuth = (req, res, next) => {
  if (!ALLOW_DEV_BYPASS) {
    // ✅ Production AND default dev path: real Clerk verification
    return ClerkExpressRequireAuth()(req, res, next);
  }

  // ⚠️  Offline local-dev fallback (explicit opt-in only)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    try {
      const payload = JSON.parse(
        Buffer.from(token.split(".")[1], "base64").toString()
      );
      if (!payload.sub) return res.status(401).json({ error: "Invalid token" });
      req.auth = { userId: payload.sub, token };
    } catch (err) {
      console.error("Token decode error:", err);
      return res.status(401).json({ error: "Invalid token" });
    }
  } else {
    return res.status(401).json({ error: "No token provided" });
  }

  return next();
};
