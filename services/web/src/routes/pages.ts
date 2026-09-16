import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { PosClient, PosApiError } from '../posClient.js';
import { decodeJwtPayload } from '../jwt.js';
import {
  errorPage,
  loginPage,
  ownerPage,
  salePage,
  sellPage,
  setupPage,
} from '../views.js';

const COOKIE_NAME = 'tf_token';

export interface PagesRoutesOptions {
  posBaseUrl: string;
}

function clientFor(posBaseUrl: string, token?: string): PosClient {
  return new PosClient({ baseUrl: posBaseUrl, ...(token ? { token } : {}) });
}

export default async function pagesRoutes(app: FastifyInstance, opts: PagesRoutesOptions) {
  const { posBaseUrl } = opts;

  app.get('/', async (request, reply) => {
    const token = request.cookies[COOKIE_NAME];
    const decoded = token ? decodeJwtPayload(token) : null;
    if (!decoded) return reply.redirect('/login');
    return reply.redirect(decoded.role === 'owner' ? '/owner' : '/sell');
  });

  // --- auth -------------------------------------------------------------

  app.get('/login', async (_request, reply) => {
    return reply.type('text/html').send(loginPage());
  });

  app.post<{ Body: { tenantId: string; externalAuthId: string } }>('/login', async (request, reply) => {
    try {
      const client = clientFor(posBaseUrl);
      const { token } = await client.mintDevToken(request.body);
      reply.setCookie(COOKIE_NAME, token, { path: '/', httpOnly: true, sameSite: 'lax' });
      const decoded = decodeJwtPayload(token);
      return reply.redirect(decoded?.role === 'owner' ? '/owner' : '/sell');
    } catch (err) {
      if (err instanceof PosApiError && err.status === 404) {
        return reply.type('text/html').send(loginPage('No user found for that tenant id / auth id.'));
      }
      throw err;
    }
  });

  app.get('/setup', async (_request, reply) => {
    return reply.type('text/html').send(setupPage());
  });

  app.post<{
    Body: { name: string; tillNumber: string; ownerExternalAuthId: string; ownerDisplayName: string };
  }>('/setup', async (request, reply) => {
    const client = clientFor(posBaseUrl);
    const { tenant, owner } = await client.bootstrapTenant(request.body);
    const { token } = await client.mintDevToken({
      tenantId: tenant.id,
      externalAuthId: request.body.ownerExternalAuthId,
    });
    void owner;
    reply.setCookie(COOKIE_NAME, token, { path: '/', httpOnly: true, sameSite: 'lax' });
    return reply.redirect('/owner');
  });

  // --- owner --------------------------------------------------------------

  app.get('/owner', async (request, reply) => {
    const auth = requireRole(request, 'owner');
    if (!auth) return reply.redirect('/login');
    const client = clientFor(posBaseUrl, auth.token);
    const tenant = await client.getTenant(auth.decoded.tenantId);
    return reply.type('text/html').send(ownerPage({ tenant }));
  });

  app.post<{ Body: { displayName: string; externalAuthId: string; msisdn: string } }>(
    '/owner/attendants',
    async (request, reply) => {
      const auth = requireRole(request, 'owner');
      if (!auth) return reply.redirect('/login');
      const client = clientFor(posBaseUrl, auth.token);
      await client.createAttendant(auth.decoded.tenantId, request.body);
      const tenant = await client.getTenant(auth.decoded.tenantId);
      return reply.type('text/html').send(ownerPage({ tenant, message: 'Attendant added.' }));
    },
  );

  app.post<{ Body: { name: string; unitPriceMinor: string } }>('/owner/products', async (request, reply) => {
    const auth = requireRole(request, 'owner');
    if (!auth) return reply.redirect('/login');
    const client = clientFor(posBaseUrl, auth.token);
    const product = await client.createProduct(auth.decoded.tenantId, {
      name: request.body.name,
      unitPriceMinor: Number(request.body.unitPriceMinor),
    });
    const tenant = await client.getTenant(auth.decoded.tenantId);
    return reply
      .type('text/html')
      .send(ownerPage({ tenant, message: `Product added: ${product.name} (id ${product.id}).` }));
  });

  app.post<{ Body: { attendantId?: string; rateBps: string } }>('/owner/rates', async (request, reply) => {
    const auth = requireRole(request, 'owner');
    if (!auth) return reply.redirect('/login');
    const client = clientFor(posBaseUrl, auth.token);
    await client.setCommissionRate(auth.decoded.tenantId, {
      ...(request.body.attendantId ? { attendantId: request.body.attendantId } : {}),
      rateBps: Number(request.body.rateBps),
    });
    const tenant = await client.getTenant(auth.decoded.tenantId);
    return reply.type('text/html').send(ownerPage({ tenant, message: 'Rate set.' }));
  });

  // --- sell (attendant) -----------------------------------------------------

  app.get('/sell', async (request, reply) => {
    const auth = requireAuth(request);
    if (!auth) return reply.redirect('/login');
    return reply.type('text/html').send(sellPage({ tenantId: auth.decoded.tenantId }));
  });

  app.post<{ Body: { attendantId: string; productId: string; quantity: string } }>(
    '/sell',
    async (request, reply) => {
      const auth = requireAuth(request);
      if (!auth) return reply.redirect('/login');
      const client = clientFor(posBaseUrl, auth.token);
      const sale = await client.createSale(
        {
          attendantId: request.body.attendantId,
          items: [{ productId: request.body.productId, quantity: Number(request.body.quantity) }],
        },
        randomUUID(), // one Idempotency-Key per form submission; a page refresh/resubmit reuses the browser's own retry, not this key
      );
      return reply.redirect(`/sell/${sale.id}`);
    },
  );

  app.get<{ Params: { id: string } }>('/sell/:id', async (request, reply) => {
    const auth = requireAuth(request);
    if (!auth) return reply.redirect('/login');
    const client = clientFor(posBaseUrl, auth.token);
    try {
      const sale = await client.getSale(request.params.id);
      return reply.type('text/html').send(salePage(sale));
    } catch (err) {
      if (err instanceof PosApiError && err.status === 404) {
        return reply.code(404).type('text/html').send(errorPage('Sale not found.', 404));
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string }; Body: { customerMsisdn?: string } }>('/sell/:id/pay', async (request, reply) => {
    const auth = requireAuth(request);
    if (!auth) return reply.redirect('/login');
    const customerMsisdn = request.body?.customerMsisdn?.trim();
    if (!customerMsisdn) {
      return reply.code(400).type('text/html').send(errorPage('Customer MSISDN is required for STK Push.', 400));
    }
    const client = clientFor(posBaseUrl, auth.token);
    await client.paySale(request.params.id, customerMsisdn);
    return reply.redirect(`/sell/${request.params.id}`);
  });
}

function requireAuth(request: { cookies: Record<string, string | undefined> }) {
  const token = request.cookies[COOKIE_NAME];
  if (!token) return null;
  const decoded = decodeJwtPayload(token);
  if (!decoded) return null;
  return { token, decoded };
}

function requireRole(request: { cookies: Record<string, string | undefined> }, role: 'owner' | 'attendant') {
  const auth = requireAuth(request);
  if (!auth || auth.decoded.role !== role) return null;
  return auth;
}
