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
            paymentMethod = "razorpay",
            shipping = null,
            shippingPrimaryIndex = 0,
        } = body || {};

        // basic validation
        if (!paymentMethod || !["cod", "razorpay"].includes(paymentMethod)) {
            return res.json({ success: false, message: "paymentMethod must be 'cod' or 'razorpay'" }, 400);
        }

        if (paymentMethod === "razorpay") {
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

        // Flatten primary shipping fields for indexing
        const shipping_fullName = normalizeStr(primaryShipping.fullName) || null;
        const shipping_phone = normalizeStr(primaryShipping.phone) || null;
        const shipping_line1 = normalizeStr(primaryShipping.line1) || null;
        const shipping_line2 = normalizeStr(primaryShipping.line2) || null;
        const shipping_city = normalizeStr(primaryShipping.city) || null;
        const shipping_state = normalizeStr(primaryShipping.state) || null;
        const shipping_postalCode = normalizeStr(primaryShipping.postalCode) || null;
        const shipping_country = normalizeStr(primaryShipping.country) || "India";

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
        if (paymentMethod === "razorpay") {
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

                // Build payload (nested shipping array + flattened primary fields)
                const payload = {
                    // if razorpay exists use that id, otherwise create a unique server order id
                    orderId: razorpayOrderId || `cod_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
                    userId,
                    items,
                    status: paymentMethod === "cod" ? "pending" : "created",
                    paymentMethod,
                    amount: paymentMethod === "razorpay" ? razorpayAmountPaise : Math.round(Number(amount || 0) * 100),
                    currency,
                    razorpayOrderId: razorpayOrderId || null,
                    razorpayRaw: razorpayOrder || null,
                    shipping: shippingArray, // full array preserved
                    // flattened fields for indexing/search
                    shipping_fullName,
                    shipping_phone,
                    shipping_line1,
                    shipping_line2,
                    shipping_city,
                    shipping_state,
                    shipping_postalCode,
                    shipping_country,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
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
            paymentMethod,
            orderId: razorpayOrderId || (savedOrderDoc && savedOrderDoc.orderId) || null,
            amount: paymentMethod === "razorpay" ? razorpayAmountPaise : Math.round(Number(amount || 0) * 100),
            currency,
            razorpayOrder: razorpayOrder || null,
            savedOrderDoc: savedOrderDoc || null,
        };

        return res.json(responsePayload);
    } catch (err) {
        error("Critical error in createOrder:", err.message || err);
        return res.json({ success: false, error: err.message || String(err) }, 500);
    }
};
