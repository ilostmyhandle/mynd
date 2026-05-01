const page = (status: string) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>mynd billing</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #06080f;
      color: #eef0f8;
      font: 15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(420px, calc(100vw - 32px));
      text-align: center;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 16px;
      padding: 28px;
      background: rgba(255,255,255,0.06);
      box-shadow: 0 18px 60px rgba(0,0,0,0.45);
    }
    h1 {
      margin: 0 0 8px;
      font-size: 26px;
      font-weight: 700;
      letter-spacing: 0;
    }
    p {
      margin: 0;
      color: rgba(238,240,248,0.62);
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <main>
    <h1>${status === 'success' ? 'mynd Pro is almost ready' : 'Checkout cancelled'}</h1>
    <p>${status === 'success'
      ? 'You can close this tab and reopen the mynd extension. Stripe may take a few seconds to confirm your subscription.'
      : 'No payment was made. You can close this tab and return to mynd.'}</p>
  </main>
</body>
</html>`;

Deno.serve((request) => {
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'success';

  return new Response(page(status), {
    headers: { 'content-type': 'text/html; charset=utf-8' }
  });
});
