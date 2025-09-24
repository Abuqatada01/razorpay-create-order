// createOrder.js (Appwrite Function) - defensive + debug-friendly
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
        log("⚡ Create-Order started (defensive)");

        // Basic required config check
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
            if (req.method === "GET") return res.text("🚀 Create-Order function live");
            return res.json({ success: false, message: `Method ${req.method} not allowed` }, 405);
        }

        const bodyData = parseJSON(req.bodyRaw || req.body || "{}");
        const { amount, currency = "INR", userId, items, shipping = {}, payment_method } = bodyData;

        if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
            return res.json({ success: false, message: "Valid amount required" }, 400);
        }

        // Normalize items
        const itemsArr = Array.isArray(items) ? items : items ? [items] : [];

        // Build compact summary for Appwrite 'items' attribute (collection expects single string <=999)
        let items_summary_string = "";
        try {
            const summaryArray = itemsArr.map((it) => {
                if (!it || typeof it !== "object") return String(it);
                return {
                    productId: it.productId ?? it.id ?? null,
                    name: it.name ?? it.productName ?? null,
                    qty: it.quantity ?? it.qty ?? 1,
                    size: it.size ?? null,
                    price: it.price ?? null,
                };
            });
            items_summary_string = JSON.stringify(summaryArray);
        } catch (e) {
            items_summary_string = JSON.stringify(itemsArr);
        }
        // truncate to 999 chars (strict)
        if (items_summary_string.length > 999) items_summary_string = items_summary_string.slice(0, 999);

        // Also keep full JSON in items_json (not used for Appwrite attribute validation)
        const items_json = JSON.stringify(itemsArr || []);

        const firstItem = itemsArr[0] || null;
        const sizeValue = firstItem && ("size" in firstItem) ? (firstItem.size ?? "N/A") : "N/A";

        const amountNumber = Number(amount);
        const amountPaise = Math.round(amountNumber * 100);
        const receipt = `order_rcpt_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

        // Create Razorpay order
        const razorpay = createRazorpayClient(process.env);
        log("Creating Razorpay order", { amountPaise, currency, receipt });

        const razorpayOrder = await razorpay.orders.create({
            amount: amountPaise,
            currency,
            receipt,
        });

        log("Razorpay order created:", razorpayOrder && razorpayOrder.id);

        // Primary payload: put the compact string into `items` (matching current schema expectation)
        const orderDocPrimary = {
            userId: userId || null,
            size: sizeValue,
            items: items_summary_string, // single string <=999 chars
            items_json,
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
            // createdAt: nowISO(),
            // updatedAt: nowISO(),
        };

        // Debug log: what we will send (no secrets)
        log("Prepared order document (primary) keys:", Object.keys(orderDocPrimary));
        log("items (type, length):", typeof orderDocPrimary.items, orderDocPrimary.items ? orderDocPrimary.items.length : 0);
        log("items_json length:", orderDocPrimary.items_json ? orderDocPrimary.items_json.length : 0);

        const { databases } = createAppwriteClient(req);
        const databaseId = process.env.APPWRITE_DATABASE_ID || "default";
        const collectionId = process.env.APPWRITE_ORDERS_COLLECTION_ID || process.env.ORDERS_COLLECTION_ID;
        const documentId = sdk.ID && sdk.ID.unique ? sdk.ID.unique() : `${Date.now()}-${Math.floor(Math.random() * 10000)}`;

        // try primary create attempt
        try {
            const createdDoc = await databases.createDocument(databaseId, collectionId, documentId, orderDocPrimary);
            log("Order saved to Appwrite (primary):", createdDoc.$id);
            return res.json({
                success: true,
                razorpay: { orderId: razorpayOrder.id, amount: razorpayOrder.amount, currency: razorpayOrder.currency, receipt: razorpayOrder.receipt },
                appwrite: { documentId: createdDoc.$id, used: "primary" },
            }, 201);
        } catch (createErr) {
            // capture Appwrite error text to help debug
            const createErrMsg = createErr && createErr.message ? String(createErr.message) : String(createErr);
            error("Appwrite createDocument primary failed: " + createErrMsg);
            log("Primary payload (truncated) was:", JSON.stringify({
                items_sample: orderDocPrimary.items && orderDocPrimary.items.substring(0, 200),
                items_len: orderDocPrimary.items ? orderDocPrimary.items.length : 0,
            }));

            // fallback attempt: remove `items` attribute and set a different field name (items_summary),
            // this helps test whether Appwrite rejects the field name itself or just the value/type
            const orderDocFallback = { ...orderDocPrimary };
            delete orderDocFallback.items;
            orderDocFallback.items_summary = items_summary_string; // non-schema name (safe)
            const fallbackDocumentId = sdk.ID && sdk.ID.unique ? sdk.ID.unique() : `${Date.now()}-${Math.floor(Math.random() * 10000)}`;

            try {
                const createdFallback = await databases.createDocument(databaseId, collectionId, fallbackDocumentId, orderDocFallback);
                log("Order saved to Appwrite (fallback):", createdFallback.$id);
                return res.json({
                    success: true,
                    razorpay: { orderId: razorpayOrder.id, amount: razorpayOrder.amount, currency: razorpayOrder.currency, receipt: razorpayOrder.receipt },
                    appwrite: { documentId: createdFallback.$id, used: "fallback_items_summary" },
                    warning: "Primary create failed; fallback with items_summary succeeded. Consider updating collection schema to accept items as text or rename attribute.",
                    primaryError: createErrMsg,
                }, 201);
            } catch (fallbackErr) {
                const fallbackErrMsg = fallbackErr && fallbackErr.message ? String(fallbackErr.message) : String(fallbackErr);
                error("Appwrite createDocument fallback failed: " + fallbackErrMsg);
                // Return detailed diagnostics (no secrets) so you can paste into next message
                return res.json({
                    success: false,
                    error: "Appwrite createDocument failed for both primary and fallback payloads.",
                    primaryAttempt: {
                        items_type: typeof orderDocPrimary.items,
                        items_length: orderDocPrimary.items ? orderDocPrimary.items.length : 0,
                        sample: orderDocPrimary.items ? orderDocPrimary.items.slice(0, 200) : null,
                        error: createErrMsg,
                    },
                    fallbackAttempt: {
                        items_summary_length: items_summary_string.length,
                        sample: items_summary_string.slice(0, 200),
                        error: fallbackErrMsg,
                    },
                    guidance: "Check collection schema attributes: name, type, and max length for 'items'. If possible make it text (larger) or optional, or accept objects as JSON strings.",
                }, 500);
            }
        }
    } catch (err) {
        error("Critical error: " + (err && err.message ? err.message : String(err)));
        return res.json({ success: false, error: err && err.message ? err.message : String(err) }, 500);
    }
};
