// createOrder.js (Appwrite Function) - Fixed returns (non-blocking DB write)
import Razorpay from "razorpay";
import { Client, Databases, ID } from "node-appwrite";

// Top-level clients (may be reused if the container stays warm)
const client = new Client()
    .setEndpoint("https://fra.cloud.appwrite.io/v1")
    .setProject("684c05fe002863accd73");

const databases = new Databases(client);

// Create Razorpay client factory (we still create per-exec because it needs secrets)
const createRazorpayClient = () =>
    new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

// Small helper to safely parse possibly stringified payloads
const safeParse = (raw) => {
    try {
        if (!raw) return {};
        if (typeof raw === "string") return JSON.parse(raw);
        if (typeof raw === "object") return raw;
    } catch {
        try {
            const first = JSON.parse(String(raw || "{}"));
            return typeof first === "object" ? first : {};
        } catch {
            return {};
        }
    }
    return {};
};

export default async ({ req, res, log, error }) => {
    try {
        log("⚡ Create-Order started");

        // Quick check method
        if (req.method !== "POST") {
            if (req.method === "GET") return res.text("🚀 Razorpay Appwrite Function is live");
            return res.json({ success: false, message: `Method ${req.method} not allowed` }, 405);
        }

        // Compose raw input (Appwrite variations)
        const raw =
            req.bodyRaw ||
            req.payload ||
            req.variables?.APPWRITE_FUNCTION_DATA ||
            req.headers?.["x-appwrite-function-data"] ||
            "{}";

        const bodyData = safeParse(raw);
        // Normalize nested body/data if double-stringified
        if (typeof bodyData.body === "string") Object.assign(bodyData, safeParse(bodyData.body));
        if (typeof bodyData.data === "string") Object.assign(bodyData, safeParse(bodyData.data));

        // Extract fields
        const { userId, userID, user, items = [], amount, currency = "INR" } = bodyData || {};
        const resolvedUserId = userId || userID || (user && user.id) || user || null;

        if (!resolvedUserId || typeof amount === "undefined" || amount === null) {
            return res.json({ success: false, message: "userId and amount required" }, 400);
        }

        const intAmount = Number.parseInt(amount, 10);
        if (Number.isNaN(intAmount) || intAmount <= 0) {
            return res.json({ success: false, message: "Amount must be a positive number" }, 400);
        }

        // Create Razorpay order (critical path)
        const razorpay = createRazorpayClient();
        const order = await razorpay.orders.create({
            amount: intAmount * 100, // paise
            currency,
            receipt: `order_rcpt_${Date.now()}`,
        });

        // Prepare lightweight DB fields (fast ops only)
        const safeItemsRaw = Array.isArray(items)
            ? items
            : (typeof items === "string" ? (() => {
                try { return JSON.parse(items); } catch { return []; }
            })() : []);

        const MAX_LABEL_LEN = 490;
        const itemsForDb = safeItemsRaw.map((it, idx) => {
            try {
                if (it && typeof it === "object") {
                    const name = it.name || it.title || `item_${idx + 1}`;
                    const size = it.size ? ` (Size: ${it.size})` : "";
                    const label = `${name}${size}`;
                    return label.length > MAX_LABEL_LEN ? label.slice(0, MAX_LABEL_LEN) + "…" : label;
                }
                const s = String(it || `item_${idx + 1}`);
                return s.length > MAX_LABEL_LEN ? s.slice(0, MAX_LABEL_LEN) + "…" : s;
            } catch {
                return `item_${idx + 1}`;
            }
        });

        // Choose single size (string) from first item that has size (fast)
        let sizeForDb = null;
        if (
            safeItemsRaw.length > 0 &&
            safeItemsRaw[0] &&
            typeof safeItemsRaw[0] === "object" &&
            safeItemsRaw[0].size
        ) {
            sizeForDb = String(safeItemsRaw[0].size);
        }

        // Attempt to stringify items backup but guard by size threshold to avoid heavy allocations + writes
        let itemsJson = null;
        try {
            const j = JSON.stringify(safeItemsRaw);
            const MAX_JSON_SAVE = 10 * 1024; // 10 KB threshold, tune as needed
            if (j.length <= MAX_JSON_SAVE) itemsJson = j;
            else itemsJson = null;
        } catch {
            itemsJson = null;
        }

        // Start background DB worker BEFORE returning response.
        // Fire-and-forget DB write (non-blocking). We handle errors in the background.
        (async () => {
            try {
                // Use header key if provided (ensures permission to write)
                if (req.headers && req.headers["x-appwrite-key"]) client.setKey(req.headers["x-appwrite-key"]);

                const payload = {
                    userId: resolvedUserId,
                    amount: intAmount,
                    amountPaise: order.amount,
                    currency: order.currency,
                    razorpay_order_id: order.id,
                    razorpay_payment_id: null,
                    razorpay_signature: null,
                    status: "unpaid",
                    receipt: order.receipt,
                    items: itemsForDb,
                    size: sizeForDb, // single string or null
                    items_json: itemsJson, // only if small enough; otherwise null
                    createdAt: new Date().toISOString(),
                };

                // Non-blocking write
                databases
                    .createDocument(
                        "68c414290032f31187eb", // Database ID
                        "68c58bfe0001e9581bd4", // Orders collection ID
                        ID.unique(),
                        payload
                    )
                    .then((doc) => {
                        log("Order saved (async):", doc.$id || "(no id)");
                    })
                    .catch((dbErr) => {
                        error("Async DB save failed: " + (dbErr.message || dbErr));
                    });
            } catch (bgErr) {
                error("Background DB worker error: " + (bgErr.message || bgErr));
            }
        })();

        // Return the response (important: do this AFTER starting background worker)
        return res.json({
            success: true,
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
        });
    } catch (err) {
        error("Critical error: " + (err.message || err));
        return res.json({ success: false, error: err.message || String(err) }, 500);
    }
};
