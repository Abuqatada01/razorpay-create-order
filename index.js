// createOrder.js (Appwrite Function - updated)
import Razorpay from "razorpay";
import { Client, Databases, ID } from "node-appwrite";

export default async ({ req, res, log, error }) => {
    try {
        log("⚡ Razorpay Create-Order Function execution started");

        // Appwrite client
        const client = new Client()
            .setEndpoint("https://fra.cloud.appwrite.io/v1")
            .setProject("684c05fe002863accd73")
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

        // Defensive parse: Appwrite might put the payload in different properties
        let bodyData = {};
        try {
            const rawCandidates = {
                bodyRaw: req.bodyRaw,
                payload: req.payload,
                variables_APPWRITE_FUNCTION_DATA: req.variables?.APPWRITE_FUNCTION_DATA,
                header_x_appwrite_function_data: req.headers?.["x-appwrite-function-data"] || null,
            };
            log("📥 Raw candidates (keys):", Object.keys(rawCandidates).filter(k => rawCandidates[k] != null));

            // Prefer bodyRaw -> payload -> variables.APPWRITE_FUNCTION_DATA -> header
            let raw =
                (typeof req.bodyRaw !== "undefined" && req.bodyRaw !== null && req.bodyRaw !== "")
                    ? req.bodyRaw
                    : (typeof req.payload !== "undefined" && req.payload !== null && req.payload !== "")
                        ? req.payload
                        : req.variables?.APPWRITE_FUNCTION_DATA || req.headers?.["x-appwrite-function-data"] || "{}";

            // If raw is an object already, use as-is; if string, try parse
            if (typeof raw === "string") {
                log("📥 Raw payload string (first 400 chars):", raw.slice ? raw.slice(0, 400) : String(raw));
                try {
                    bodyData = JSON.parse(raw || "{}");
                } catch (e) {
                    // If parsing fails, it might be double-stringified like: { body: "{...}" }
                    log("⚠️ First JSON.parse failed for raw payload, attempting fallback parse.");
                    try {
                        const firstParse = JSON.parse(raw);
                        if (firstParse && typeof firstParse === "object") {
                            bodyData = firstParse;
                        } else {
                            bodyData = {};
                        }
                    } catch (e2) {
                        // final fallback to empty object
                        log("⚠️ Fallback parse failed, using empty object.");
                        bodyData = {};
                    }
                }
            } else if (typeof raw === "object" && raw !== null) {
                bodyData = raw;
            } else {
                bodyData = {};
            }

            // Normalize if the payload contains a stringified "body" or "data" key (common double-stringify)
            if (typeof bodyData.body === "string") {
                try {
                    const nested = JSON.parse(bodyData.body);
                    if (nested && typeof nested === "object") {
                        bodyData = { ...bodyData, ...nested };
                        log("🔁 Normalized double-stringified 'body' field into payload.");
                    }
                } catch (e) {
                    // ignore if not parseable
                }
            }
            if (typeof bodyData.data === "string") {
                try {
                    const nested = JSON.parse(bodyData.data);
                    if (nested && typeof nested === "object") {
                        bodyData = { ...bodyData, ...nested };
                        log("🔁 Normalized double-stringified 'data' field into payload.");
                    }
                } catch (e) { }
            }
        } catch (parseErr) {
            error("❌ Unexpected parsing error: " + (parseErr.message || parseErr));
            return res.json({ success: false, message: "Invalid JSON or payload format" }, 400);
        }

        log("🔎 Parsed payload (first 400 chars):", JSON.stringify(bodyData).slice(0, 400));

        // Ensure required fields and defensive defaults
        const { userId, items = [], amount, currency = "INR" } = bodyData || {};

        // Validate
        if (!userId || typeof amount === "undefined" || amount === null) {
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

        // Persist order in Appwrite DB (do NOT block response success returned to frontend)
        const safeItems = Array.isArray(items) ? items : (typeof items === "string" ? (() => {
            try { return JSON.parse(items); } catch { return []; }
        })() : []);

        databases
            .createDocument(
                "68c414290032f31187eb", // Database ID
                "68c58bfe0001e9581bd4", // Orders collection ID
                ID.unique(),
                {
                    userId,
                    amount: intAmount,
                    amountPaise: order.amount,
                    currency: order.currency,
                    razorpay_order_id: order.id,
                    razorpay_payment_id: null,
                    razorpay_signature: null,
                    status: "unpaid",
                    receipt: order.receipt,
                    items: safeItems,
                    items_json: JSON.stringify(safeItems),
                    verification_raw: null,
                    createdAt: new Date().toISOString(),
                }
            )
            .then(() => log("✅ Order saved in DB"))
            .catch((err) => error("❌ Failed to save order: " + (err.message || err)));

        // Respond immediately with the order details frontend needs
        return res.json({
            success: true,
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
        });
    } catch (err) {
        error("Unexpected error: " + (err.message || err));
        return res.json({ success: false, error: err.message || String(err) }, 500);
    }
};
