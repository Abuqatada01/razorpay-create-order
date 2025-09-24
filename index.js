// createOrder.js (Appwrite Function)
// - Creates a Razorpay order and saves a corresponding document to Appwrite Database.
// - Fix: use sdk.ID.unique() to generate document id (avoids "Missing required parameter: documentId").

const Razorpay = require("razorpay");
const sdk = require("node-appwrite"); // Appwrite Node SDK

const env = process.env;

const createRazorpayClient = () =>
    new Razorpay({
        key_id: env.RAZORPAY_KEY_ID,
        key_secret: env.RAZORPAY_KEY_SECRET,
    });

const createAppwriteClient = () => {
    const client = new sdk.Client();
    client
        .setEndpoint(env.APPWRITE_ENDPOINT) // e.g. https://[HOSTNAME]/v1
        .setProject(env.APPWRITE_PROJECT) // project id
        .setKey(env.APPWRITE_API_KEY); // server API key

    return {
        client,
        databases: new sdk.Databases(client),
    };
};

const parseJSON = (input) => {
    try {
        if (!input) return {};
        return typeof input === "object" ? input : JSON.parse(input);
    } catch {
        return {};
    }
};

const nowISO = () => new Date().toISOString();

module.exports = async ({ req, res, log, error }) => {
    try {
        log("⚡ Create-Order started");

        if (req.method !== "POST") {
            if (req.method === "GET") return res.text("🚀 Razorpay Appwrite Function is live");
            return res.json({ success: false, message: `Method ${req.method} not allowed` }, 405);
        }

        const bodyData = parseJSON(req.bodyRaw || req.body || "{}");
        const { amount, currency = "INR", userId, items, shipping = {}, payment_method } = bodyData;

        if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
            return res.json({ success: false, message: "Valid amount required" }, 400);
        }

        const amountNumber = Number(amount); // rupees expected
        const amountPaise = Math.round(amountNumber * 100);

        // Build receipt
        const receipt = `order_rcpt_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

        // Create Razorpay order
        const razorpay = createRazorpayClient();

        log("Creating Razorpay order:", { amountPaise, currency, receipt });

        const razorpayOrder = await razorpay.orders.create({
            amount: amountPaise,
            currency,
            receipt,
            // payment_capture: 1,
        });

        log("✅ Razorpay order created:", razorpayOrder && razorpayOrder.id);

        // Build order document
        const orderDoc = {
            userId: userId || null,
            items: Array.isArray(items) ? items : items ? [items] : [],
            items_json: JSON.stringify(items || []),
            amount: amountNumber, // rupees
            amountPaise,
            currency,
            razorpay_order_id: razorpayOrder.id,
            razorpay_payment_id: null,
            razorpay_signature: null,
            status: "created",
            receipt,
            payment_method: payment_method || null,
            shipping_full_name: shipping.full_name || shipping.name || null,
            shipping_phone: shipping.phone || null,
            shipping_line_1: shipping.line_1 || shipping.address_line1 || null,
            shipping_city: shipping.city || null,
            shipping_postal_code: shipping.postal_code || shipping.zip || null,
            shipping_country: shipping.country || null,
            shipping,
            verification_raw: null,
            order_id: razorpayOrder.receipt || null,
            receipt_local: receipt,
            createdAt: nowISO(),
            updatedAt: nowISO(),
            razorpay_order: razorpayOrder,
        };

        // Save to Appwrite Database
        const { client: appwriteClient, databases } = createAppwriteClient();

        const databaseId = env.APPWRITE_DATABASE_ID || "default";
        // NOTE: env var name should match what's set in your function settings
        const collectionId = env.APPWRITE_ORDERS_COLLECTION_ID || env.ORDERS_COLLECTION_ID;
        if (!collectionId) {
            error("Missing APPWRITE_ORDERS_COLLECTION_ID or ORDERS_COLLECTION_ID env var");
            return res.json({ success: false, message: "Server misconfiguration: orders collection id missing" }, 500);
        }

        log("Saving order to Appwrite:", { databaseId, collectionId });

        // IMPORTANT: use sdk.ID.unique() to auto-generate an id
        const documentId = sdk.ID.unique();

        // createDocument(databaseId, collectionId, documentId, data, read = [], write = [])
        const createdDoc = await databases.createDocument(databaseId, collectionId, documentId, orderDoc);

        log("✅ Order saved to Appwrite:", createdDoc.$id);

        return res.json(
            {
                success: true,
                razorpay: {
                    orderId: razorpayOrder.id,
                    amount: razorpayOrder.amount,
                    currency: razorpayOrder.currency,
                    receipt: razorpayOrder.receipt,
                },
                appwrite: {
                    documentId: createdDoc.$id,
                },
            },
            201
        );
    } catch (err) {
        error("Critical error: " + (err.message || String(err)));
        return res.json({ success: false, error: err.message || String(err) }, 500);
    }
};
