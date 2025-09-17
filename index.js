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

export default async ({ req, res, log, error }) => {
    try {
        log("⚡ createOrder function started");

        if (req.method !== "POST") {
            if (req.method === "GET") return res.text("createOrder function is live");
            return res.json({ success: false, message: `Method ${req.method} not allowed` }, 405);
        }

        // Parse body safely
        const body = (() => {
            try {
                return JSON.parse(req.bodyRaw || "{}");
            } catch {
                return {};
            }
        })();

        // Accept both camelCase and snake_case client keys for compatibility
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

        // REQUIRED: ensure userId exists (your collection requires userId)
        if (!userId) {
            return res.json({ success: false, message: "userId is required. Please login and send userId." }, 400);
        }

        // Shipping normalisation: MUST provide shipping (your collection enforces required)
        let shippingArray = [];
        if (Array.isArray(shipping)) shippingArray = shipping;
        else if (shipping && typeof shipping === "object") shippingArray = [shipping];
        else shippingArray = [];

        if (shippingArray.length === 0) {
            return res.json({ success: false, message: "shipping is required. Provide shipping object/array." }, 400);
        }

        const primaryIndex = Number.isInteger(shippingPrimaryIndex) ? shippingPrimaryIndex : 0;
        const primaryShipping = shippingArray[primaryIndex] || shippingArray[0] || {};

        // Flatten shipping fields (both camelCase and snake_case)
        const shipping_fullName = normalizeStr(primaryShipping.fullName || primaryShipping.full_name) || null;
        const shipping_phone = normalizeStr(primaryShipping.phone) || null;
        const shipping_line1 = normalizeStr(primaryShipping.line1 || primaryShipping.line_1) || null;
        const shipping_line2 = normalizeStr(primaryShipping.line2 || primaryShipping.line_2) || null;
        const shipping_city = normalizeStr(primaryShipping.city) || null;
        const shipping_state = normalizeStr(primaryShipping.state) || null;
        const shipping_postalCode = normalizeStr(primaryShipping.postalCode || primaryShipping.postal_code) || null;
        const shipping_country = normalizeStr(primaryShipping.country) || "India";

        // Snake-case aliases (exact names from your screenshot)
        const shipping_full_name = shipping_fullName;
        const shipping_line_1 = shipping_line1;
        const shipping_line_2 = shipping_line2;
        const shipping_postal_code = shipping_postalCode;

        // Extract top-level size (collection requires `size`)
        let primarySize = null;
        if (Array.isArray(items) && items.length > 0) {
            const first = items[0];
            if (first && (first.size || first.s || first.sizeOption || first.item_size)) {
                primarySize = String(first.size || first.s || first.sizeOption || first.item_size);
            } else {
                // search any item that has size
                const found = items.find((it) => it && (it.size || it.s || it.sizeOption || it.item_size));
                if (found) primarySize = String(found.size || found.s || found.sizeOption || found.item_size);
            }
        }

        // If collection requires size, ensure it is present
        if (!primarySize) {
            return res.json({ success: false, message: "size is required (e.g. send size in items[0].size)." }, 400);
        }

        // If razorpay payment, validate amount exists and positive
        if (pm === "razorpay") {
            if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
                return res.json({ success: false, message: "Valid amount (in rupees) required for razorpay orders" }, 400);
            }
        }

        // Prepare variables for Razorpay flow
        let razorpayOrder = null;
        let razorpayOrderId = null;
        let amountPaise = Math.round(Number(amount || 0) * 100);

        if (pm === "razorpay") {
            if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
                return res.json({ success: false, message: "Razorpay credentials not configured" }, 500);
            }
            const razorpay = createRazorpayClient();
            // create razorpay order
            razorpayOrder = await razorpay.orders.create({
                amount: amountPaise,
                currency,
                receipt: `order_rcpt_${Date.now()}`,
            });
            razorpayOrderId = razorpayOrder.id;
            amountPaise = razorpayOrder.amount; // ensures we use razorpay returned amount (paise)
            log("✅ Razorpay order created:", razorpayOrderId);
        } else {
            // COD: create a canonical server order id so razorpay_order_id (required) exists
            razorpayOrderId = `cod_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
            // amountPaise: still store provided amount if present (else 0)
            amountPaise = Math.round(Number(amount || 0) * 100);
        }

        // Appwrite configuration (must be set in function env)
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

                const canonicalOrderId = razorpayOrderId;

                // Build payload exactly matching your collection's columns (names & types)
                const now = new Date().toISOString();
                const payload = {
                    // required / canonical ids
                    orderId: canonicalOrderId,
                    order_id: canonicalOrderId,

                    // required fields (match your collection)
                    userId: userId,
                    amount: amountPaise, // paise (integer) — screenshot shows amount required
                    currency: currency,
                    razorpay_order_id: razorpayOrderId, // required
                    // keep camelCase too (some code may look for this)
                    razorpayOrderId: razorpayOrderId,

                    // items (array) and items_json (string) - you have items[] and items_json columns
                    items: Array.isArray(items) ? items : [],
                    items_json: JSON.stringify(items || []),

                    // amountPaise (explicit column in screenshot)
                    amountPaise: amountPaise,

                    // payment method/status
                    payment_method: pm,
                    paymentMethod: pm,
                    status: pm === "cod" ? "pending" : "created",

                    // shipping MUST be present (required)
                    shipping: shippingArray,

                    // flattened shipping fields (snake_case as per screenshot)
                    shipping_full_name,
                    shipping_phone: shipping_phone,
                    shipping_line_1,
                    shipping_line_2,
                    shipping_city,
                    shipping_state,
                    shipping_postal_code,
                    shipping_country,

                    // size (required)
                    size: primarySize,
                    // also include item_size alias
                    item_size: primarySize,

                    // verification / meta
                    verification_raw: JSON.stringify({ razorpayOrder: razorpayOrder || null }),
                    receipt: razorpayOrder?.receipt || null,
                    createdAt: now,
                    updatedAt: now,
                };

                // Try to update an existing doc with same razorpay_order_id (avoid duplicates)
                let existing = null;
                try {
                    const list = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_ORDERS_COLLECTION_ID, [
                        Query.equal("razorpay_order_id", razorpayOrderId),
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
                // return a helpful error to the client
                return res.json({ success: false, message: "Failed saving order to DB", error: String(dbErr) }, 500);
            }
        } else {
            log("ℹ️ Appwrite DB env not fully configured — skipping DB save");
        }

        // Response back to client with canonical ids and razorpay info
        return res.json({
            success: true,
            payment_method: pm,
            orderId: razorpayOrderId,
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
