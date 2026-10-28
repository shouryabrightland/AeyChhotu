import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/error-handler.js";
import { notFoundHandler } from "./middleware/not-found.js";
import { apiLimiter, loginLimiter } from "./middleware/rate-limit.js";
import { requestContext } from "./observability/logger.js";
import { healthRouter } from "./routes/health.js";
import { readyRouter } from "./routes/ready.js";
import { sessionsRouter } from "./routes/sessions.js";
import { authRouter } from "./routes/auth.js";
import { menuRouter } from "./routes/menu.js";
import { cartRouter } from "./routes/cart.js";
import { ordersRouter } from "./routes/orders.js";
import { kdsRouter } from "./routes/kds.js";
import { floorRouter } from "./routes/floor.js";
import { adminRouter } from "./routes/admin.js";

/* Dev convenience: a phone opening the Next dev server at http://192.168.x.x:3000
   sends an Origin that CLIENT_URL cannot list in advance (DHCP changes it), so
   every API call would fail CORS and the UI would look broken rather than
   unauthorised. Relax the allow-list to loopback and RFC 1918 addresses in
   DEVELOPMENT only; production still answers exactly to CLIENT_URL. */
const DEV_ORIGIN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d{1,5})?$/;

function originAllowed(origin: string): boolean {
  if (env.clientUrls.includes(origin)) return true;
  return env.nodeEnv !== "production" && DEV_ORIGIN_RE.test(origin);
}

/* Express app factory: security headers → request ids → CORS (CLIENT_URL
   only) → rate limits → routes → 404 → central error handler (registration
   order matters). */
export function createApp() {
  const app = express();

  app.disable("x-powered-by");

  /* Security headers. CSP is not applied here: Next.js owns the page
     shell and the API serves JSON only, where a document CSP is a no-op
     with a foot-gun cost. If this service ever renders HTML, add
     helmet.contentSecurityPolicy() with a real policy then. */
  app.use(helmet.crossOriginResourcePolicy({ policy: "cross-origin" }));
  app.use(helmet.noSniff());
  app.use(helmet.referrerPolicy({ policy: "strict-origin-when-cross-origin" }));
  app.use(helmet.xssFilter());
  app.use(helmet.frameguard({ action: "deny" }));
  // HSTS only makes sense over TLS; in production the reverse proxy/enforceHttps
  // path is always https, in dev (http://localhost) it would poison the browser.
  if (env.nodeEnv === "production") {
    app.use(helmet.hsts({ maxAge: 15552000 }));
  }

  // Request ids + ndjson access logs (first middleware, so everything after
  // — including error handlers — can log with the same correlation id).
  app.use(requestContext);

  /* CORS: only allow-listed origins may read responses (preflight included).
     `credentials: true` is what lets the httpOnly kds_token cookie work when
     the frontend and API share a site — and it is also why the allow-list
     must be explicit: browsers forbid `Access-Control-Allow-Origin: *`
     together with credentials, so a wildcard is never an option here.

     Requests with no Origin header (health probes, curl, server-to-server,
     same-origin navigation) are allowed through: they are not cross-origin
     reads, and blocking them would break uptime monitoring. */
  app.use(
    cors({
      origin: (requestOrigin, callback) => {
        if (!requestOrigin) {
          callback(null, true);
          return;
        }
        callback(null, originAllowed(requestOrigin));
      },
      credentials: true,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
      // Cache the preflight so every mutating call doesn't pay for an extra
      // round trip once the browser has learned the policy.
      maxAge: 86_400,
    }),
  );

  // JSON body parsing for mutating requests.
  app.use(express.json({ limit: "1mb" }));

  /* Rate limits. Order matters: the login limiter must be mounted BEFORE
     the general limiter so its failed-attempt-only budget is what applies
     to kds-login (the general limiter would otherwise count successes too,
     punishing a busy kitchen). */
  app.use("/api/v1/auth/kds-login", loginLimiter);
  app.use("/api/v1/auth/admin-login", loginLimiter);
  app.use("/api/v1", apiLimiter);

  // Routes (docs/7-api-contract.md E1–E17; health/ready stay public).
  app.use("/api/v1/health", healthRouter);
  app.use("/api/v1/ready", readyRouter);
  app.use("/api/v1/sessions", sessionsRouter);
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/menu", menuRouter);
  app.use("/api/v1/cart/items", cartRouter);
  app.use("/api/v1/orders", ordersRouter);
  app.use("/api/v1/kds", kdsRouter);
  app.use("/api/v1/floor", floorRouter);
  app.use("/api/v1/admin", adminRouter);

  // Terminal 404, then the central error handler (must stay last).
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
