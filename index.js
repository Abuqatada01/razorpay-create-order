// index.js (create-order) - Node 16+
// Stores items as array of product IDs (strings) and full snapshot in items_json (text)
// Exits with JSON printed to console so Appwrite returns responseBody for client polling.

require('dotenv').config();
const Razorpay = require('razorpay');
const { Client, Databases, ID } = require('node-appwrite');

(async function main() {
    try {
        // Parse payload from APPWRITE_FUNCTION_DATA
        let payload = {};
        try {
            payload = process.env.APPWRITE_FUNCTION_DATA ? JSON.parse(process.env.APPWRITE_FUNCTION_DATA) : {};
        } catch (e) {
            console.error('Failed to parse APPWRITE_FUNCTION_DATA', e);
            console.log(JSON.stringify({ success: false, message: 'invalid function data' }));
            process.exit(1);
        }

        const { amount, currency = 'INR', receipt, userId, items } = payload;

        if (!amount || !userId) {
            console.error('Missing required fields', { amount, userId });
            console.log(JSON.stringify({ success: false, message: 'amount and userId required', payload }));
            process.exit(1);
        }

        // Read required envs (set them in Appwrite Function settings)
        const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
        const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
        const APPWRITE_ENDPOINT = process.env.APPWRITE_FUNCTION_ENDPOINT || process.env.APPWRITE_ENDPOINT;
        const APPWRITE_PROJECT = process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.APPWRITE_PROJECT_ID;
        const APPWRITE_API_KEY = process.env.APPWRITE_FUNCTION_API_KEY || process.env.APPWRITE_API_KEY;
        const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
        const ORDERS_COLLECTION_ID = process.env.APPWRITE_ORDERS_COLLECTION_ID;

        if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) throw new Error('Missing Razorpay keys in function env');
        if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT || !APPWRITE_API_KEY) throw new Error('Missing Appwrite server config in function env');
        if (!DATABASE_ID || !ORDERS_COLLECTION_ID) throw new Error('Missing database/collection IDs in function env');

        // Create Razorpay order (amount in paise)
        const razor = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
        const amountPaise = Math.round(Number(amount) * 100);

        const orderOptions = {
            amount: amountPaise,
            currency,
            receipt: receipt || `rcpt_${Date.now()}`,
            payment_capture: 1,
            notes: { appwriteUserId: userId }
        };

        console.log('Creating Razorpay order with options:', orderOptions);
        const razorOrder = await razor.orders.create(orderOptions);
        console.log('Razorpay order created id=', razorOrder && razorOrder.id);

        // Initialize Appwrite server SDK
        const client = new Client()
            .setEndpoint(APPWRITE_ENDPOINT)
            .setProject(APPWRITE_PROJECT)
            .setKey(APPWRITE_API_KEY);

        const databases = new Databases(client);

        // Convert items -> array of product IDs (strings) for the `items` column
        // and keep full snapshot in `items_json` text column.
        const productIds = Array.isArray(items)
            ? items.map(it => (it && (it.productId || it.id || String(it))))
            : [];

        const itemsJson = JSON.stringify(items || []);

        // Build document object matching your collection's allowed columns
        const orderDocPayload = {
            userId,
            items: productIds,   // Must be array of strings if your collection expects such
            items_json: itemsJson, // Text column with full snapshot; create this column if not present
            amount,
            currency,
            receipt: orderOptions.receipt,
            razorpay_order_id: razorOrder.id,
            status: 'created',
            // createdAt is optional - Appwrite provides $createdAt automatically
        };

        console.log('Creating Appwrite order document with:', orderDocPayload);
        const orderDoc = await databases.createDocument(DATABASE_ID, ORDERS_COLLECTION_ID, ID.unique(), orderDocPayload);
        console.log('Appwrite order doc created', orderDoc.$id);

        const out = { success: true, razorOrder, localOrderId: orderDoc.$id };
        console.log(JSON.stringify(out));
        process.exit(0);

    } catch (err) {
        console.error('create-order error:', err && (err.stack || err.message || err));
        console.log(JSON.stringify({ success: false, message: String(err && err.message ? err.message : err) }));
        process.exit(1);
    }
})();
