// createOrder.js (Appwrite Function)
// - Converts item objects to string form for Appwrite schema compatibility
// - Keeps items_json for convenience and items_string fallback

const Razorpay = require("razorpay");
const sdk = require("node-appwrite");

const parseJSON = (input) => {
    try {
        if (!input) return {};
        return typeof input === "object" ? input : JSON.parse(input);
    } catch {
        return {};
    }
};

const nowISO = () => new Date().toISOString();

const createRazorpayClient = (env) =>
    new Razorpay({
        key_id: env.RAZORPAY_KEY_ID,
        key_secret: env.RAZORPAY_KEY_SECRET,
    });

const createAppwriteClient = (req) => {
    const client = new sdk.Client();
    const endpoint = process.env.APPWRITE_FUNCTION_ENDPOINT || process.env.APPWRITE_ENDPOINT || "";
    const project = process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.APPWRITE_PROJECT_ID || "";
    const keyFromHeader = req && req.headers ? (req.headers["x-appwrite-key"] || req.headers["X-Appwrite-Key"] || "") : "";
    client.setEndpoint(endpoint).setProject(project).setKey(keyFromHeader);
    return { client, databases: new sdk.Databases(client) };
};

module.exports = async ({ req, res, log, error }) => {
    try {
        log("⚡ Create-Order started (function runtime)");

        // minimal sanity checks
        const missing = [];
        if (!process.env.RAZORPAY_KEY_ID) missing.push("RAZORPAY_KEY_ID");
        if (!process.env.RAZORPAY_KEY_SECRET) missing.push("RAZORPAY_KEY_SECRET");
        if (!process.env.APPWRITE_FUNCTION_ENDPOINT && !process.env.APPWRITE_ENDPOINT) missing.push("APPWRITE_FUNCTION_ENDPOINT/APPWRITE_ENDPOINT");
        if (!process.env.APPWRITE_FUNCTION_PROJECT_ID && !process.env.APPWRITE_PROJECT_ID) missing.push("APPWRITE_FUNCTION_PROJECT_ID/APPWRITE_PROJECT_ID");
        if (!process.env.APPWRITE_ORDERS_COLLECTION_ID && !process.env.ORDERS_COLLECTION_ID) missing.push("APPWRITE_ORDERS_COLLECTION_ID/ORDERS_COLLECTION_ID");
        const headerKey = req && req.headers ? (req.headers["x-appwrite-key"] || req.headers["X-Appwrite-Key"]) : null;
        if (!headerKey) missing.push("x-appwrite-key (request header)");
        if (missing.length) {
            const msg = `Missing required configuration: ${missing.join(", ")}`;
            error(msg);
            return res.json({ success: false, error: msg }, 500);
        }

        if (req.method !== "POST") {
            if (req.method === "GET") return res.text("🚀 Razorpay Appwrite Function is live");
            return res.json({ success: false, message: `Method ${req.method} not allowed` }, 405);
        }

        const bodyData = parseJSON(req.bodyRaw || req.body || "{}");
        const { amount, currency = "INR", userId, items, shipping = {}, payment_method } = bodyData;

        if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
            return res.json({ success: false, message: "Valid amount required" }, 400);
        }

        // normalize items
        const itemsArr = Array.isArray(items) ? items : items ? [items] : [];
        // Appwrite schema expects string items (or single string). Convert each object -> JSON string
        const items_for_appwrite = itemsArr.map((it) => {
            if (typeof it === "string") return it;
            try {
                const json = JSON.stringify(it);
                // truncate long strings to 9999 chars to satisfy Appwrite limit (if needed)
                return json.length > 9999 ? json.slice(0, 9999) : json;
            } catch {
                return String(it).slice(0, 9999);
            }
        });

        // keep full JSON string too (as separate field)
        const items_json = JSON.stringify(itemsArr || []);

        // also provide a single items_string fallback (if collection expects single string)
        const items_string = items_json.length > 9999 ? items_json.slice(0, 9999) : items_json;

        // derive first item fields and size (if needed)
        const firstItem = itemsArr[0] || null;
        const sizeValue = firstItem && ("size" in firstItem) ? (firstItem.size ?? "N/A") : "N/A";

        const amountNumber = Number(amount); // rupees
        const amountPaise = Math.round(amountNumber * 100);
        const receipt = `order_rcpt_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

        // create razorpay order
        const razorpay = createRazorpayClient(process.env);
        log("Creating Razorpay order:", { amountPaise, currency, receipt });

        const razorpayOrder = await razorpay.orders.create({
            amount: amountPaise,
            currency,
            receipt,
        });

        log("✅ Razorpay order created:", razorpayOrder && razorpayOrder.id);

        // order document: set `items` field to array-of-strings (items_for_appwrite),
        // keep items_json and items_string for compatibility
        const orderDoc = {
            userId: userId || null,
            size: sizeValue,
            items: items_for_appwrite,     // array of strings (each <= 9999 chars)
            items_json,                   // full JSON string
            items_string: items_string,   // fallback single string truncated <=9999
            amount: amountNumber,
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
            //   createdAt: nowISO(),
            //   updatedAt: nowISO(),
        };

        // Save to Appwrite
        const { databases } = createAppwriteClient(req);
        const databaseId = process.env.APPWRITE_DATABASE_ID || "default";
        const collectionId = process.env.APPWRITE_ORDERS_COLLECTION_ID || process.env.ORDERS_COLLECTION_ID;
        if (!collectionId) {
            const msg = "Server misconfiguration: APPWRITE_ORDERS_COLLECTION_ID or ORDERS_COLLECTION_ID missing";
            error(msg);
            return res.json({ success: false, error: msg }, 500);
        }

        const documentId = sdk.ID && sdk.ID.unique ? sdk.ID.unique() : `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
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
        error("Critical error: " + (err && err.message ? err.message : String(err)));
        return res.json({ success: false, error: err && err.message ? err.message : String(err) }, 500);
    }
};
