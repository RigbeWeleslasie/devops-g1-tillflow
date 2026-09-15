/**
 * Thin client for the POS API. The web shell has no database of its own —
 * every piece of state it shows comes from here (or, once Nebyat's track
 * lands, the Payments API).
 */
export interface PosClientOptions {
  baseUrl: string;
  token?: string;
}

export class PosApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`POS API responded ${status}`);
  }
}

export class PosClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;

  constructor(opts: PosClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    // Only set content-type when there's actually a body: Fastify's default
    // JSON parser rejects a request that declares application/json but has
    // an empty body (400) -- exactly what a bodyless POST like paySale()
    // sends, since it has nothing to say beyond the URL.
    const headers: Record<string, string> = { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extraHeaders };
    if (this.token) headers['authorization'] = `Bearer ${this.token}`;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const responseBody = await res.json().catch(() => undefined);
    if (!res.ok) {
      throw new PosApiError(res.status, responseBody);
    }
    return responseBody as T;
  }

  bootstrapTenant(input: {
    name: string;
    tillNumber: string;
    ownerExternalAuthId: string;
    ownerDisplayName: string;
  }) {
    return this.request<{ tenant: { id: string; name: string }; owner: { id: string; role: string } }>(
      'POST',
      '/tenants',
      input,
    );
  }

  mintDevToken(input: { tenantId: string; externalAuthId: string }) {
    return this.request<{ token: string }>('POST', '/dev/tokens', input);
  }

  getTenant(tenantId: string) {
    return this.request<{ id: string; name: string; tillNumber: string }>('GET', `/tenants/${tenantId}`);
  }

  createAttendant(tenantId: string, input: { externalAuthId: string; displayName: string; msisdn: string }) {
    return this.request('POST', `/tenants/${tenantId}/attendants`, input);
  }

  createProduct(tenantId: string, input: { name: string; unitPriceMinor: number }) {
    return this.request<{ id: string; name: string; unitPriceMinor: number }>(
      'POST',
      `/tenants/${tenantId}/products`,
      input,
    );
  }

  setCommissionRate(tenantId: string, input: { attendantId?: string; rateBps: number }) {
    return this.request('POST', `/tenants/${tenantId}/rates`, input);
  }

  createSale(
    input: { attendantId: string; items: Array<{ productId: string; quantity: number }> },
    idempotencyKey: string,
  ) {
    return this.request<{ id: string; status: string; totalMinor: number }>('POST', '/sales', input, {
      'idempotency-key': idempotencyKey,
    });
  }

  getSale(saleId: string) {
    return this.request<{ id: string; status: string; totalMinor: number; chargeId: string | null }>(
      'GET',
      `/sales/${saleId}`,
    );
  }

  paySale(saleId: string) {
    return this.request<{ sale: unknown; charge: { status: string; chargeId: string | null } }>(
      'POST',
      `/sales/${saleId}/pay`,
    );
  }
}
