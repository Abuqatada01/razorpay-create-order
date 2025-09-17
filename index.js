// createOrder.js (Appwrite Function) - Create Razorpay order AND save address/phone to orders collection
import Razorpay from "razorpay";
import pkg from "node-appwrite";
const { Client: AppwriteClient, Databases, Query } = pkg;

const createRazorpayClient = () =>
    new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

/**
 * Expected POST body (JSON):
 * {
 *   "amount": 1000,           // in rupees (number)
 *   "currency": "INR",        // optional
 *   "userId": "user_xxx",     // optional - your user id
 *   "items": [...],           // optional - order items
 *   "shipping": {             // optional - shipping object to save
 *     "fullName": "...",
 *     "phone": "...",
 *     "line1": "...",
 *     "line2": "...",
 *     "city": "...",
 *     "state": "...",
 *     "postalCode": "...",
 *     "country": "India"
 *   }
 * }
 */
export default async ({ req, res, log, error }) => {
    try {
        log("⚡ Create-Order started");

        if (req.method !== "POST") {
            if (req.method === "GET")
                return res.text("🚀 Razorpay + Appwrite createOrder function is live");
            return res.json({ success: false, message: `Method ${req.method} not allowed` }, 405);
        }

        // parse body safely
        const bodyData = (() => {
            try {
                return JSON.parse(req.bodyRaw || "{}");
            } catch {
                return {};
            }
        })();

        const { amount, currency = "INR", userId = null, items = [], shipping = null } = bodyData || {};

        if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
            return res.json({ success: false, message: "Valid amount required" }, 400);
        }

        // create razorpay client & order
        const razorpay = createRazorpayClient();
        const razorpayOrder = await razorpay.orders.create({
            amount: Math.round(Number(amount) * 100), // paise
            currency,
            receipt: `order_rcpt_${Date.now()}`,
        });

        log("✅ Razorpay order created:", razorpayOrder.id);

        // Try to persist order + shipping in Appwrite DB (if env provided)
        const APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT;
        const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
        const APPWRITE_API_KEY = process.env.APPWRITE_API_KEY;
        const APPWRITE_DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
        const APPWRITE_ORDERS_COLLECTION_ID = process.env.APPWRITE_ORDERS_COLLECTION_ID;

        let savedOrderDoc = null;
        if (APPWRITE_ENDPOINT && APPWRITE_PROJECT_ID && APPWRITE_API_KEY && APPWRITE_DATABASE_ID && APPWRITE_ORDERS_COLLECTION_ID) {
            try {
                log("🔁 Initializing Appwrite client for saving order");

                const client = new AppwriteClient()
                    .setEndpoint(APPWRITE_ENDPOINT)
                    .setProject(APPWRITE_PROJECT_ID)
                    .setKey(APPWRITE_API_KEY);

                const databases = new Databases(client);

                // payload we want to persist
                const payload = {
                    orderId: razorpayOrder.id, // use razorpay order id as canonical id
                    razorpayAmount: razorpayOrder.amount,
                    razorpayCurrency: razorpayOrder.currency,
                    receipt: razorpayOrder.receipt,
                    userId,
                    items,
                    shipping: shipping || {},
                    status: "created",
                    $createdAt: new Date().toISOString(),
                };

                // Try to find existing doc by orderId (avoid duplicates)
                let existing = null;
                try {
                    const list = await databases.listDocuments(APPWRITE_DATABASE_ID, APPWRITE_ORDERS_COLLECTION_ID, [
                        Query.equal("orderId", razorpayOrder.id),
                        Query.limit(1),
                    ]);
                    existing = (list?.documents || [])[0] || null;
                } catch (qerr) {
                    // If query fails (no index), we will fall through and create new doc
                    log("Query for existing order failed (will try create):", qerr.message || qerr);
                }

                if (existing) {
                    log("🔄 Updating existing Appwrite order doc:", existing.$id);
                    savedOrderDoc = await databases.updateDocument(APPWRITE_DATABASE_ID, APPWRITE_ORDERS_COLLECTION_ID, existing.$id, {
                        ...existing,
                        ...payload,
                        $updatedAt: new Date().toISOString(),
                    });
                } else {
                    log("➕ Creating new Appwrite order doc");
                    // createDocument requires a unique ID; let Appwrite client create one using ID.unique()
                    const { ID } = pkg; // node-appwrite exports ID too
                    savedOrderDoc = await databases.createDocument(APPWRITE_DATABASE_ID, APPWRITE_ORDERS_COLLECTION_ID, ID.unique(), payload);
                }

                log("✅ Order saved to Appwrite orders collection:", savedOrderDoc.$id);
            } catch (dbErr) {
                // non-fatal — log and continue, but include error info in response
                error("Error saving order to Appwrite DB:", dbErr.message || dbErr);
            }
        } else {
            log("ℹ️ Appwrite DB env not fully configured — skipping DB save");
        }

        // Respond with Razorpay order details and saved document (if any)
        return res.json({
            success: true,
            orderId: razorpayOrder.id,
            amount: razorpayOrder.amount,
            currency: razorpayOrder.currency,
            razorpayOrder: razorpayOrder,
            savedOrderDoc: savedOrderDoc || null,
        });
    } catch (err) {
        error("Critical error: " + (err.message || err));
        return res.json({ success: false, error: err.message || String(err) }, 500);
    }
};
