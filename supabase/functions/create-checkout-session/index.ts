import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.105.1';

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS'
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed.' }, 405);
    }

    const lemonKey = Deno.env.get('LEMON_SQUEEZY_API_KEY');
    const storeId = Deno.env.get('LEMON_SQUEEZY_STORE_ID');
    const variantId = Deno.env.get('LEMON_SQUEEZY_VARIANT_ID');

    if (!lemonKey || !storeId || !variantId) {
      return json({ error: 'Lemon Squeezy is not configured.' }, 500);
    }

    const token = getBearerToken(request);
    if (!token) return json({ error: 'Authentication required.' }, 401);

    const supabase = getSupabaseAdmin();
    const { data: userResult, error: userError } = await supabase.auth.getUser(token);
    const user = userResult?.user;

    if (userError || !user?.id) {
      return json({ error: 'Authentication required.' }, 401);
    }

    const { error: upsertError } = await supabase
      .from('cortex_profiles')
      .upsert({ user_id: user.id }, { onConflict: 'user_id', ignoreDuplicates: true });

    if (upsertError) throw upsertError;

    const { data: profile, error: profileError } = await supabase
      .from('cortex_profiles')
      .select('plan')
      .eq('user_id', user.id)
      .maybeSingle();

    if (profileError) throw profileError;

    if (profile?.plan === 'pro') {
      return json({ error: 'You are already on mynd Pro.' }, 400);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const successUrl = `${supabaseUrl}/functions/v1/billing-return?status=success&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${supabaseUrl}/functions/v1/billing-return?status=cancel`;

    const checkout = await createLemonCheckout(lemonKey, {
      storeId,
      variantId,
      userId: user.id,
      email: user.email || '',
      redirectUrl: successUrl,
      cancelUrl
    });

    const checkoutUrl = checkout?.data?.attributes?.url;

    if (!checkoutUrl) {
      return json({ error: 'Lemon Squeezy did not return a checkout URL.' }, 502);
    }

    return json({ url: checkoutUrl });
  } catch (error) {
    return json({ error: getErrorMessage(error) }, 500);
  }
});

async function createLemonCheckout(
  apiKey: string,
  input: {
    storeId: string;
    variantId: string;
    userId: string;
    email: string;
    redirectUrl: string;
    cancelUrl: string;
  }
) {
  const testMode = (Deno.env.get('LEMON_SQUEEZY_TEST_MODE') || '').toLowerCase() === 'true';
  const response = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
    method: 'POST',
    headers: {
      accept: 'application/vnd.api+json',
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/vnd.api+json'
    },
    body: JSON.stringify({
      data: {
        type: 'checkouts',
        attributes: {
          test_mode: testMode,
          product_options: {
            redirect_url: input.redirectUrl,
            receipt_button_text: 'Return to mynd',
            receipt_link_url: input.redirectUrl,
            enabled_variants: [Number(input.variantId)]
          },
          checkout_options: {
            embed: false,
            media: false,
            logo: true,
            discount: true,
            subscription_preview: true,
            button_color: '#ffffff',
            button_text_color: '#06080f'
          },
          checkout_data: {
            email: input.email,
            custom: {
              user_id: input.userId
            }
          }
        },
        relationships: {
          store: {
            data: {
              type: 'stores',
              id: input.storeId
            }
          },
          variant: {
            data: {
              type: 'variants',
              id: input.variantId
            }
          }
        }
      }
    })
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message || `${response.status} ${response.statusText}`);
  }

  return payload;
}

function getBearerToken(request: Request) {
  const authHeader = request.headers.get('authorization') || '';
  const match = authHeader.match(/^bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
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
    headers: {
      ...corsHeaders,
      'content-type': 'application/json'
    }
  });
}

function getErrorMessage(error: unknown) {
  if (!error) return 'Unknown error.';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return JSON.stringify(error);
}
