import express from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

const PORT = process.env.PORT || 10000;
const SQUARE_VERSION = '2026-08-19';

const PROD_TOKEN = process.env.SQUARE_PRODUCTION_ACCESS_TOKEN || '';
const PROD_LOCATION_ID = process.env.SQUARE_PRODUCTION_LOCATION_ID || 'LJZAKNVCETN4E';
const PROD_APPLICATION_ID = process.env.SQUARE_PRODUCTION_APPLICATION_ID || 'sq0idp-CKjH2XcbvR1h02Lw5gljFA';
const PAYMENTS_ENABLED = String(process.env.SQUARE_PAYMENTS_ENABLED || 'false').toLowerCase() === 'true';
const ORDERS_ENABLED = String(process.env.ONLINE_ORDERS_ENABLED || 'true').toLowerCase() === 'true';

const SANDBOX_TOKEN = process.env.SQUARE_ACCESS_TOKEN || '';
const SANDBOX_LOCATION_ID = process.env.SQUARE_LOCATION_ID || 'L864YNVDSF8ZK';

const PROD_BASE = 'https://connect.squareup.com';
const SANDBOX_BASE = 'https://connect.squareupsandbox.com';

function squareHeaders(token){
  return {
    'Square-Version': SQUARE_VERSION,
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
}
function asError(data, fallback='Square request failed'){
  return data?.errors?.map(e=>e.detail||e.code).filter(Boolean).join('; ') || fallback;
}
async function squareFetch(base, path, token, options={}){
  const r = await fetch(base + path, {
    ...options,
    headers: { ...squareHeaders(token), ...(options.headers||{}) }
  });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`Square returned a non-JSON response (${r.status})`); }
  if(!r.ok) throw new Error(asError(data, `Square request failed (${r.status})`));
  return data;
}

function moneyAmount(obj){ return Number(obj?.amount || 0); }

function locationMoney(data, locationId){
  const o = (data?.location_overrides || []).find(x=>x.location_id===locationId && x.price_money);
  return o?.price_money || data?.price_money || null;
}
function presentAtLocation(obj, locationId){
  if(obj?.present_at_all_locations === true) return !(obj?.absent_at_location_ids||[]).includes(locationId);
  const present = obj?.present_at_location_ids || [];
  return present.length ? present.includes(locationId) : true;
}

async function searchAllItems(){
  if(!PROD_TOKEN) throw new Error('SQUARE_PRODUCTION_ACCESS_TOKEN is not configured');
  let cursor;
  const items=[];
  do{
    const body = { enabled_location_ids:[PROD_LOCATION_ID], limit:100, sort_order:'ASC' };
    if(cursor) body.cursor=cursor;
    const data = await squareFetch(PROD_BASE, '/v2/catalog/search-catalog-items', PROD_TOKEN, {
      method:'POST', body:JSON.stringify(body)
    });
    items.push(...(data.items||[]));
    cursor=data.cursor;
  }while(cursor);
  return items;
}

async function retrieveCatalogObjects(ids){
  const unique=[...new Set(ids.filter(Boolean))];
  const all=[];
  for(let i=0;i<unique.length;i+=500){
    const chunk=unique.slice(i,i+500);
    const data=await squareFetch(PROD_BASE, '/v2/catalog/batch-retrieve', PROD_TOKEN, {
      method:'POST',
      body:JSON.stringify({ object_ids:chunk, include_related_objects:true })
    });
    all.push(...(data.objects||[]), ...(data.related_objects||[]));
  }
  return all;
}

function normalizeMenu(items, related){
  const byId=new Map(related.map(o=>[o.id,o]));
  return items
    .filter(item=>presentAtLocation(item,PROD_LOCATION_ID))
    .map(item=>{
      const d=item.item_data||{};
      const variations=(d.variations||[])
        .filter(v=>presentAtLocation(v,PROD_LOCATION_ID))
        .map(v=>{
          const vd=v.item_variation_data||{};
          const pm=locationMoney(vd,PROD_LOCATION_ID);
          return {
            id:v.id,
            name:vd.name||'Regular',
            priceCents:moneyAmount(pm),
            price:pm ? `$${(moneyAmount(pm)/100).toFixed(2)}` : null,
            imageIds:vd.image_ids||[]
          };
        });

      const imageIds=[...(d.image_ids||[]), ...variations.flatMap(v=>v.imageIds||[])];
      const imageObj=imageIds.map(id=>byId.get(id)).find(x=>x?.type==='IMAGE' && x?.image_data?.url);
      const modifierLists=(d.modifier_list_info||[]).map(info=>{
        const list=byId.get(info.modifier_list_id);
        if(!list || list.type!=='MODIFIER_LIST') return null;
        const ld=list.modifier_list_data||{};
        if(info.hidden_from_customer_override==='YES' || info.hidden_from_customer_override===true) return null;
        const overrides=new Map((info.modifier_overrides||[]).map(o=>[o.modifier_id,o]));
        let min=Number(info.min_selected_modifiers);
        let max=Number(info.max_selected_modifiers);
        if(!Number.isFinite(min) || min<0) min=Number(ld.min_selected_modifiers||0);
        if(!Number.isFinite(max) || max<0) max=Number(ld.max_selected_modifiers||0);
        if((!max || max<1) && ld.selection_type==='SINGLE') max=1;
        return {
          id:list.id,
          name:ld.name||'Options',
          selectionType:ld.selection_type||'MULTIPLE',
          minSelected:min||0,
          maxSelected:max||0,
          modifiers:(ld.modifiers||[])
            .filter(m=>presentAtLocation(m,PROD_LOCATION_ID))
            .map(m=>{
              const md=m.modifier_data||{};
              const override=overrides.get(m.id)||{};
              const pm=locationMoney(md,PROD_LOCATION_ID);
              return {
                id:m.id,
                name:md.name||'Option',
                priceCents:moneyAmount(pm),
                onByDefault:override.on_by_default ?? md.on_by_default ?? false
              };
            })
        };
      }).filter(Boolean);

      return {
        id:item.id,
        name:d.name||'Item',
        description:d.description||'',
        variations,
        imageUrl:imageObj?.image_data?.url||'',
        imageIds,
        modifierLists,
        productType:d.product_type||''
      };
    })
    .filter(i=>i.variations.length);
}

let menuCache={ at:0, items:[] };
async function getMenu(force=false){
  const fresh = Date.now()-menuCache.at < 3*60*1000;
  if(!force && fresh && menuCache.items.length) return menuCache.items;
  const rawItems=await searchAllItems();
  const relatedIds=[];
  for(const item of rawItems){
    const d=item.item_data||{};
    relatedIds.push(...(d.image_ids||[]));
    for(const v of d.variations||[]) relatedIds.push(...(v.item_variation_data?.image_ids||[]));
    for(const info of d.modifier_list_info||[]) relatedIds.push(info.modifier_list_id);
  }
  const related=relatedIds.length ? await retrieveCatalogObjects(relatedIds) : [];
  const normalized=normalizeMenu(rawItems,related);
  menuCache={at:Date.now(),items:normalized};
  return normalized;
}

app.get('/api/config',(req,res)=>{
  res.json({
    environment:'production',
    locationId:PROD_LOCATION_ID,
    applicationId:PROD_APPLICATION_ID,
    paymentsEnabled:PAYMENTS_ENABLED,
    ordersEnabled:ORDERS_ENABLED
  });
});

app.get('/api/menu', async (req,res)=>{
  try { res.json({items:await getMenu(req.query.refresh==='1')}); }
  catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/api/production-catalog-items', async (req,res)=>{
  try { res.json({items:await getMenu(req.query.refresh==='1')}); }
  catch(e){ res.status(500).json({error:e.message}); }
});

function normalizePhone(phone){
  const s=String(phone||'').trim();
  if(!s) return '';
  const digits=s.replace(/\D/g,'');
  if(digits.length===10) return '+1'+digits;
  if(digits.length===11 && digits.startsWith('1')) return '+'+digits;
  return s.slice(0,17);
}
async function validateCheckoutPayload(body){
  const menu=await getMenu();
  const itemsById=new Map(menu.map(i=>[i.id,i]));
  const lineItems=[];
  let estimatedSubtotal=0;

  if(!body?.items?.length) throw new Error('Your cart is empty');
  const customerName=String(body?.customer?.name||'').trim();
  const customerPhone=normalizePhone(body?.customer?.phone);
  if(!customerName) throw new Error('Pickup name is required');
  if(!customerPhone) throw new Error('Phone number is required');

  for(const row of body.items){
    const item=itemsById.get(row.itemId);
    if(!item) throw new Error('One item is no longer available');
    const variation=item.variations.find(v=>v.id===row.variationId);
    if(!variation) throw new Error(`${item.name}: selected size is no longer available`);

    const allowedMods=new Map();
    for(const list of item.modifierLists||[]){
      for(const m of list.modifiers||[]) allowedMods.set(m.id,{...m,list});
    }
    const selected=(row.modifierIds||[]).map(id=>{
      const found=allowedMods.get(id);
      if(!found) throw new Error(`${item.name}: one selected modifier is no longer available`);
      return found;
    });

    for(const list of item.modifierLists||[]){
      const count=selected.filter(m=>m.list.id===list.id).length;
      if(count<(list.minSelected||0)) throw new Error(`${item.name}: please choose ${list.name}`);
      if((list.maxSelected||0)>0 && count>list.maxSelected) throw new Error(`${item.name}: too many selections for ${list.name}`);
    }

    const mods=selected.map(m=>({catalog_object_id:m.id,quantity:'1'}));
    estimatedSubtotal += Number(variation.priceCents||0) + selected.reduce((s,m)=>s+Number(m.priceCents||0),0);

    const line={
      quantity:String(Math.max(1,Number(row.quantity)||1)),
      catalog_object_id:variation.id
    };
    if(mods.length) line.modifiers=mods;
    const note=String(row.notes||'').trim();
    if(note) line.note=note.slice(0,500);
    lineItems.push(line);
  }

  return {lineItems,customerName,customerPhone,estimatedSubtotal};
}

app.post('/api/checkout/validate', async (req,res)=>{
  if(!ORDERS_ENABLED) return res.status(503).json({error:'Online ordering is temporarily paused',ordersEnabled:false});
  try{
    const v=await validateCheckoutPayload(req.body);
    res.json({ok:true,totalCents:v.estimatedSubtotal,paymentsEnabled:PAYMENTS_ENABLED,
    ordersEnabled:ORDERS_ENABLED});
  }catch(e){res.status(400).json({error:e.message});}
});

function pickupDetails(body,name,phone){
  const raw=String(body.pickupTime||'ASAP');
  if(raw==='ASAP'){
    return {
      schedule_type:'ASAP',
      prep_time_duration:'PT15M',
      recipient:{display_name:name,phone_number:phone}
    };
  }
  const mins=Math.max(15,Math.min(240,Number(raw)||15));
  return {
    schedule_type:'SCHEDULED',
    pickup_at:new Date(Date.now()+mins*60*1000).toISOString(),
    prep_time_duration:'PT15M',
    recipient:{display_name:name,phone_number:phone}
  };
}

app.post('/api/checkout/pay', async (req,res)=>{
  if(!ORDERS_ENABLED) return res.status(503).json({error:'Online ordering is temporarily paused'});
  if(!PAYMENTS_ENABLED) return res.status(403).json({error:'Live payments are still disabled for testing'});
  if(!PROD_TOKEN) return res.status(500).json({error:'Production Square token is not configured'});
  try{
    const sourceId=String(req.body?.sourceId||'');
    if(!sourceId) throw new Error('Payment token is missing');
    const v=await validateCheckoutPayload(req.body);

    const orderData=await squareFetch(PROD_BASE, '/v2/orders', PROD_TOKEN, {
      method:'POST',
      body:JSON.stringify({
        idempotency_key:crypto.randomUUID(),
        order:{
          location_id:PROD_LOCATION_ID,
          reference_id:`KONA-WEB-${Date.now()}`,
          source:{name:'Kona Bros Online Pickup'},
          line_items:v.lineItems,
          pricing_options:{auto_apply_taxes:true,auto_apply_discounts:true},
          fulfillments:[{
            type:'PICKUP',
            state:'PROPOSED',
            pickup_details:pickupDetails(req.body,v.customerName,v.customerPhone)
          }]
        }
      })
    });

    const order=orderData.order;
    const amount=Number(order?.total_money?.amount||0);
    if(!order?.id || amount<=0) throw new Error('Square did not return a payable order total');

    const paymentData=await squareFetch(PROD_BASE, '/v2/payments', PROD_TOKEN, {
      method:'POST',
      body:JSON.stringify({
        source_id:sourceId,
        idempotency_key:crypto.randomUUID(),
        amount_money:{amount,currency:order.total_money?.currency||'USD'},
        order_id:order.id,
        location_id:PROD_LOCATION_ID,
        autocomplete:true,
        buyer_email_address:req.body?.customer?.email || undefined,
        note:`Kona Bros pickup - ${v.customerName}`
      })
    });

    res.json({
      ok:true,
      orderId:order.id,
      paymentId:paymentData.payment?.id,
      status:paymentData.payment?.status,
      amountCents:amount
    });
  }catch(e){
    res.status(400).json({error:e.message});
  }
});

// Keep the old sandbox payment test endpoint available.
app.post('/api/payments', async (req,res)=>{
  if(!SANDBOX_TOKEN) return res.status(500).json({error:'SQUARE_ACCESS_TOKEN is not configured'});
  try{
    const {sourceId,amount=100}=req.body||{};
    const data=await squareFetch(SANDBOX_BASE, '/v2/payments', SANDBOX_TOKEN, {
      method:'POST',
      body:JSON.stringify({
        source_id:sourceId,
        idempotency_key:crypto.randomUUID(),
        amount_money:{amount:Number(amount),currency:'USD'},
        location_id:SANDBOX_LOCATION_ID,
        autocomplete:true
      })
    });
    res.json(data);
  }catch(e){res.status(400).json({error:e.message});}
});

app.get('/health',(req,res)=>res.json({ok:true}));
app.listen(PORT,()=>console.log(`Kona Bros server running on port ${PORT}`));
