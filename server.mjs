import express from 'express';
import crypto from 'crypto';
import 'dotenv/config';

const app = express();
const port = process.env.PORT || 3000;
const accessToken = process.env.SQUARE_ACCESS_TOKEN;
const locationId = 'L864YNVDSF8ZK';
const squareBase = 'https://connect.squareupsandbox.com';
const productionAccessToken = process.env.SQUARE_PRODUCTION_ACCESS_TOKEN;
const productionLocationId = process.env.SQUARE_PRODUCTION_LOCATION_ID;
app.use(express.json());
app.use(express.static('public'));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, environment: 'sandbox', tokenConfigured: Boolean(accessToken) });
});

app.post('/api/payments', async (req, res) => {
  try {
    if (!accessToken) return res.status(500).json({ error: 'SQUARE_ACCESS_TOKEN is not configured on the server.' });
    const { sourceId } = req.body || {};
    if (!sourceId) return res.status(400).json({ error: 'Missing Square payment source token.' });

    const response = await fetch(`${squareBase}/v2/payments`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Square-Version': '2026-08-19'
      },
      body: JSON.stringify({
        source_id: sourceId,
        idempotency_key: crypto.randomUUID(),
        amount_money: { amount: 100, currency: 'USD' },
        
        autocomplete: true,
        note: 'Kona Bros app Sandbox connection test'
      })
    });

    const data = await response.json();
    console.log('Square response status:', response.status);
console.log('Square response:', JSON.stringify(data, null, 2));
console.log('Square location:', locationId);
console.log('Token configured:', Boolean(accessToken));
    if (!response.ok) {
      const detail = data?.errors?.map(e => e.detail || e.code).join('; ') || 'Square payment request failed.';
      return res.status(response.status).json({ error: detail });
    }
    res.json({ ok: true, paymentId: data.payment?.id, status: data.payment?.status, amount: data.payment?.amount_money });
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Unexpected server error.' });
  }
});
app.get('/api/debug-locations', async (req, res) => {
  try {
    const response = await fetch(`${squareBase}/v2/locations`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Square-Version': '2026-08-19',
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();

    res.status(response.status).json({
      status: response.status,
      locations: (data.locations || []).map(location => ({
        id: location.id,
        name: location.name,
        status: location.status,
        capabilities: location.capabilities,
        country: location.country,
        currency: location.currency
      })),
      errors: data.errors || null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.get('/api/catalog-items', async (req, res) => {
  try {
    const response = await fetch(`${squareBase}/v2/catalog/search-catalog-items`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Square-Version': '2026-08-19',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        enabled_location_ids: [locationId],
        limit: 100
      })
    });

    const data = await response.json();

    res.status(response.status).json({
      status: response.status,
      items: data.items || [],
      matched_variation_ids: data.matched_variation_ids || [],
      errors: data.errors || null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.get('/api/production-catalog-items', async (req, res) => {
  try {
    if (!productionAccessToken) {
      return res.status(500).json({
        error: 'SQUARE_PRODUCTION_ACCESS_TOKEN is not configured'
      });
    }

    const response = await fetch(
      'https://connect.squareup.com/v2/catalog/search-catalog-items',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${productionAccessToken}`,
          'Square-Version': '2026-08-19',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          enabled_location_ids: [productionLocationId],
          limit: 100
        })
      }
    );

    const data = await response.json();

    res.status(response.status).json({
      status: response.status,
      items: data.items || [],
      matched_variation_ids: data.matched_variation_ids || [],
      errors: data.errors || null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.listen(port, () => console.log(`Kona Bros Square Sandbox running on http://localhost:${port}`));
