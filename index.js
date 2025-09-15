// index.js (create-order Appwrite Function)
// Node 16+ environment
require('dotenv').config();

const Razorpay = require('razorpay');
const { Client, Databases, ID } = require('node-appwrite');

(async function main() {
    try {
        // 1) Parse payload (Appwrite passes environment variable APPWRITE_FUNCTION_DATA)
        let payload = {};
        if (process.env.APPWRITE_FUNCTION_DATA) {
            try {
                payload = JSON.parse(process.env.APPWRITE_FUNCTION_DATA);
            } catch (e) {
                console.error('Failed to parse APPWRITE_FUNCTION_DATA:', e);
                console.log(JSON.stringify({ success: false, message: 'invalid function data' }));
                process.exit(1);
            }
        } else {
            console.error('No APPWRITE_FUNCTION_DATA provided');
            console.log(JSON.stringify({ success: false, message: 'missing function payload' }));
            process.exit(1);
        }

        const { amount, currency = 'INR', receipt, userId, items } = payload;

        if (!amount || !userId) {
            console.error('Missing required payload fields', { amount, userId });
            console.log(JSON.stringify({ success: false, message: 'amount and userId required', payload }));
            process.exit(1);
        }

        // 2) Read environment variables (set these in the Function environment)
        const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
        const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

        const APPWRITE_ENDPOINT = process.env.APPWRITE_FUNCTION_ENDPOINT || process.env.APPWRITE_ENDPOINT;
        const APPWRITE_PROJECT = process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.APPWRITE_PROJECT_ID;
        const APPWRITE_API_KEY = process.env.APPWRITE_FUNCTION_API_KEY || process.env.APPWRITE_API_KEY;

        const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
        const ORDERS_COLLECTION_ID = process.env.APPWRITE_ORDERS_COLLECTION_ID;

        // Basic validation of env
        if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) throw new Error('Missing Razorpay keys in function environment');
        if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT || !APPWRITE_API_KEY) throw new Error('Missing Appwrite server config in function environment');
        if (!DATABASE_ID || !ORDERS_COLLECTION_ID) throw new Error('Missing database/collection IDs in function environment');

        // 3) Create Razorpay order (Razorpay expects paise)
        const razor = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
        const amountPaise = Math.round(Number(amount) * 100);
        const orderOptions = {
            amount: amountPaise,
            currency,
            receipt: receipt || `rcpt_${Date.now()}`,
            payment_capture: 1,
            notes: { appwriteUserId: userId },
        };

        console.log('Creating Razorpay order with options:', orderOptions);
        const razorOrder = await razor.orders.create(orderOptions);
        console.log('Razorpay order created:', razorOrder && razorOrder.id);

        // 4) Initialize Appwrite server SDK
        const client = new Client()
            .setEndpoint(APPWRITE_ENDPOINT)
            .setProject(APPWRITE_PROJECT)
            .setKey(APPWRITE_API_KEY);

        const databases = new Databases(client);

        // 5) Prepare items for Appwrite storage using Option A:
        //    - items (Appwrite column): array of product IDs (strings)
        //    - items_json (text column): full items JSON as string (snapshot)
        const productIds = Array.isArray(items) ? items.map(i => String(i.productId || i.id || '')) : [];
        const safeItemsJson = JSON.stringify(items || []);

        // 6) Build object to store in Appwrite — keep only fields allowed by your schema
        const localOrderToStore = {
            userId,
            items: productIds,       // MUST be an array of strings in Appwrite
            items_json: safeItemsJson, // new text column (create it in Appwrite console)
            amount,                  // rupees
            currency,
            receipt: orderOptions.receipt,
            razorpay_order_id: razorOrder.id,
            status: 'created',
            $createdAt: new Date().toISOString(),
        };

        // Log before creating to help debug schema mismatches
        console.log('Creating Appwrite order document with:', localOrderToStore);

        // 7) Create document in Appwrite
        const orderDoc = await databases.createDocument(
            DATABASE_ID,
            ORDERS_COLLECTION_ID,
            ID.unique(),
            localOrderToStore
        );

        console.log('Appwrite order doc created', orderDoc.$id);

        // 8) Return success JSON (Appwrite function logs this; client will read response)
        const out = { success: true, razorOrder, localOrderId: orderDoc.$id };
        console.log(JSON.stringify(out));
        process.exit(0);

    } catch (err) {
        // Robust error logging — console.log JSON so client can parse responseBody if needed
        console.error('create-order error:', err && (err.stack || err.message || err));
        console.log(JSON.stringify({ success: false, message: String(err && err.message ? err.message : err) }));
        process.exit(1);
    }
})();
