// index.js (create-order)
require("dotenv").config();
const Razorpay = require("razorpay");
const { Client, Databases, ID } = require("node-appwrite");

(async function main() {
    try {
        console.log(process.env.RAZORPAY_KEY_ID);

        // Read function payload (Appwrite sets APPWRITE_FUNCTION_DATA)
        let payload = {};
        try {
            if (process.env.APPWRITE_FUNCTION_DATA) {
                payload = JSON.parse(process.env.APPWRITE_FUNCTION_DATA);
            }
        } catch (err) {
            console.error("Failed to parse APPWRITE_FUNCTION_DATA:", err);
        }

        const { amount, currency = "INR", receipt, userId, items } = payload;

        if (!amount || !userId) {
            console.log(JSON.stringify({ success: false, message: "amount and userId required", payload }));
            process.exit(1);
        }

        // Env vars (set these in Function settings)
        const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
        const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

        const APPWRITE_ENDPOINT = process.env.APPWRITE_FUNCTION_ENDPOINT || process.env.APPWRITE_ENDPOINT;
        const APPWRITE_PROJECT = process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.APPWRITE_PROJECT_ID;
        const APPWRITE_API_KEY = process.env.APPWRITE_FUNCTION_API_KEY || process.env.APPWRITE_API_KEY;

        const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
        const ORDERS_COLLECTION_ID = process.env.APPWRITE_ORDERS_COLLECTION_ID;

        if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
            throw new Error("Missing Razorpay keys");
        }
        if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT || !APPWRITE_API_KEY) {
            throw new Error("Missing Appwrite server config");
        }
        if (!DATABASE_ID || !ORDERS_COLLECTION_ID) {
            throw new Error("Missing database/collection IDs");
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

        console.log("Creating Razorpay order:", orderOptions);
        const razorOrder = await razor.orders.create(orderOptions);
        console.log("Razorpay order created:", razorOrder && razorOrder.id);

        // Initialize Appwrite server SDK
        const client = new Client()
            .setEndpoint(APPWRITE_ENDPOINT)
            .setProject(APPWRITE_PROJECT)
            .setKey(APPWRITE_API_KEY);

        const databases = new Databases(client);

        const localOrder = {
            userId,
            items: items || [],
            amount,
            amountPaise,
            currency,
            receipt: orderOptions.receipt,
            razorpay_order_id: razorOrder.id,
            status: "created",
            createdAt: new Date().toISOString(),
        };

        const orderDoc = await databases.createDocument(DATABASE_ID, ORDERS_COLLECTION_ID, ID.unique(), localOrder);
        console.log("Appwrite order doc created", orderDoc.$id);

        const out = { success: true, razorOrder, localOrderId: orderDoc.$id };
        console.log(JSON.stringify(out));
        process.exit(0);
    } catch (err) {
        console.error("create-order error:", err && (err.stack || err.message || err));
        console.log(JSON.stringify({ success: false, message: String(err && err.message ? err.message : err) }));
        process.exit(1);
    }
})();
