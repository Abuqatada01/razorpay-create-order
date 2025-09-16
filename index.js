// createOrder.js
// Usage: import createOrderHandler and mount on your Express app.
// Assumptions: `databases` is Appwrite Databases client, `ID` from Appwrite, `Razorpay` SDK present.

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { Client, Databases, ID } = require("appwrite"); // appwrite SDK vX
const Razorpay = require("razorpay");

const router = express.Router();
router.use(bodyParser.json({ limit: "200kb" })); // avoid huge payloads

// --- Config ---
const MAX_ATTR_LEN = parseInt(process.env.MAX_ATTR_LEN || "499", 10);
const APPWRITE_DB_ID = process.env.APPWRITE_DATABASE_ID;
const APPWRITE_COLLECTION_ID = process.env.APPWRITE_COLLECTION_ID;

// --- Init Appwrite client (adjust to your environment) ---
const client = new Client();
client
    .setEndpoint(process.env.APPWRITE_ENDPOINT || "https://[APPWRITE_ENDPOINT]/v1")
    .setProject(process.env.APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(client);

// --- Init Razorpay (optional; only if you create orders here) ---
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// --- Utility helpers ---
function safeStringifyItem(item) {
    // Try compact JSON, then sensible summary, then truncate.
    try {
        const short = JSON.stringify(item);
        if (short.length <= MAX_ATTR_LEN) return short;
        const summary = `${item.name || item.productId || "item"}|q:${item.quantity ?? 1}|id:${item.productId ?? ""}`;
        if (summary.length <= MAX_ATTR_LEN) return summary;
        return short.slice(0, MAX_ATTR_LEN - 3) + "...";
    } catch (e) {
        const fallback = String(item).slice(0, MAX_ATTR_LEN - 3) + "...";
        return fallback;
    }
}

function normalizeItems(itemsRaw) {
    // Accept array, JSON string, or single object; always return array of plain objects.
    let safeItems = [];
    if (Array.isArray(itemsRaw)) safeItems = itemsRaw;
    else if (typeof itemsRaw === "string") {
        try { safeItems = JSON.parse(itemsRaw); }
        catch { safeItems = []; }
    } else if (itemsRaw && typeof itemsRaw === "object") safeItems = [itemsRaw];
    else safeItems = [];
    return safeItems.map(it => {
        // ensure basic shape and types
        return {
            productId: it.productId ? String(it.productId) : (it.id ? String(it.id) : ""),
            name: it.name ? String(it.name) : "",
            price: Number(it.price || 0),
            quantity: Number(it.quantity || 1),
            size: it.size ? String(it.size) : undefined,
            meta: it.meta || null,
        };
    });
}

function scrubPaymentObject(orderOrPayment) {
    // keep only safe fields for logs; avoid logging signatures or full payloads
    if (!orderOrPayment || typeof orderOrPayment !== "object") return null;
    const { id, amount, currency, receipt } = orderOrPayment;
    return { id, amount, currency, receipt };
}

// --- Route handler ---
// POST /create-order
// Expected body shape (one example):
// {
//   userId: "user_123",
//   items: [{ productId, name, price, quantity, size }],
//   createRazorpayOrder: true,   // optional boolean
//   currency: "INR",
//   notes: { ... }  // optional razorpay notes
// }
router.post("/create-order", async (req, res) => {
    try {
        const { userId, items, createRazorpayOrder = true, currency = "INR", notes = {}, intAmount } = req.body;

        if (!userId) return res.status(400).json({ success: false, message: "Missing userId" });

        // Normalize & validate items
        const safeItems = normalizeItems(items);
        if (!safeItems.length) return res.status(400).json({ success: false, message: "No items provided" });

        // Calculate amount if intAmount not provided (in paise if you want)
        // Expect incoming price to be rupees. You may adapt to your app.
        const computedAmount = safeItems.reduce((sum, it) => sum + (Number(it.price || 0) * (Number(it.quantity) || 1)), 0);
        const amountToUse = typeof intAmount === "number" ? intAmount : Math.round(computedAmount * 100); // paise

        // Create Razorpay order (if requested)
        let razorpayOrder = null;
        if (createRazorpayOrder) {
            const payload = {
                amount: amountToUse, // integer in smallest currency unit
                currency,
                receipt: `rcpt_${Date.now()}`,
                payment_capture: 1,
                notes,
            };
            try {
                razorpayOrder = await razorpay.orders.create(payload);
            } catch (rzErr) {
                console.error("Razorpay order creation failed:", rzErr);
                // Return 502 to indicate upstream payment provider issue
                return res.status(502).json({ success: false, message: "Failed to create Razorpay order", detail: String(rzErr) });
            }
        }

        // Convert safeItems into Appwrite-friendly string array AND optional productIds array for querying
        const itemsStrings = safeItems.map(safeStringifyItem);
        const productIds = safeItems.map(it => it.productId || "");

        // Log trimmed info for debugging
        console.info("Creating DB order for user:", userId, "items:", safeItems.length, "computedAmount:", computedAmount, "paise:", amountToUse);
        // Persist to Appwrite
        const docPayload = {
            userId,
            amount: Math.round(amountToUse / 100), // store rupee amount too
            amountPaise: amountToUse,
            currency,
            razorpay_order_id: razorpayOrder ? razorpayOrder.id : null,
            razorpay_payment_id: null,
            razorpay_signature: null,
            status: "unpaid",
            receipt: razorpayOrder ? razorpayOrder.receipt : null,
            items: itemsStrings,                     // array<string>
            items_json: JSON.stringify(safeItems),   // full backup
            productIds,                              // array<string> useful for queries
            verification_raw: null,
            createdAt: new Date().toISOString(),
        };

        let createdDoc;
        try {
            createdDoc = await databases.createDocument(
                APPWRITE_DB_ID,
                APPWRITE_COLLECTION_ID,
                ID.unique(),
                docPayload
            );
        } catch (dbErr) {
            console.error("Appwrite DB save failed:", dbErr);
            // Attempt a cleanup: if you created a Razorpay order but DB failed, you may want to cancel the order.
            // Note: Razorpay's API may not support cancel order; handle per your business logic.
            return res.status(500).json({
                success: false,
                message: "Order created in Razorpay but failed to save in DB",
                order: scrubPaymentObject(razorpayOrder),
                dbError: dbErr?.message || String(dbErr),
            });
        }

        // Success — respond with minimal safe data
        return res.status(201).json({
            success: true,
            message: "Order created and saved",
            order: {
                razorpay_order_id: razorpayOrder ? razorpayOrder.id : null,
                amountPaise: amountToUse,
                currency,
                receipt: razorpayOrder ? razorpayOrder.receipt : null,
            },
            documentId: createdDoc.$id,
        });

    } catch (err) {
        console.error("Unexpected error in create-order:", err);
        return res.status(500).json({ success: false, message: "Internal server error", error: String(err) });
    }
});

module.exports = router;
