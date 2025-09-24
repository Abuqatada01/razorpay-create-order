// createOrder.js - stricter sanitization + whitelist to avoid unknown attrs and format errors
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

// Helper: coerce postal code to integer or return null
const sanitizePostalCode = (raw) => {
    if (raw === undefined || raw === null) return null;
    if (typeof raw === "number" && Number.isInteger(raw)) return raw;
    const digits = String(raw).replace(/\D+/g, "");
    if (!digits) return null;
    const n = parseInt(digits, 10);
    if (Number.isNaN(n)) return null;
    return n;
};

// Helper: truncate string safely
const trunc = (s, n) => {
    if (s === undefined || s === null) return null;
    const str = typeof s === "string" ? s : JSON.stringify(s);
    return str.length > n ? str.slice(0, n) : str;
};

module.exports = async ({ req, res, log, error }) => {
    try {
        log("⚡ Create-Order started (defensive, whitelist)");

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

        // items normalization and compact string
        const itemsArr = Array.isArray(items) ? items : items ? [items] : [];
        let items_summary_string = "";
        try {
            const summaryArray = itemsArr.map((it) => {
                if (!it || typeof it !== "object") return String(it);
                return {
                    productId: it.productId ?? it.id ?? null,
                    name: it.name ?? it.productName ?? it.title ?? null,
                    qty: it.quantity ?? it.qty ?? 1,
                    size: it.size ?? null,
                    price: it.price ?? null,
                };
            });
            items_summary_string = JSON.stringify(summaryArray);
        } catch {
            items_summary_string = JSON.stringify(itemsArr);
        }
        if (!items_summary_string || items_summary_string === "[]") {
            items_summary_string = JSON.stringify([{ name: "unknown", qty: 1 }]);
        }
        if (items_summary_string.length > 999) items_summary_string = items_summary_string.slice(0, 999);
        const items_json = trunc(itemsArr, 2000) || "[]";

        const firstItem = itemsArr[0] || null;
        const sizeValue = firstItem && ("size" in firstItem) ? (firstItem.size ?? "N/A") : "N/A";

        const amountNumber = Number(amount);
        const amountPaise = Math.round(amountNumber * 100);
        const receipt = `order_rcpt_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

        const razorpay = createRazorpayClient(process.env);
        log("Creating Razorpay order", { amountPaise, currency, receipt });

        const razorpayOrder = await razorpay.orders.create({
            amount: amountPaise,
            currency,
            receipt,
        });

        log("Razorpay order created:", razorpayOrder && razorpayOrder.id);

        // shipping json truncated
        let shipping_json = "";
        try {
            shipping_json = typeof shipping === "string" ? shipping : JSON.stringify(shipping || {});
        } catch (e) {
            shipping_json = "{}";
        }
        if (shipping_json.length > 999) shipping_json = shipping_json.slice(0, 999);

        // sanitize postal code — only include if valid integer
        const shipping_postal_code_int = sanitizePostalCode(
            shipping && (shipping.postal_code || shipping.zip || shipping.postal || shipping.postcode)
        );

        // Build a whitelist of allowed fields for Appwrite document
        const allowed = {
            userId: userId || null,
            size: sizeValue,
            items: items_summary_string,
            items_json: items_json,
            amount: amountNumber,
            amountPaise,
            currency,
            razorpay_order_id: razorpayOrder.id,
            razorpay_payment_id: null,
            razorpay_signature: null,
            status: "created",
            receipt,
            payment_method: payment_method || null,
            shipping_full_name: (shipping && (shipping.full_name || shipping.name)) || null,
            shipping_phone: (shipping && (shipping.phone || shipping.mobile)) || null,
            shipping_line_1: (shipping && (shipping.line_1 || shipping.address_line1 || shipping.address1)) || null,
            shipping_city: (shipping && (shipping.city || shipping.town)) || null,
            // shipping_postal_code intentionally added only if valid integer below
            shipping_country: (shipping && shipping.country) || null,
            shipping_json,
            verification_raw: null,
            order_id: razorpayOrder.receipt || null,
        };

        // Only set shipping_postal_code if it's valid integer
        if (typeof shipping_postal_code_int === "number" && Number.isInteger(shipping_postal_code_int)) {
            allowed.shipping_postal_code = shipping_postal_code_int;
        }

        // Build sanitizedDoc with only defined keys (drop undefined)
        const sanitizedDoc = {};
        Object.keys(allowed).forEach((k) => {
            if (allowed[k] !== undefined) sanitizedDoc[k] = allowed[k];
        });

        // Debug log sanitizedDoc keys and lightweight samples (no secrets)
        log("Sanitized document prepared for Appwrite:", {
            keys: Object.keys(sanitizedDoc),
            items_len: sanitizedDoc.items ? sanitizedDoc.items.length : 0,
            shipping_json_len: sanitizedDoc.shipping_json ? sanitizedDoc.shipping_json.length : 0,
            shipping_postal_code: sanitizedDoc.shipping_postal_code,
        });

        const { databases } = createAppwriteClient(req);
        const databaseId = process.env.APPWRITE_DATABASE_ID || "default";
        const collectionId = process.env.APPWRITE_ORDERS_COLLECTION_ID || process.env.ORDERS_COLLECTION_ID;
        const documentId = sdk.ID && sdk.ID.unique ? sdk.ID.unique() : `${Date.now()}-${Math.floor(Math.random() * 10000)}`;

        // Try primary create
        try {
            const created = await databases.createDocument(databaseId, collectionId, documentId, sanitizedDoc);
            log("Order saved to Appwrite (primary):", created.$id);
            return res.json({
                success: true,
                razorpay: { orderId: razorpayOrder.id, amount: razorpayOrder.amount, currency: razorpayOrder.currency, receipt: razorpayOrder.receipt },
                appwrite: { documentId: created.$id, used: "primary" },
            }, 201);
        } catch (createErr) {
            const createErrMsg = createErr && createErr.message ? String(createErr.message) : String(createErr);
            error("Appwrite createDocument primary failed: " + createErrMsg);
            log("Primary sanitizedDoc sample:", JSON.stringify({
                items_sample: sanitizedDoc.items && sanitizedDoc.items.substring(0, 200),
                items_len: sanitizedDoc.items ? sanitizedDoc.items.length : 0,
                shipping_json_sample: sanitizedDoc.shipping_json && sanitizedDoc.shipping_json.substring(0, 200),
                shipping_postal_code: sanitizedDoc.shipping_postal_code,
            }));

            // Fallback: retry the exact same sanitizedDoc with a different id
            const fallbackId = sdk.ID && sdk.ID.unique ? sdk.ID.unique() : `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
            try {
                const createdFallback = await databases.createDocument(databaseId, collectionId, fallbackId, sanitizedDoc);
                log("Order saved to Appwrite (fallback):", createdFallback.$id);
                return res.json({
                    success: true,
                    razorpay: { orderId: razorpayOrder.id, amount: razorpayOrder.amount, currency: razorpayOrder.currency, receipt: razorpayOrder.receipt },
                    appwrite: { documentId: createdFallback.$id, used: "fallback_same_payload" },
                    warning: "Primary create failed; fallback succeeded using sanitized payload.",
                    primaryError: createErrMsg,
                }, 201);
            } catch (fallbackErr) {
                const fallbackErrMsg = fallbackErr && fallbackErr.message ? String(fallbackErr.message) : String(fallbackErr);
                error("Appwrite createDocument fallback failed: " + fallbackErrMsg);
                return res.json({
                    success: false,
                    error: "Appwrite createDocument failed for both primary and fallback attempts.",
                    primaryAttempt: { error: createErrMsg, sample: sanitizedDoc.items && sanitizedDoc.items.slice(0, 200) },
                    fallbackAttempt: { error: fallbackErrMsg },
                    guidance: "Verify collection schema allows these exact fields and types. If shipping_postal_code requires a different format (string leading zeros), change schema to string/text.",
                }, 500);
            }
        }
    } catch (err) {
        error("Critical error: " + (err && err.message ? err.message : String(err)));
        return res.json({ success: false, error: err && err.message ? err.message : String(err) }, 500);
    }
};
