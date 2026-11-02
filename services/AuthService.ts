/**
 * JWT auth: mints RS256 access tokens via the KMS RSA key (the private half
 * never leaves KMS — signatures via `kms:Sign`), exposes the public half as
 * a JWKS entry (fetched once, cached; the key id doubles as the `kid`), and
 * verifies issued tokens with `jose` for backends that validate themselves.
 */

import { createPublicKey } from 'node:crypto';
import { GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { createRemoteJWKSet, exportJWK, type JWK, jwtVerify } from 'jose';

export type PublicJwk = {
  keyId: string;
  jwk: JWK;
};

let cachedJwk: Promise<PublicJwk> | undefined;
const kms = new KMSClient();

/** The public half of the signing key as a JWK (`kid` included). */
async function getPublicJwk(): Promise<PublicJwk> {
  cachedJwk ??= (async () => {
    const out = await kms.send(new GetPublicKeyCommand({ KeyId: process.env.JWT_KEY_ARN }));
    if (!out.KeyId || !out.PublicKey) {
      throw new Error('KMS GetPublicKey returned no key id or public key material');
    }
    const publicKey = createPublicKey({
      key: new Uint8Array(out.PublicKey),
      format: 'der',
      type: 'spki',
    });
    const jwk = await exportJWK(publicKey);
    return { keyId: out.KeyId, jwk: { ...jwk, kid: out.KeyId, use: 'sig', alg: 'RS256' } };
  })();
  return cachedJwk;
}

/**
 * Mint an RS256 access token — minimal claims, signed via `kms:Sign`
 * (KMS SHA-256-hashes the message, which is exactly an RS256 signature).
 */
async function createJwt(params: {
  issuer: string;
  clientId: string;
  subject: string;
  expiresInSeconds: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const { keyId } = await getPublicJwk();
  const header = { alg: 'RS256', typ: 'JWT', kid: keyId };
  const payload = {
    iss: params.issuer,
    sub: params.subject,
    aud: params.clientId,
    client_id: params.clientId,
    exp: now + params.expiresInSeconds,
    iat: now,
    nbf: now,
    jti: crypto.randomUUID(),
    token_use: 'access',
    scope: 'openid chat',
  };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');

  const out = await kms.send(
    new SignCommand({
      KeyId: process.env.JWT_KEY_ARN,
      Message: Buffer.from(`${headerB64}.${payloadB64}`),
      MessageType: 'RAW',
      SigningAlgorithm: 'RSASSA_PKCS1_V1_5_SHA_256',
    }),
  );
  if (!out.Signature) {
    throw new Error('KMS Sign returned no signature');
  }
  return `${headerB64}.${payloadB64}.${Buffer.from(out.Signature).toString('base64url')}`;
}

// Token verification — for backends that validate tokens themselves (the
// AgentCore Runtime delegates to its integrated JWT authorizer instead).

export type VerifyOptions = {
  /** The auth service's JWKS URL (`…/.well-known/jwks.json`). */
  jwksUrl: string;
  /** The audience (`aud`) the token must carry. */
  audience: string;
};

export type VerifyResult = { valid: true } | { valid: false; reason: string };

let jwksSet: ReturnType<typeof createRemoteJWKSet> | undefined;

/** Verify RS256 signature, expiry and audience; the JWKS is fetched once and refetched on an unknown `kid`. */
async function verifyJwt(token: string, opts: VerifyOptions): Promise<VerifyResult> {
  jwksSet ??= createRemoteJWKSet(new URL(opts.jwksUrl));
  try {
    await jwtVerify(token, jwksSet, { algorithms: ['RS256'], audience: opts.audience });
    return { valid: true };
  } catch (error) {
    return { valid: false, reason: (error as { code?: string }).code ?? String(error) };
  }
}

export const AuthService = {
  createJwt,
  getPublicJwk,
  verifyJwt,
} as const;
