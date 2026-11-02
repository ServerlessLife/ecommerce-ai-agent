/**
 * Toy JWT auth leg on a Function URL (auth NONE — tokens are the gate):
 *
 *   GET /.well-known/openid-configuration   OIDC discovery
 *   GET /.well-known/jwks.json              public signing key
 *   POST /token                             issue an RS256 JWT
 *
 * The issuer and JWKS URLs derive from the request's own host — no
 * deploy-time config. CORS is platform-injected by the Function URL.
 */

import { AuthService } from '@sample/services';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function baseUrl(event: APIGatewayProxyEventV2): string {
  return `https://${event.requestContext.domainName}`;
}

function parseJsonBody(event: APIGatewayProxyEventV2): Record<string, unknown> {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function queryString(event: APIGatewayProxyEventV2, name: string): string | undefined {
  const value = event.queryStringParameters?.[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const method = event.requestContext.http.method;
  const requestPath = event.rawPath;

  if (method === 'GET' && requestPath === '/.well-known/openid-configuration') {
    // The AgentCore JWT authorizer fetches this to learn the jwks_uri.
    const base = baseUrl(event);
    return json(200, {
      issuer: base,
      token_endpoint: `${base}/token`,
      jwks_uri: `${base}/.well-known/jwks.json`,
      grant_types_supported: ['client_credentials'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'client_id'],
    });
  }

  if (method === 'GET' && (requestPath === '/.well-known/jwks.json' || requestPath === '/jwks')) {
    const { jwk } = await AuthService.getPublicJwk();
    return json(200, { keys: [jwk] });
  }

  if (method === 'POST' && requestPath === '/token') {
    // client_id and subject are identifiers, not credentials.
    const body = parseJsonBody(event);
    const clientId =
      (typeof body.client_id === 'string' && body.client_id) ||
      queryString(event, 'client_id') ||
      process.env.AUTH_CLIENT_ID!;
    const subject =
      (typeof body.subject === 'string' && body.subject) ||
      queryString(event, 'subject') ||
      'sample-user';

    const expiresInSeconds = Number(process.env.TOKEN_EXPIRY_SECONDS);
    const accessToken = await AuthService.createJwt({
      issuer: baseUrl(event),
      clientId,
      subject,
      expiresInSeconds,
    });
    return json(200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Number(process.env.TOKEN_EXPIRY_SECONDS),
    });
  }

  return json(404, { error: 'not_found' });
};
