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

        // parse request body safely
        const body = (() => {
            try {
                return JSON.parse(req.bodyRaw || "{}");
            } catch {
                return {};
            }
        })();

        const {
            amount,
            currency = "INR",
            userId = null,
            items = [],
            payment_method = "razorpay",
            shipping = null,
            shippingPrimaryIndex = 0,
        } = body || {};

        // basic validation
        if (!payment_method || !["cod", "razorpay"].includes(payment_method)) {
            return res.json({ success: false, message: "payment_method must be 'cod' or 'razorpay'" }, 400);
        }

        if (payment_method === "razorpay") {
            if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
                return res.json({ success: false, message: "Valid amount required for razorpay orders" }, 400);
            }
        }

        // Normalize shipping to array
        let shippingArray = [];
        if (Array.isArray(shipping)) shippingArray = shipping;
        else if (shipping && typeof shipping === "object") shippingArray = [shipping];
        else shippingArray = [];

        const primaryIndex = Number.isInteger(shippingPrimaryIndex) ? shippingPrimaryIndex : 0;
        const primaryShipping = shippingArray[primaryIndex] || shippingArray[0] || {};

        // Flatten primary shipping fields for indexing (camelCase)
        const shipping_fullName = normalizeStr(primaryShipping.fullName) || null;
        const shipping_phone = normalizeStr(primaryShipping.phone) || null;
        const shipping_line1 = normalizeStr(primaryShipping.line1) || null;
        const shipping_line2 = normalizeStr(primaryShipping.line2) || null;
        const shipping_city = normalizeStr(primaryShipping.city) || null;
        const shipping_state = normalizeStr(primaryShipping.state) || null;
        const shipping_postalCode = normalizeStr(primaryShipping.postalCode) || null;
        const shipping_country = normalizeStr(primaryShipping.country) || "India";

        // Also prepare snake_case versions for Appwrite attributes
        const shipping_full_name = shipping_fullName;
        const shipping_phone_snake = shipping_phone;
        const shipping_line_1 = shipping_line1;
        const shipping_line_2 = shipping_line2;
        const shipping_city_snake = shipping_city;
        const shipping_state_snake = shipping_state;
        const shipping_postal_code = shipping_postalCode;
        const shipping_country_snake = shipping_country;

        // Appwrite env
        const APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT;
        const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
        const APPWRITE_API_KEY = process.env.APPWRITE_API_KEY;
        const APPWRITE_DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
        const APPWRITE_ORDERS_COLLECTION_ID = process.env.APPWRITE_ORDERS_COLLECTION_ID;

        // objects to return
        let razorpayOrder = null;
        let savedOrderDoc = null;

        // If razorpay: create Razorpay order first
        let razorpayOrderId = null;
        let razorpayAmountPaise = null;
        let razorpayCurrency = currency;
        if (payment_method === "razorpay") {
            if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
                return res.json({ success: false, message: "Razorpay credentials not configured" }, 500);
            }
            const razorpay = createRazorpayClient();
            razorpayOrder = await razorpay.orders.create({
                amount: Math.round(Number(amount) * 100),
                currency,
                receipt: `order_rcpt_${Date.now()}`,
            });
            razorpayOrderId = razorpayOrder.id;
            razorpayAmountPaise = razorpayOrder.amount;
            razorpayCurrency = razorpayOrder.currency || razorpayCurrency;
            log("✅ Razorpay order created:", razorpayOrderId);
        }

        // If Appwrite is configured, create/update orders collection doc
        if (APPWRITE_ENDPOINT && APPWRITE_PROJECT_ID && APPWRITE_API_KEY && APPWRITE_DATABASE_ID && APPWRITE_ORDERS_COLLECTION_ID) {
            try {
                log("🔁 Initializing Appwrite client for saving order");
                const client = new AppwriteClient()
                    .setEndpoint(APPWRITE_ENDPOINT)
                    .setProject(APPWRITE_PROJECT_ID)
                    .setKey(APPWRITE_API_KEY);
                const databases = new Databases(client);

                // Build payload including both camelCase and snake_case fields
                const payload = {
                    // canonical order id (Razorpay id for online payments, server id for COD)
                    orderId: razorpayOrderId || `cod_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
                    // snake_case alias (in case Appwrite collection expects this name)
                    order_id: razorpayOrderId || `cod_${Date.now()}_${Math.floor(Math.random() * 10000)}`,

                    userId,
                    items,
                    status: payment_method === "cod" ? "pending" : "created",
                    payment_method,
                    // amount stored in paise
                    amount: payment_method === "razorpay" ? razorpayAmountPaise : Math.round(Number(amount || 0) * 100),
                    currency: razorpayCurrency,
                    // razorpay-specific fields (both snake_case and camelCase)
                    razorpayOrderId: razorpayOrderId || null,
                    razorpay_order_id: razorpayOrderId || null,
                    razorpayRaw: razorpayOrder || null,
                    razorpay_raw: razorpayOrder || null,
                    razorpay_amount: razorpayAmountPaise || (payment_method === "cod" ? Math.round(Number(amount || 0) * 100) : null),
                    razorpay_currency: razorpayCurrency,

                    // full shipping array preserved
                    shipping: shippingArray,

                    // flattened fields camelCase
                    shipping_fullName,
                    shipping_phone,
                    shipping_line1,
                    shipping_line2,
                    shipping_city,
                    shipping_state,
                    shipping_postalCode,
                    shipping_country,

                    // flattened fields snake_case for Appwrite attributes
                    shipping_full_name,
                    shipping_phone: shipping_phone_snake,
                    shipping_line_1,
                    shipping_line_2,
                    shipping_city: shipping_city_snake,
                    shipping_state: shipping_state_snake,
                    shipping_postal_code,
                    shipping_country: shipping_country_snake,

                    $createdAt: new Date().toISOString(),
                    $updatedAt: new Date().toISOString(),
                };

                // Try to find existing document by orderId (if razorpayOrderId present)
                let existing = null;
                if (payload.orderId) {
                    try {
                        const list = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_ORDERS_COLLECTION_ID, [
                            Query.equal("orderId", payload.orderId),
                            Query.limit(1),
                        ]);
                        existing = (list?.documents || [])[0] || null;
                    } catch (qErr) {
                        log("Query for existing order failed (will create):", qErr.message || qErr);
                    }
                }

                if (existing) {
                    log("🔄 Updating existing Appwrite order doc:", existing.$id);
                    // Prepare update object: avoid overwriting Appwrite metadata ($id, $collection)
                    const update = {
                        ...existing,
                        ...payload,
                        updatedAt: new Date().toISOString(),
                    };
                    savedOrderDoc = await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_ORDERS_COLLECTION_ID, existing.$id, update);
                } else {
                    log("➕ Creating new Appwrite order doc");
                    savedOrderDoc = await databases.createDocument(APPWRITE_DATABASE_ID, APPWRITE_ORDERS_COLLECTION_ID, ID.unique(), payload);
                }

                log("✅ Order saved to Appwrite orders collection:", savedOrderDoc.$id);
            } catch (dbErr) {
                // non-fatal; log and continue
                error("Error saving order to Appwrite DB:", dbErr.message || dbErr);
            }
        } else {
            log("ℹ️ Appwrite DB env not fully configured — skipping DB save");
        }

        // Build response
        const responsePayload = {
            success: true,
            payment_method,
            orderId: razorpayOrderId || (savedOrderDoc && savedOrderDoc.orderId) || null,
            amount: payment_method === "razorpay" ? razorpayAmountPaise : Math.round(Number(amount || 0) * 100),
            currency: razorpayCurrency,
            razorpayOrder: razorpayOrder || null,
            savedOrderDoc: savedOrderDoc || null,
        };

        return res.json(responsePayload);
    } catch (err) {
        error("Critical error in createOrder:", err.message || err);
        return res.json({ success: false, error: err.message || String(err) }, 500);
    }
};
