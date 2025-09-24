// createOrder.js (Appwrite Function)
// - Adds 'size' (and productId/productName/quantity) to the Appwrite order document
// - Uses Appwrite Function runtime endpoint/project and req.headers['x-appwrite-key'] for auth.

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

        // sanity checks (trimmed)
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

        // normalize items - expect array; use first item for size/product-level attributes
        const itemsArr = Array.isArray(items) ? items : items ? [items] : [];
        const firstItem = itemsArr[0] || null;

        // derive fields required by your schema
        // Appwrite complained about missing "size" attribute — include it (fallback "N/A")
        const sizeValue = firstItem && ("size" in firstItem) ? (firstItem.size ?? "N/A") : "N/A";
        const productId = firstItem && firstItem.productId ? firstItem.productId : null;
        const productName = firstItem && firstItem.name ? firstItem.name : null;
        const quantity = firstItem && firstItem.quantity ? Number(firstItem.quantity) : (itemsArr.length || 0);

        const amountNumber = Number(amount); // rupees expected from client
        const amountPaise = Math.round(amountNumber * 100);
        const receipt = `order_rcpt_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

        // Create Razorpay order
        const razorpay = createRazorpayClient(process.env);
        log("Creating Razorpay order:", { amountPaise, currency, receipt });

        const razorpayOrder = await razorpay.orders.create({
            amount: amountPaise,
            currency,
            receipt,
            // payment_capture: 1,
        });

        log("✅ Razorpay order created:", razorpayOrder && razorpayOrder.id);

        // Build order document including required 'size'
        const orderDoc = {
            userId: userId || null,
            // productId,
            // productName,
            // quantity,
            size: sizeValue, // <-- required attribute added here
            items: itemsArr,
            items_json: JSON.stringify(itemsArr || []),
            amount: amountNumber,
            // amountPaise,
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
            // receipt_local: receipt,
            //   createdAt: nowISO(),
            //   updatedAt: nowISO(),
            razorpay_order: razorpayOrder,
        };

        // Save to Appwrite Database
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
