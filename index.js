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

        log("📩 POST request received for Razorpay order - attempting to parse payload");

        // Defensive parse of incoming payload (Appwrite can put it in different places)
        let bodyData = {};
        try {
            const raw =
                (typeof req.bodyRaw !== "undefined" && req.bodyRaw !== null && req.bodyRaw !== "")
                    ? req.bodyRaw
                    : (typeof req.payload !== "undefined" && req.payload !== null && req.payload !== "")
                        ? req.payload
                        : req.variables?.APPWRITE_FUNCTION_DATA || req.headers?.["x-appwrite-function-data"] || "{}";

            if (typeof raw === "string") {
                log("📥 Raw payload string (first 400 chars):", raw.slice ? raw.slice(0, 400) : String(raw));
                try {
                    bodyData = JSON.parse(raw || "{}");
                } catch (e) {
                    // fallback: try parse nested double-stringified content
                    log("⚠️ First JSON.parse failed, trying fallback parse.");
                    try {
                        const firstParse = JSON.parse(raw);
                        bodyData = (firstParse && typeof firstParse === "object") ? firstParse : {};
                    } catch (e2) {
                        // last resort: empty object
                        log("⚠️ Fallback parse failed, using empty object.");
                        bodyData = {};
                    }
                }
            } else if (typeof raw === "object" && raw !== null) {
                bodyData = raw;
            } else {
                bodyData = {};
            }

            // Normalize double-stringified body/data keys if present
            if (typeof bodyData.body === "string") {
                try {
                    const nested = JSON.parse(bodyData.body);
                    if (nested && typeof nested === "object") {
                        bodyData = { ...bodyData, ...nested };
                        log("🔁 Normalized double-stringified 'body' field into payload.");
                    }
                } catch (e) { /* ignore */ }
            }
            if (typeof bodyData.data === "string") {
                try {
                    const nested = JSON.parse(bodyData.data);
                    if (nested && typeof nested === "object") {
                        bodyData = { ...bodyData, ...nested };
                        log("🔁 Normalized double-stringified 'data' field into payload.");
                    }
                } catch (e) { /* ignore */ }
            }
        } catch (parseErr) {
            error("❌ Unexpected parsing error: " + (parseErr.message || parseErr));
            return res.json({ success: false, message: "Invalid JSON or payload format" }, 400);
        }

        log("🔎 Parsed payload (first 400 chars):", JSON.stringify(bodyData).slice(0, 400));

        // Extract expected fields (case-insensitive handling if needed)
        const { userId, userID, user, items = [], amount, currency = "INR" } = bodyData || {};
        const resolvedUserId = userId || userID || (user && user.id) || user || null;

        if (!resolvedUserId || typeof amount === "undefined" || amount === null) {
            return res.json({ success: false, message: "userId and amount required" }, 400);
        }

        const intAmount = parseInt(amount, 10);
        if (isNaN(intAmount) || intAmount <= 0) {
            return res.json({ success: false, message: "Amount must be a positive number" }, 400);
        }

        // Create Razorpay order
        const order = await razorpay.orders.create({
            amount: intAmount * 100, // paise
            currency,
            receipt: `order_rcpt_${Date.now()}`,
        });

        log("✅ Razorpay order created:", order?.id || "(no id)");

        // -------------------------
        // SANITIZE items for Appwrite (items field in collection is String[])
        // -------------------------
        // safeItemsRaw: parsed structured items array (objects or strings)
        const safeItemsRaw = Array.isArray(items)
            ? items
            : (typeof items === "string" ? (() => {
                try { return JSON.parse(items); } catch { return []; }
            })() : []);

        // Convert the structured items into a short String[] for Appwrite
        const MAX_APPUTABLE_LEN = 490; // keep <499 char limit
        const itemsForDb = safeItemsRaw.map((it, idx) => {
            try {
                if (typeof it === "string") {
                    return it.length > MAX_APPUTABLE_LEN ? it.slice(0, MAX_APPUTABLE_LEN) + "…" : it;
                }
                if (it && typeof it === "object") {
                    const label = it.name || it.title || it.sku || it.id || it.productId || `item_${idx + 1}`;
                    const strLabel = String(label);
                    return strLabel.length > MAX_APPUTABLE_LEN ? strLabel.slice(0, MAX_APPUTABLE_LEN) + "…" : strLabel;
                }
                // fallback to JSON string representation
                const s = JSON.stringify(it);
                return s.length > MAX_APPUTABLE_LEN ? s.slice(0, MAX_APPUTABLE_LEN) + "…" : s;
            } catch (e) {
                return String(it).slice(0, MAX_APPUTABLE_LEN);
            }
        });

        // Full JSON backup of items (can be stored even if itemsForDb is truncated)
        let itemsJson = "[]";
        try {
            itemsJson = JSON.stringify(safeItemsRaw);
        } catch (e) {
            try {
                itemsJson = JSON.stringify(safeItemsRaw.map(x => String(x)));
            } catch {
                itemsJson = "[]";
            }
        }

        // -------------------------
        // Persist order in Appwrite DB (non-blocking - we don't hold up the response)
        // -------------------------
        try {
            // Try to save document and wait for result (for debugging / verification)
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
                    items: itemsForDb,           // Appwrite-friendly String[] field
                    items_json: itemsJson,       // Full structured backup
                    verification_raw: null,
                    createdAt: new Date().toISOString(),
                }
            );

            log("✅ Order saved in DB (awaited)", dbDoc.$id || dbDoc);
            // Return the Razorpay order and the saved DB document for immediate verification
            return res.json({
                success: true,
                orderId: order.id,
                amount: order.amount,
                currency: order.currency,
                dbSaved: true,
                dbDoc,
            });
        } catch (err) {
            // If DB save fails, return the Razorpay order info plus the DB error so frontend can inspect
            error("❌ Failed to save order (awaited): " + (err.message || err));
            return res.json({
                success: true,
                orderId: order.id,
                amount: order.amount,
                currency: order.currency,
                dbSaved: false,
                dbError: err.message || String(err),
            });
        }
