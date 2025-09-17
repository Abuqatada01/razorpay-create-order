// createOrder.js (Appwrite Function) - Create order for COD or Razorpay and save shipping/phone to orders collection
// ESM-compatible (node-appwrite named exports)
import Razorpay from "razorpay";
import { Client as AppwriteClient, Databases, Query, ID } from "node-appwrite";

const createRazorpayClient = () =>
    new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

const normalizeStr = (v) => (typeof v === "string" ? v.trim() : v);
const TRUNCATE_MAX = 9999; // Appwrite per-string limit

// build a readable single-string representation for an item
const stringifyItem = (it) => {
    try {
        if (!it && it !== 0) return "";
        if (typeof it === "string") {
            return it.length > TRUNCATE_MAX ? it.slice(0, TRUNCATE_MAX) : it;
        }
        if (typeof it === "number" || typeof it === "boolean") {
            return String(it);
        }
        // object: build readable label
        const name = it.name || it.title || it.productId || it.id || "item";
        const price =
            (typeof it.price !== "undefined" ? it.price : it.amount) || null;
        const size = it.size || it.s || it.sizeOption || it.item_size || null;
        const sizeLabel = size ? ` (Size: ${size})` : "";
        const priceLabel = price ? ` - ₹${price}` : "";
        const label = `${name}${sizeLabel}${priceLabel}`;
        const jsonFallback = JSON.stringify(it);
        const final = label.length >= 6 ? label : jsonFallback; // prefer label but fallback
        // ensure not too long
        return final.length > TRUNCATE_MAX ? final.slice(0, TRUNCATE_MAX) : final;
    } catch (err) {
        // last resort
        const s = JSON.stringify(it || {});
        return s.length > TRUNCATE_MAX ? s.slice(0, TRUNCATE_MAX) : s;
    }
};

export default async ({ req, res, log, error }) => {
    try {
        log("⚡ createOrder function started");

        if (req.method !== "POST") {
            if (req.method === "GET") return res.text("createOrder function is live");
            return res.json(
                { success: false, message: `Method ${req.method} not allowed` },
                405
            );
        }

        // safe parse
        const body = (() => {
            try {
                return JSON.parse(req.bodyRaw || "{}");
            } catch {
                return {};
            }
        })();

        // Accept both camelCase and snake_case client keys
        const {
            amount, // rupees (number) expected from client
            currency = "INR",
            userId,
            items = [],
            paymentMethod,
            payment_method,
            shipping = null,
            shippingPrimaryIndex = 0,
        } = body || {};

        const pm = (paymentMethod || payment_method || "razorpay").toLowerCase();

        // collection requires userId
        if (!userId) {
            return res.json(
                { success: false, message: "userId is required. Please login and send userId." },
                400
            );
        }

        // normalize shipping into array
        let shippingArray = [];
        if (Array.isArray(shipping)) shippingArray = shipping;
        else if (shipping && typeof shipping === "object") shippingArray = [shipping];
        else shippingArray = [];

        if (shippingArray.length === 0) {
            return res.json(
                { success: false, message: "shipping is required. Provide shipping object/array." },
                400
            );
        }

        const primaryIndex = Number.isInteger(shippingPrimaryIndex) ? shippingPrimaryIndex : 0;
        const primaryShipping = shippingArray[primaryIndex] || shippingArray[0] || {};

        // Flatten shipping fields (use names present in your collection)
        const shipping_full_name = normalizeStr(primaryShipping.fullName || primaryShipping.full_name) || null;
        const shipping_phone = normalizeStr(primaryShipping.phone) || null;
        const shipping_line_1 = normalizeStr(primaryShipping.line1 || primaryShipping.line_1) || null;
        const shipping_line_2 = normalizeStr(primaryShipping.line2 || primaryShipping.line_2) || null;
        const shipping_city = normalizeStr(primaryShipping.city) || null;
        const shipping_postal_code = normalizeStr(primaryShipping.postalCode || primaryShipping.postal_code) || null;
        const shipping_country = normalizeStr(primaryShipping.country) || "India";

        // derive size from items (collection requires `size`)
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

        if (!primarySize) {
            return res.json({ success: false, message: "size is required (e.g. send size in items[0].size)." }, 400);
        }

        // validate amount for razorpay
        if (pm === "razorpay") {
            if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
                return res.json({ success: false, message: "Valid amount (in rupees) required for razorpay orders" }, 400);
            }
        }

        // prepare razorpay order (if online)
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
            amountPaise = razorpayOrder.amount; // use server-verified paise
            log("✅ Razorpay order created:", razorpay_order_id);
        } else {
            // COD: generate server-side order id so razorpay_order_id column (required) exists
            razorpay_order_id = `cod_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
            amountPaise = amountPaiseFromClient;
        }

        // ---------------------------
        // PREPARE items_for_column (array of strings) and items_json (full JSON)
        // ---------------------------
        const itemsForColumn = Array.isArray(items)
            ? items.map((it) => {
                const s = stringifyItem(it);
                // ensure each element is string and within limit
                return typeof s === "string" ? (s.length > TRUNCATE_MAX ? s.slice(0, TRUNCATE_MAX) : s) : String(s).slice(0, TRUNCATE_MAX);
            })
            : [];

        const itemsJson = JSON.stringify(items || []);

        // Appwrite config from env
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

                // payload: use snake_case keys the collection expects (no orderId)
                const now = new Date().toISOString();
                const canonicalOrderId = razorpay_order_id;

                const payload = {
                    // primary id used in your collection: order_id
                    order_id: canonicalOrderId,

                    // required columns
                    userId: userId,
                    amount: amountPaise, // store amount in paise as integer
                    amountPaise: amountPaise, // also include if present
                    currency: currency,

                    // razorpay fields (snake_case column names in your collection)
                    razorpay_order_id: razorpay_order_id, // required
                    // razorpay_payment_id and razorpay_signature will be set in verification step

                    // items and items_json: items must be array-of-strings for your collection; full JSON in items_json
                    items: itemsForColumn,
                    items_json: itemsJson,

                    // payment & status
                    payment_method: pm,
                    status: pm === "cod" ? "pending" : "created",

                    // shipping (array) - required
                    shipping: shippingArray,

                    // flattened shipping fields (use the exact column names you have)
                    shipping_full_name,
                    shipping_phone,
                    shipping_line_1,
                    shipping_line_2,
                    shipping_city,
                    shipping_postal_code,
                    shipping_country,

                    // required size
                    size: primarySize,

                    // optional metadata
                    receipt: razorpayOrder?.receipt || null,
                    verification_raw: JSON.stringify({ razorpayOrder: razorpayOrder || null }),

                    // do not set Appwrite internal $createdAt/$updatedAt here manually unless you want to
                };

                // Try to find existing order by razorpay_order_id to avoid duplicates
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
                return res.json({ success: false, message: "Failed saving order to DB", error: String(dbErr) }, 500);
            }
        } else {
            log("ℹ️ Appwrite DB env not fully configured — skipping DB save");
        }

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
