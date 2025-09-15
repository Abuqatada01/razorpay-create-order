// create-order/index.js
require('dotenv').config();
const Razorpay = require('razorpay');
const { Client, Databases, ID } = require('node-appwrite');

(async function main() {
    try {
        // Parse payload

        let payload = {};
        console.log(JSON.stringify({
            debug: 'environment check',
            hasRazorpayId: !!process.env.RAZORPAY_KEY_ID,
            hasRazorpaySecret: !!process.env.RAZORPAY_KEY_SECRET,
            hasAppwriteEndpoint: !!process.env.APPWRITE_ENDPOINT,
            hasAppwriteProject: !!process.env.APPWRITE_PROJECT_ID,
            hasAppwriteApiKey: !!process.env.APPWRITE_API_KEY,
            hasDatabaseId: !!process.env.APPWRITE_DATABASE_ID,
            hasOrdersCollection: !!process.env.APPWRITE_ORDERS_COLLECTION_ID,
            payload
        }));
        if (process.env.APPWRITE_FUNCTION_DATA) {
            try {
                payload = JSON.parse(process.env.APPWRITE_FUNCTION_DATA);
            } catch (e) {
                console.log(JSON.stringify({ success: false, message: 'invalid function data', error: String(e) }));
                process.exit(1);
            }
        } else {
            console.log(JSON.stringify({ success: false, message: 'missing function payload' }));
            process.exit(1);
        }

        const { amount, currency = 'INR', receipt, userId, items } = payload;
        if (!amount || !userId) {
            console.log(JSON.stringify({ success: false, message: 'amount and userId required', payload }));
            process.exit(1);
        }

        // Env validation
        const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
        const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
        const APPWRITE_ENDPOINT = process.env.APPWRITE_FUNCTION_ENDPOINT || process.env.APPWRITE_ENDPOINT;
        const APPWRITE_PROJECT = process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.APPWRITE_PROJECT_ID;
        const APPWRITE_API_KEY = process.env.APPWRITE_FUNCTION_API_KEY || process.env.APPWRITE_API_KEY;
        const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
        const ORDERS_COLLECTION_ID = process.env.APPWRITE_ORDERS_COLLECTION_ID;

        if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
            console.log(JSON.stringify({ success: false, message: 'missing razorpay keys' }));
            process.exit(1);
        }
        if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT || !APPWRITE_API_KEY) {
            console.log(JSON.stringify({ success: false, message: 'missing appwrite server config' }));
            process.exit(1);
        }
        if (!DATABASE_ID || !ORDERS_COLLECTION_ID) {
            console.log(JSON.stringify({ success: false, message: 'missing database/collection ids' }));
            process.exit(1);
        }

        // Create Razorpay order
        const razor = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
        const amountPaise = Math.round(Number(amount) * 100);
        const orderOptions = {
            amount: amountPaise,
            currency,
            receipt: receipt || `rcpt_${Date.now()}`,
            payment_capture: 1,
            notes: { appwriteUserId: userId },
        };

        console.log(JSON.stringify({ info: 'creating razorpay order', orderOptions }));
        const razorOrder = await razor.orders.create(orderOptions);

        // Init Appwrite SDK
        const client = new Client()
            .setEndpoint(APPWRITE_ENDPOINT)
            .setProject(APPWRITE_PROJECT)
            .setKey(APPWRITE_API_KEY);

        const databases = new Databases(client);

        // Make sure you store fields that match your collection schema.
        // If your collection requires `items` to be an array of simple strings, map accordingly.
        // Here we provide both `items_json` and a minimal `items` array of ids for compatibility.
        const itemsJson = JSON.stringify(items || []);
        const itemsIds = Array.isArray(items)
            ? items.map((it) => it.productId || (typeof it === 'string' ? it : String(it)).slice(0, 499))
            : [];

        const localOrder = {
            userId,
            // adapt to your schema:
            items: itemsIds,          // minimal array that fits schema
            items_json: itemsJson,    // full JSON in case you want to parse later
            amount,                   // rupees
            currency,
            receipt: orderOptions.receipt,
            razorpay_order_id: razorOrder.id,
            status: 'created',
            // $createdAt: new Date().toISOString(),
        };

        console.log(JSON.stringify({ info: 'creating appwrite order doc', localOrder }));
        const orderDoc = await databases.createDocument(DATABASE_ID, ORDERS_COLLECTION_ID, ID.unique(), localOrder);

        const out = { success: true, razorOrder, localOrderId: orderDoc.$id };
        console.log(JSON.stringify(out));
        process.exit(0);
    } catch (err) {
        // Always print JSON error for client to consume and for logs
        console.error('create-order unexpected error', err && (err.stack || err.message || err));
        console.log(JSON.stringify({ success: false, message: String(err && err.message ? err.message : err) }));
        process.exit(1);
    }
})();
