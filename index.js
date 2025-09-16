// createOrder.js (Appwrite Function)
import Razorpay from "razorpay";
import { Client, Databases, ID } from "node-appwrite";

export default async ({ req, res, log, error }) => {
    try {
        log("⚡ Razorpay Create-Order Function execution started");

        // Appwrite client
        const client = new Client()
            .setEndpoint("https://fra.cloud.appwrite.io/v1") // replace if needed
            .setProject("684c05fe002863accd73") // replace with your project id
            .setKey(req.headers["x-appwrite-key"] || "");

        const databases = new Databases(client);

        // Razorpay client
        const razorpay = new Razorpay({
            key_id: process.env.RAZORPAY_KEY_ID,
            key_secret: process.env.RAZORPAY_KEY_SECRET,
        });

        if (req.method !== "POST") {
            if (req.method === "GET") return res.text("🚀 Razorpay Appwrite Function is live");
            return res.json({ success: false, message: `Method ${req.method} not allowed` }, 405);
        }

        // ----------------- Parse Payload -----------------
        let bodyData = {};
        try {
            const raw =
                req.bodyRaw ||
                req.payload ||
                req.variables?.APPWRITE_FUNCTION_DATA ||
                req.headers?.["x-appwrite-function-data"] ||
                "{}";

            if (typeof raw === "string") {
                try {
                    bodyData = JSON.parse(raw || "{}");
                } catch {
                    try {
                        const firstParse = JSON.parse(raw);
                        bodyData = typeof firstParse === "object" ? firstParse : {};
                    } catch {
                        bodyData = {};
                    }
                }
            } else if (typeof raw === "object" && raw !== null) {
                bodyData = raw;
            }
        } catch (parseErr) {
            error("❌ Parsing error: " + (parseErr.message || parseErr));
            return res.json({ success: false, message: "Invalid JSON or payload format" }, 400);
        }

        log("🔎 Parsed payload (first 400 chars):", JSON.stringify(bodyData).slice(0, 400));

        // Extract fields
        const { userId, userID, user, items = [], amount, currency = "INR" } = bodyData || {};
        const resolvedUserId = userId || userID || (user && user.id) || user || null;

        if (!resolvedUserId || typeof amount === "undefined" || amount === null) {
            return res.json({ success: false, message: "userId and amount required" }, 400);
        }

        const intAmount = parseInt(amount, 10);
        if (isNaN(intAmount) || intAmount <= 0) {
            return res.json({ success: false, message: "Amount must be a positive number" }, 400);
        }

        // ----------------- Create Razorpay Order -----------------
        const order = await razorpay.orders.create({
            amount: intAmount * 100, // paise
            currency,
            receipt: `order_rcpt_${Date.now()}`,
        });
        log("✅ Razorpay order created:", order?.id || "(no id)");

        // ----------------- Items + single Size (string) -----------------
        const safeItemsRaw = Array.isArray(items)
            ? items
            : (typeof items === "string" ? (() => {
                try { return JSON.parse(items); } catch { return []; }
            })() : []);

        const MAX_LEN = 490;

        // For Appwrite `items` field (String[]) - include name + size in label
        const itemsForDb = safeItemsRaw.map((it, idx) => {
            try {
                if (typeof it === "object" && it !== null) {
                    const name = it.name || it.title || `item_${idx + 1}`;
                    const size = it.size ? ` (Size: ${it.size})` : "";
                    const label = `${name}${size}`;
                    return label.length > MAX_LEN ? label.slice(0, MAX_LEN) + "…" : label;
                }
                const str = String(it);
                return str.length > MAX_LEN ? str.slice(0, MAX_LEN) + "…" : str;
            } catch {
                return `item_${idx + 1}`;
            }
        });

        // Single size string: take from the first item that has size, else null
        let sizeForDb = null;
        try {
            for (let i = 0; i < safeItemsRaw.length; i++) {
                const it = safeItemsRaw[i];
                if (it && typeof it === "object" && it.size) {
                    sizeForDb = String(it.size);
                    break;
                }
            }
        } catch (e) {
            sizeForDb = null;
        }

        // Full JSON backup
        let itemsJson = "[]";
        try {
            itemsJson = JSON.stringify(safeItemsRaw);
        } catch {
            itemsJson = "[]";
        }

        // ----------------- Save to DB -----------------
        try {
            const dbDoc = await databases.createDocument(
                "68c414290032f31187eb", // Database ID
                "68c58bfe0001e9581bd4", // Orders collection ID
                ID.unique(),
                {
                    userId: resolvedUserId,
                    amount: intAmount,
                    amountPaise: order.amount,
                    currency: order.currency,
                    razorpay_order_id: order.id,
                    razorpay_payment_id: null,
                    razorpay_signature: null,
                    status: "unpaid",
                    receipt: order.receipt,
                    items: itemsForDb,     // ["Product Name (Size: 30)"]
                    size: sizeForDb,       // "30" (single string) or null
                    items_json: itemsJson, // full structured backup
                    // $createdAt: new Date().toISOString(),
                }
            );

            log("✅ Order saved in DB", dbDoc.$id || dbDoc);
            return res.json({
                success: true,
                orderId: order.id,
                amount: order.amount,
                currency: order.currency,
                dbSaved: true,
                dbDoc,
            });
        } catch (err) {
            error("❌ Failed to save order: " + (err.message || err));
            return res.json({
                success: true,
                orderId: order.id,
                amount: order.amount,
                currency: order.currency,
                dbSaved: false,
                dbError: err.message || String(err),
            });
        }
    } catch (err) {
        error("Unexpected error: " + (err.message || err));
        return res.json({ success: false, error: err.message || String(err) }, 500);
    }
};
