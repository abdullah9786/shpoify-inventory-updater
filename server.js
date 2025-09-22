require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
app.use(express.json());

// Configuration from environment variables
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// Webhook verification middleware
const verifyWebhook = (req, res, next) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const body = JSON.stringify(req.body);
  const hash = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(body, 'utf8')
    .digest('base64');

  if (hash !== hmac) {
    console.log('❌ Unauthorized webhook request');
    return res.status(401).send('Unauthorized');
  }
  
  console.log('✅ Webhook verified successfully');
  next();
};

// Main function to update inventory for an order
async function updateInventoryForOrder(order) {
  console.log(`📦 Processing order ${order.id} with ${order.line_items.length} items`);
  
  for (const lineItem of order.line_items) {
    try {
      await updateInventoryForVariant(lineItem.variant_id, -lineItem.quantity);
      console.log(`✅ Updated inventory for variant ${lineItem.variant_id}: -${lineItem.quantity}`);
    } catch (error) {
      console.error(`❌ Failed to update inventory for variant ${lineItem.variant_id}:`, error.message);
    }
  }
}

// Function to update inventory for a specific variant
async function updateInventoryForVariant(variantId, adjustment) {
  try {
    // Step 1: Get variant details to find inventory item ID
    const variantResponse = await shopifyAPI(`/admin/api/2023-10/variants/${variantId}.json`);
    const inventoryItemId = variantResponse.data.variant.inventory_item_id;
    
    // Step 2: Get inventory levels for this item
    const inventoryResponse = await shopifyAPI(
      `/admin/api/2023-10/inventory_levels.json?inventory_item_ids=${inventoryItemId}`
    );
    
    if (inventoryResponse.data.inventory_levels.length === 0) {
      throw new Error(`No inventory levels found for variant ${variantId}`);
    }
    
    // Step 3: Get the location ID (using first location)
    const inventoryLevel = inventoryResponse.data.inventory_levels[0];
    const locationId = inventoryLevel.location_id;
    
    console.log(`📊 Current inventory for variant ${variantId}: ${inventoryLevel.available}`);
    
    // Step 4: Adjust the inventory
    await shopifyAPI('/admin/api/2023-10/inventory_levels/adjust.json', 'POST', {
      location_id: locationId,
      inventory_item_id: inventoryItemId,
      available_adjustment: adjustment
    });
    
    console.log(`📈 Inventory adjusted by ${adjustment} for variant ${variantId}`);
    
  } catch (error) {
    throw new Error(`Inventory update failed: ${error.message}`);
  }
}

// Shopify API helper function
async function shopifyAPI(endpoint, method = 'GET', data = null) {
  const config = {
    method,
    url: `https://${SHOPIFY_SHOP_DOMAIN}${endpoint}`,
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
      'Content-Type': 'application/json'
    }
  };
  
  if (data) {
    config.data = data;
  }
  
  try {
    const response = await axios(config);
    return response;
  } catch (error) {
    if (error.response) {
      throw new Error(`Shopify API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

// Webhook handler for order creation
app.post('/webhooks/order-created', verifyWebhook, async (req, res) => {
  try {
    const order = req.body;
    console.log(`\n🛍️ New order received: ${order.id}`);
    console.log(`Order number: ${order.order_number || order.name}`);
    
    // Update inventory for this order
    await updateInventoryForOrder(order);
    
    console.log(`✅ Order ${order.id} processed successfully\n`);
    res.status(200).send('OK');
    
  } catch (error) {
    console.error(`❌ Error processing order:`, error.message);
    res.status(500).send('Internal Server Error');
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy', 
    service: 'Shopify Inventory Updater',
    timestamp: new Date().toISOString()
  });
});

// Test endpoint to verify Shopify connection
app.get('/test-connection', async (req, res) => {
  try {
    const response = await shopifyAPI('/admin/api/2023-10/shop.json');
    res.status(200).json({
      status: 'connected',
      shop: response.data.shop.name,
      domain: response.data.shop.domain
    });
  } catch (error) {
    res.status(500).json({
      status: 'failed',
      error: error.message
    });
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Shopify Inventory Updater running on port ${PORT}`);
  console.log(`📡 Webhook endpoint: http://localhost:${PORT}/webhooks/order-created`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  console.log(`🔗 Test connection: http://localhost:${PORT}/test-connection`);
});

module.exports = app;