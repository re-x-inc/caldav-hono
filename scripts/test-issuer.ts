// Minimal OIDC test issuer for layer-1 verification: serves a JWKS
// over HTTP and mints RS256 tokens with jose. Not a general IdP:
// no discovery document, no token endpoint. Supports key rotation
// (swap the signing key; JWKS then serves only the new key) and a
// rogue key that is never published (bad-signature checks).

import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";

export const TEST_AUDIENCE = "caldav-hono-test";

export interface SignOptions {
  sub: string;
  issuer?: string;
  audience?: string;
  // Seconds from now; negative values mint an already-expired token.
  expiresInSec?: number;
  // Granted scopes claim; null omits it. Default includes "caldav".
  scope?: string | null;
  // Sign with the unpublished rogue key instead of the current key.
  rogue?: boolean;
  // Extra claims (e.g. an admin role claim for the admin plane checks).
  claims?: Record<string, unknown>;
}

export interface TestIssuer {
  issuer: string;
  jwksUrl: string;
  audience: string;
  sign(opts: SignOptions): Promise<string>;
  rotate(): Promise<void>;
  close(): Promise<void>;
}

interface SigningKey {
  privateKey: CryptoKey;
  jwk: JWK;
  kid: string;
}

async function newSigningKey(): Promise<SigningKey> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const kid = randomUUID();
  const jwk = { ...(await exportJWK(publicKey)), kid, use: "sig", alg: "RS256" };
  return { privateKey, jwk, kid };
}

export async function startTestIssuer(): Promise<TestIssuer> {
  let current = await newSigningKey();
  const rogue = await newSigningKey();

  const server: Server = createServer((req, res) => {
    if (req.url === "/jwks" || req.url === "/.well-known/jwks.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ keys: [current.jwk] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("test issuer did not bind");
  const base = `http://127.0.0.1:${addr.port}`;

  return {
    issuer: `${base}/oidc`,
    jwksUrl: `${base}/jwks`,
    audience: TEST_AUDIENCE,
    async sign(opts) {
      const key = opts.rogue ? rogue : current;
      const now = Math.floor(Date.now() / 1000);
      const claims: Record<string, unknown> = { ...(opts.claims ?? {}) };
      if (opts.scope !== null) claims.scope = opts.scope ?? "openid profile caldav";
      return new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: key.kid })
        .setSubject(opts.sub)
        .setIssuer(opts.issuer ?? `${base}/oidc`)
        .setAudience(opts.audience ?? TEST_AUDIENCE)
        .setIssuedAt(now - 60)
        .setExpirationTime(now + (opts.expiresInSec ?? 300))
        .sign(key.privateKey);
    },
    async rotate() {
      current = await newSigningKey();
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
