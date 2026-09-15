/**
 * Decode (NOT verify) a JWT payload — used only to decide which page to
 * redirect to. This is never a security boundary: every actual API call
 * still carries the raw token to POS, which verifies it with the real
 * secret. A tampered cookie just gets redirected to the wrong page and then
 * rejected by POS with a 401 on the first real request.
 */
export interface DecodedToken {
  sub: string;
  tenantId: string;
  role: 'owner' | 'attendant';
}

export function decodeJwtPayload(token: string): DecodedToken | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(json) as Partial<DecodedToken>;
    if (typeof payload.sub !== 'string' || typeof payload.tenantId !== 'string') return null;
    if (payload.role !== 'owner' && payload.role !== 'attendant') return null;
    return { sub: payload.sub, tenantId: payload.tenantId, role: payload.role };
  } catch {
    return null;
  }
}
