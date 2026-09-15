/**
 * Server-rendered HTML — plain template strings, no client framework and no
 * templating dependency. Deliberately minimal: this proves the shell's
 * proxy/session plumbing works end to end, not a design system.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)} — TillFlow</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
    label { display: block; margin-top: 0.75rem; font-weight: 600; }
    input, select { display: block; width: 100%; padding: 0.4rem; margin-top: 0.25rem; box-sizing: border-box; }
    button { margin-top: 1rem; padding: 0.5rem 1rem; cursor: pointer; }
    .status { padding: 0.5rem; border-radius: 4px; margin: 1rem 0; }
    .status-UNPAID { background: #fff3cd; }
    .status-PAID { background: #d4edda; }
    .status-VOID { background: #f8d7da; }
    nav a { margin-right: 1rem; }
    .error { color: #b00020; }
    table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
    td, th { border: 1px solid #ddd; padding: 0.4rem; text-align: left; }
  </style>
</head>
<body>
  <nav><a href="/">TillFlow</a> <a href="/login">Switch user</a></nav>
  <h1>${escapeHtml(title)}</h1>
  ${body}
</body>
</html>`;
}

export function loginPage(error?: string): string {
  return layout(
    'Sign in',
    `
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    <form method="post" action="/login">
      <label>Tenant ID <input name="tenantId" required></label>
      <label>Your auth id <input name="externalAuthId" required placeholder="e.g. owner-auth-id"></label>
      <button type="submit">Sign in</button>
    </form>
    <p>Don't have a tenant yet? <a href="/setup">Set one up</a>.</p>
  `,
  );
}

export function setupPage(error?: string): string {
  return layout(
    'Set up your till',
    `
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    <form method="post" action="/setup">
      <label>Shop name <input name="name" required></label>
      <label>Till number <input name="tillNumber" required></label>
      <label>Your name <input name="ownerDisplayName" required></label>
      <label>Your auth id <input name="ownerExternalAuthId" required placeholder="pick something memorable"></label>
      <button type="submit">Create tenant</button>
    </form>
  `,
  );
}

export function ownerPage(opts: {
  tenant: { id: string; name: string; tillNumber: string };
  message?: string;
}): string {
  return layout(
    `${opts.tenant.name} — owner`,
    `
    ${opts.message ? `<p>${escapeHtml(opts.message)}</p>` : ''}
    <p>Tenant id: <code>${escapeHtml(opts.tenant.id)}</code> — till <code>${escapeHtml(opts.tenant.tillNumber)}</code></p>

    <h2>Add an attendant</h2>
    <form method="post" action="/owner/attendants">
      <label>Display name <input name="displayName" required></label>
      <label>Auth id <input name="externalAuthId" required></label>
      <label>MSISDN (payout number) <input name="msisdn" required placeholder="2547XXXXXXXX"></label>
      <button type="submit">Add attendant</button>
    </form>

    <h2>Add a product</h2>
    <form method="post" action="/owner/products">
      <label>Name <input name="name" required></label>
      <label>Price (minor units, e.g. 25000 = KES 250.00) <input name="unitPriceMinor" type="number" min="0" required></label>
      <button type="submit">Add product</button>
    </form>

    <h2>Set a commission rate</h2>
    <form method="post" action="/owner/rates">
      <label>Attendant id (blank = tenant default) <input name="attendantId"></label>
      <label>Rate in basis points (500 = 5%) <input name="rateBps" type="number" min="0" max="10000" required></label>
      <button type="submit">Set rate</button>
    </form>
  `,
  );
}

export function sellPage(opts: { tenantId: string; message?: string }): string {
  return layout(
    'Record a sale',
    `
    ${opts.message ? `<p>${escapeHtml(opts.message)}</p>` : ''}
    <form method="post" action="/sell">
      <label>Attendant id <input name="attendantId" required></label>
      <label>Product id <input name="productId" required></label>
      <label>Quantity <input name="quantity" type="number" min="1" value="1" required></label>
      <button type="submit">Create sale</button>
    </form>
  `,
  );
}

export function salePage(sale: {
  id: string;
  status: string;
  totalMinor: number;
  chargeId: string | null;
}): string {
  return layout(
    'Sale',
    `
    <div class="status status-${escapeHtml(sale.status)}">Status: <strong>${escapeHtml(sale.status)}</strong></div>
    <p>Sale id: <code>${escapeHtml(sale.id)}</code></p>
    <p>Total (minor units): ${sale.totalMinor}</p>
    <p>Charge id: ${sale.chargeId ? escapeHtml(sale.chargeId) : '—'}</p>
    ${
      sale.status === 'UNPAID'
        ? `<form method="post" action="/sell/${escapeHtml(sale.id)}/pay"><button type="submit">Pay via M-Pesa</button></form>`
        : ''
    }
    <p><a href="/sell/${escapeHtml(sale.id)}">Refresh</a> — the sale flips to PAID asynchronously once the
    sale.paid event is consumed, so refresh after paying to see it settle.</p>
  `,
  );
}

export function errorPage(message: string, status: number): string {
  return layout('Error', `<p class="error">${escapeHtml(message)} (${status})</p>`);
}
