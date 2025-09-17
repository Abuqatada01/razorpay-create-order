// createOrder.js (Appwrite Function)
// Create order for COD or Razorpay and save shipping/phone to Appwrite orders collection
// ESM-compatible (node-appwrite named exports)
import Razorpay from "razorpay";
import { Client as AppwriteClient, Databases, Query, ID } from "node-appwrite";

/**
 * Expects POST body JSON:
 * {
 *   amount: 1000,               // rupees (number) - required for razorpay
 *   currency: "INR",            // optional
 *   userId: "user_xxx",         // required (your collection requires userId)
 *   items: [{ name, price, size, ... }, ...] or ["label1", ...], // optional
 *   paymentMethod: "cod"|"razorpay"  // or payment_method
 *   shipping: { fullName, phone, line1, ... } OR [ {...} ]
 *   shippingPrimaryIndex: 0     // optional
 * }
 *
 * Required Function ENV:
 * - RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET  (for razorpay flow)
 * - APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY,
 *   APPWRITE_DATABASE_ID, APPWRITE_ORDERS_COLLECTION_ID
 */

const createRazorpayClient = () =>
    new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

const normalizeStr = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));

// Build a short human readable string for shipping (<= 999 chars)
const buildShippingShort = (s) => {
    if (!s || typeof s !== "object") return "";
    const parts = [];
    if (s.fullName || s.full_name) parts.push(normalizeStr(s.fullName || s.full_name));
    if (s.line1 || s.line_1) parts.push(normalizeStr(s.line1 || s.line_1));
    if (s.line2 || s.line_2) {
        const l2 = normalizeStr(s.line2 || s.line_2);
        if (l2) parts.push(l2);
    }
    if (s.city) parts.push(normalizeStr(s.city));
    if (s.state) parts.push(normalizeStr(s.state));
    if (s.postalCode || s.postal_code) parts.push(normalizeStr(s.postalCode || s.postal_code));
    if (s.country) parts.push(normalizeStr(s.country));
    if (s.phone) parts.push(`Ph: ${normalizeStr(s.phone)}`);
    const joined = parts.filter(Boolean).join(", ");
    // Appwrite string limit for some columns is small; ensure under 999 chars
    return joined.length > 999 ? joined.slice(0, 999) : joined;
};

// Build short item labels (strings) and keep full JSON separately
const itemsToShortLabels = (itms) => {
    if (!Array.isArray(itms)) return [];
    return itms.map((it) => {
        try {
            if (!it) return "";
            if (typeof it === "string") return it.slice(0, 9999);
            const name = it.name || it.title || it.productId || it.id || "item";
            const size = it.size || it.s || it.sizeOption || it.item_size;
            const price = (typeof it.price !== "undefined" && it.price !== null) ? it.price : (it.amount || null);
            let label = normalizeStr(name);
            if (size) label += ` (Size: ${normalizeStr(size)})`;
            if (price !== null && price !== undefined) label += ` - ₹${price}`;
            return label.slice(0, 9999);
        } catch {
            return JSON.stringify(it || {}).slice(0, 9999);
        }
    });
};

export default async ({ req, res, log, error }) => {
    try {
        log("⚡ createOrder function started");

        if (req.method !== "POST") {
            if (req.method === "GET") return res.text("createOrder function is live");
            return res.json({ success: false, message: `Method ${req.method} not allowed` }, 405);
        }

        // parse body
        const body = (() => {
            try {
                return JSON.parse(req.bodyRaw || "{}");
            } catch {
                return {};
            }
        })();
        console.log(body);

        const {
            amount,
            currency = "INR",
            userId,
            items = [],
            paymentMethod,
            payment_method,
            shipping = null,
            shippingPrimaryIndex = 0,
        } = body || {};

        const pm = (paymentMethod || payment_method || "razorpay").toLowerCase();

        if (!userId) {
            return res.json({ success: false, message: "userId is required. Please login and send userId." }, 400);
        }

        if (!["cod", "razorpay"].includes(pm)) {
            return res.json({ success: false, message: "paymentMethod must be 'cod' or 'razorpay'" }, 400);
        }

        if (pm === "razorpay") {
            if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
                return res.json({ success: false, message: "Valid amount (in rupees) required for razorpay orders" }, 400);
            }
        }

        // normalize shipping => array
        let shippingArray = [];
        if (Array.isArray(shipping)) shippingArray = shipping;
        else if (shipping && typeof shipping === "object") shippingArray = [shipping];
        else shippingArray = [];

        if (shippingArray.length === 0) {
            return res.json({ success: false, message: "shipping is required. Provide shipping object/array." }, 400);
        }

        const primaryIndex = Number.isInteger(shippingPrimaryIndex) ? shippingPrimaryIndex : 0;
        const primaryShipping = shippingArray[primaryIndex] || shippingArray[0] || {};

        // flatten primary shipping fields (both camelCase and snake_case covered)
        const shipping_full_name = normalizeStr(primaryShipping.fullName || primaryShipping.full_name);
        const shipping_phone = normalizeStr(primaryShipping.phone);
        const shipping_line_1 = normalizeStr(primaryShipping.line1 || primaryShipping.line_1);
        const shipping_line_2 = normalizeStr(primaryShipping.line2 || primaryShipping.line_2);
        const shipping_city = normalizeStr(primaryShipping.city);
        const shipping_state = normalizeStr(primaryShipping.state);
        const shipping_postal_code = normalizeStr(primaryShipping.postalCode || primaryShipping.postal_code);
        const shipping_country = normalizeStr(primaryShipping.country) || "India";

        // derive primary size from items if present (your collection expects top-level size)
        let primarySize = null;
        if (Array.isArray(items) && items.length > 0) {
            const first = items[0];
            if (first && (first.size || first.s || first.sizeOption || first.item_size)) {
                primarySize = String(first.size || first.s || first.sizeOption || first.item_size);
            } else {
                const found = items.find((it) => it && (it.size || it.s || it.sizeOption || it.item_size));
                if (found) primarySize = String(found.size || found.s || found.sizeOption || found.item_size);
            }
        }
        // If your collection requires size, you can return an error
        if (!primarySize) {
            return res.json({ success: false, message: "size is required (include size in items[0].size)." }, 400);
        }

        // prepare razorpay (if needed)
        let razorpayOrder = null;
        let razorpay_order_id = null;
        const amountPaiseFromClient = Math.round(Number(amount || 0) * 100);
        let amountPaise = amountPaiseFromClient;

        if (pm === "razorpay") {
            if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
                return res.json({ success: false, message: "Razorpay credentials not configured" }, 500);
            }
            const razorpay = createRazorpayClient();
            razorpayOrder = await razorpay.orders.create({
                amount: amountPaise,
                currency,
                receipt: `order_rcpt_${Date.now()}`,
            });
            razorpay_order_id = razorpayOrder.id;
            amountPaise = razorpayOrder.amount;
            log("✅ Razorpay order created:", razorpay_order_id);
        } else {
            // COD: generate canonical server id for order
            razorpay_order_id = `cod_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
        }

        // Appwrite config
        const APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT;
        const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
        const APPWRITE_API_KEY = process.env.APPWRITE_API_KEY;
        const APPWRITE_DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
        const APPWRITE_ORDERS_COLLECTION_ID = process.env.APPWRITE_ORDERS_COLLECTION_ID;

        let savedOrderDoc = null;
        if (APPWRITE_ENDPOINT && APPWRITE_PROJECT_ID && APPWRITE_API_KEY && APPWRITE_DATABASE_ID && APPWRITE_ORDERS_COLLECTION_ID) {
            try {
                log("🔁 Initializing Appwrite client for saving order");
                const client = new AppwriteClient().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
                const databases = new Databases(client);

                const canonicalOrderId = razorpay_order_id;
                const now = new Date().toISOString();

                // build Appwrite-friendly fields
                const shipping_short = buildShippingShort(primaryShipping); // short string for `shipping` column
                const shipping_json = JSON.stringify(shippingArray); // full JSON string for `shipping_json` text column
                const items_short = itemsToShortLabels(items); // array of short strings
                const items_json = JSON.stringify(items || []);

                // payload uses snake_case keys commonly used in your collection screenshot, plus camelCase
                const payload = {
                    // canonical id
                    order_id: canonicalOrderId,

                    // required fields
                    userId,
                    amount: amountPaise,
                    amountPaise,
                    currency,

                    // razorpay id
                    razorpay_order_id,

                    // short items + full JSON
                    items: items_short,
                    items_json,

                    // shipping short string & full json
                    shipping: shipping_short,
                    shipping_json,

                    // flattened shipping fields (snake_case & camel-case where helpful)
                    shipping_full_name,
                    shipping_phone,
                    shipping_line_1,
                    //   shipping_line_2,
                    shipping_city,
                    shipping_state,
                    shipping_postal_code,
                    shipping_country,

                    // top-level size (required by your collection)
                    size: primarySize,

                    // payment/status
                    payment_method: pm,
                    status: pm === "cod" ? "pending" : "created",

                    // metadata
                    receipt: razorpayOrder?.receipt || null,
                    verification_raw: JSON.stringify({ razorpayOrder: razorpayOrder || null }),
                    //   $createdAt: now,
                    //   $updatedAt: now,
                };

                // try to find existing doc by razorpay_order_id (avoid duplicates)
                let existing = null;
                try {
                    const list = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_ORDERS_COLLECTION_ID, [
                        Query.equal("razorpay_order_id", razorpay_order_id),
                        Query.limit(1),
                    ]);
                    existing = (list?.documents || [])[0] || null;
                } catch (qErr) {
                    log("Query for existing order failed (will create new):", qErr.message || qErr);
                }

                if (existing) {
                    log("🔄 Updating existing Appwrite order doc:", existing.$id);
                    savedOrderDoc = await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_ORDERS_COLLECTION_ID, existing.$id, payload);
                } else {
                    log("➕ Creating new Appwrite order doc");
                    savedOrderDoc = await databases.createDocument(APPWRITE_DATABASE_ID, APPWRITE_ORDERS_COLLECTION_ID, ID.unique(), payload);
                }

                log("✅ Order saved to Appwrite orders collection:", savedOrderDoc.$id || savedOrderDoc.id || "(no id)");
            } catch (dbErr) {
                error("Error saving order to Appwrite DB:", dbErr.message || dbErr);
                // return a helpful error so client can see why save failed
                return res.json({ success: false, message: "Failed saving order to DB", error: String(dbErr) }, 500);
            }
        } else {
            log("ℹ️ Appwrite DB env not fully configured — skipping DB save");
        }

        // respond
        return res.json({
            success: true,
            payment_method: pm,
            order_id: razorpay_order_id,
            amount: amountPaise,
            currency,
            razorpayOrder: razorpayOrder || null,
            savedOrderDoc: savedOrderDoc || null,
        });
    } catch (err) {
        error("Critical error in createOrder:", err.message || err);
        return res.json({ success: false, error: err.message || String(err) }, 500);
    }
};
