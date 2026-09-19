/**
 * Strip this service's own routing prefix before Fastify matches a route.
 *
 * The edge routes by path prefix and forwards the path UNCHANGED:
 *   - API Gateway: `ANY /{proxy+}` passes the raw path through
 *   - ALB listener rules (infra/edge.tf): match on `/api/pos/*`, `/pos/*`,
 *     `/api/payments/*`, `/payments/*`
 *
 * Neither hop rewrites. So a service receives `/pos/health`, never `/health`,
 * and every route 404s unless the service strips its own prefix — which is
 * exactly what the JS reference service has always done
 * (`services/_shared/docker/app.js`, the `routePath` line). The TypeScript
 * services never did, so the moment a real image replaced the reference one
 * behind the edge, every public path 404'd while `/ready` kept answering 200
 * to the ALB's own unprefixed health check: healthy target, dead service.
 *
 * ## Why not at the edge
 *
 * API Gateway CAN rewrite with `overwrite:path`, and that was tried (#17) and
 * reverted (#18): the rewrite happens on the integration, BEFORE the VPC Link,
 * so the ALB then sees `/health` instead of `/pos/health`, matches no listener
 * rule, falls through to the `/*` catch-all and lands on `web`. The ALB needs
 * the prefix to route; the service needs it gone. The only place both are true
 * is after the ALB has chosen a target — i.e. in the service itself.
 *
 * ## Why `rewriteUrl` and not an `onRequest` hook
 *
 * Fastify matches the route BEFORE `onRequest` runs, so a hook that rewrites
 * `req.raw.url` rewrites a request whose 404 has already been decided. Only
 * `rewriteUrl` — a server option, applied as the request enters — runs early
 * enough. This is why the helper is a factory for `Fastify()` options rather
 * than a plugin: a plugin could not be registered early enough to work.
 *
 * ## Shape
 *
 * Mirrors the reference app's regex exactly: `^/(?:api/)?<service>(?=/|$)`.
 *   /pos/sales      -> /sales
 *   /api/pos/sales  -> /sales
 *   /pos            -> /
 *   /sales          -> /sales   (unchanged — an unprefixed request still works,
 *                                which keeps the container HEALTHCHECK, local
 *                                runs and the ALB's own health check simple)
 *   /position/x     -> /position/x  (the `(?=/|$)` lookahead: `pos` must be a
 *                                    whole path segment, not a prefix of one)
 */

/**
 * The rule itself. Exported so it can be tested, and reused anywhere that
 * needs the mapping without a server.
 */
export function stripRoutePrefix(pathname: string, serviceName: string): string {
  // Escaped: a service name is ours, not user input, but a regex built from a
  // variable should never be able to carry metacharacters.
  const escaped = serviceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return pathname.replace(new RegExp(`^/(?:api/)?${escaped}(?=/|$)`), '') || '/';
}

/**
 * Build the `rewriteUrl` for a service's Fastify server options:
 *
 *     const app = Fastify({ rewriteUrl: routePrefixRewrite('pos') });
 *
 * Returns the full url (path + query), because `rewriteUrl` replaces `req.url`
 * wholesale — dropping the query string here would silently break every
 * filtered endpoint.
 */
export function routePrefixRewrite(
  serviceName: string,
): (req: { url?: string | undefined }) => string {
  return (req) => {
    const raw = req.url ?? '/';

    // Split the query off before matching so `?` can never be consumed by the
    // pattern, then reattach it verbatim.
    const q = raw.indexOf('?');
    const pathname = q === -1 ? raw : raw.slice(0, q);
    const search = q === -1 ? '' : raw.slice(q);

    return stripRoutePrefix(pathname, serviceName) + search;
  };
}
