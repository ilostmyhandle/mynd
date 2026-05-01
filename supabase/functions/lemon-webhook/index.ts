import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.105.1';

const ACCESS_STATUSES = new Set(['on_trial', 'active', 'paused', 'past_due', 'unpaid', 'cancelled']);

Deno.serve(async (request) => {
  try {
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed.' }, 405);
    }

    const webhookSecret = Deno.env.get('LEMON_SQUEEZY_WEBHOOK_SECRET');
    if (!webhookSecret) return json({ error: 'Lemon Squeezy webhook is not configured.' }, 500);

    const signature = request.headers.get('x-signature') || '';
    const payload = await request.text();
    const verified = await verifySignature(payload, signature, webhookSecret);

    if (!verified) {
      return json({ error: 'Invalid Lemon Squeezy signature.' }, 400);
    }

    const event = JSON.parse(payload);
    const eventName = event?.meta?.event_name || request.headers.get('x-event-name') || '';

    if (!eventName.startsWith('subscription_')) {
      return json({ received: true, ignored: true });
    }

    const supabase = getSupabaseAdmin();
    await syncSubscription(supabase, event);

    return json({ received: true });
  } catch (error) {
    return json({ error: getErrorMessage(error) }, 500);
  }
});

async function syncSubscription(supabase: any, event: any) {
  const subscription = event?.data || {};
  const attributes = subscription.attributes || {};
  const customData = event?.meta?.custom_data || {};
  const userId = customData.user_id || customData.userId;
  const subscriptionId = String(subscription.id || '');
  const customerId = String(attributes.customer_id || '');
  const orderId = String(attributes.order_id || '');
  const status = String(attributes.status || '');
  const portalUrl = String(attributes.urls?.customer_portal || '');
  const plan = ACCESS_STATUSES.has(status) ? 'pro' : 'free';

  if (userId) {
    const { error: upsertError } = await supabase
      .from('cortex_profiles')
      .upsert({ user_id: userId }, { onConflict: 'user_id', ignoreDuplicates: true });

    if (upsertError) throw upsertError;
  }

  const update = {
    plan,
    billing_provider: 'lemon_squeezy',
    lemon_customer_id: customerId,
    lemon_subscription_id: subscriptionId,
    lemon_order_id: orderId,
    subscription_status: status,
    customer_portal_url: portalUrl,
    updated_at: new Date().toISOString()
  };

  let query = supabase.from('cortex_profiles').update(update);

  if (userId) {
    query = query.eq('user_id', userId);
  } else if (subscriptionId) {
    query = query.eq('lemon_subscription_id', subscriptionId);
  } else if (customerId) {
    query = query.eq('lemon_customer_id', customerId);
  } else {
    return;
  }

  const { error } = await query;
  if (error) throw error;
}

async function verifySignature(payload: string, signature: string, secret: string) {
  if (!signature) return false;
  const expected = await hmacSha256Hex(secret, payload);
  return timingSafeEqual(expected, signature);
}

async function hmacSha256Hex(secret: string, payload: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;

  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return mismatch === 0;
}

function getSupabaseAdmin() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Supabase admin credentials are not configured.');
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function getErrorMessage(error: unknown) {
  if (!error) return 'Unknown error.';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return JSON.stringify(error);
}
