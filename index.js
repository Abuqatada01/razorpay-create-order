// // createOrder.js (Appwrite Function - with external-call timeout)
// import Razorpay from "razorpay";
// import { Client, Databases, ID } from "node-appwrite";

// const promiseWithTimeout = (p, ms, timeoutMessage = "Operation timed out") =>
//     new Promise((resolve, reject) => {
//         const timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
//         p
//             .then((res) => {
//                 clearTimeout(timer);
//                 resolve(res);
//             })
//             .catch((err) => {
//                 clearTimeout(timer);
//                 reject(err);
//             });
//     });

// export default async ({ req, res, log, error }) => {
//     try {
//         log("⚡ Razorpay Create-Order Function started");

//         // Appwrite client
//         const client = new Client()
//             .setEndpoint("https://fra.cloud.appwrite.io/v1")
//             .setProject("684c05fe002863accd73")
//             .setKey(req.headers["x-appwrite-key"] || "");
//         const databases = new Databases(client);

//         // Razorpay client
//         const razorpay = new Razorpay({
//             key_id: process.env.RAZORPAY_KEY_ID,
//             key_secret: process.env.RAZORPAY_KEY_SECRET,
//         });

//         if (req.method !== "POST") {
//             if (req.method === "GET") return res.text("🚀 Razorpay Appwrite Function is live");
//             return res.json({ success: false, message: `Method ${req.method} not allowed` }, 405);
//         }

//         log("📩 POST received - parsing payload");

//         // Defensive parse
//         let bodyData = {};
//         try {
//             const raw =
//                 req.bodyRaw ||
//                 req.payload ||
//                 req.variables?.APPWRITE_FUNCTION_DATA ||
//                 req.headers?.["x-appwrite-function-data"] ||
//                 "{}";

//             if (typeof raw === "string") {
//                 try {
//                     bodyData = JSON.parse(raw || "{}");
//                 } catch {
//                     // try to handle nested stringified body
//                     try {
//                         const p = JSON.parse(raw);
//                         bodyData = (p && typeof p === "object") ? p : {};
//                     } catch {
//                         bodyData = {};
//                     }
//                 }
//             } else if (typeof raw === "object" && raw !== null) {
//                 bodyData = raw;
//             } else {
//                 bodyData = {};
//             }

//             // Normalize double-stringified body/data if present
//             if (typeof bodyData.body === "string") {
//                 try { Object.assign(bodyData, JSON.parse(bodyData.body)); } catch { }
//             }
//             if (typeof bodyData.data === "string") {
//                 try { Object.assign(bodyData, JSON.parse(bodyData.data)); } catch { }
//             }
//         } catch (parseErr) {
//             error("Parsing error: " + (parseErr.message || parseErr));
//             return res.json({ success: false, message: "Invalid JSON or payload" }, 400);
//         }

//         const { userId, items = [], amount, currency = "INR" } = bodyData || {};

//         if (!userId || typeof amount === "undefined" || amount === null) {
//             return res.json({ success: false, message: "userId and amount required" }, 400);
//         }

//         const intAmount = parseInt(amount, 10);
//         if (isNaN(intAmount) || intAmount <= 0) {
//             return res.json({ success: false, message: "Amount must be a positive number" }, 400);
//         }

//         // Create Razorpay order with timeout (10s)
//         const CREATE_TIMEOUT_MS = 10000; // 10 seconds - adjust if necessary but keep << 30000

//         let order;
//         try {
//             order = await promiseWithTimeout(
//                 razorpay.orders.create({
//                     amount: intAmount * 100,
//                     currency,
//                     receipt: `order_rcpt_${Date.now()}`,
//                 }),
//                 CREATE_TIMEOUT_MS,
//                 "Razorpay order creation timed out"
//             );
//         } catch (e) {
//             // Network / timeout / Razorpay failure - respond quickly so Appwrite doesn't hit 30s limit
//             error("Razorpay create error: " + (e.message || e));
//             // helpful client error code and message
//             return res.json({ success: false, message: "Payment gateway unavailable. Please try again." }, 503);
//         }

//         log("✅ Razorpay order created:", order?.id || "(no id)");

//         // Persist order non-blocking
//         const safeItems = Array.isArray(items)
//             ? items
//             : typeof items === "string"
//                 ? (() => {
//                     try {
//                         return JSON.parse(items);
//                     } catch {
//                         return [];
//                     }
//                 })()
//                 : [];

//         databases
//             .createDocument(
//                 "68c414290032f31187eb",
//                 "68c58bfe0001e9581bd4",
//                 ID.unique(),
//                 {
//                     userId,
//                     amount: intAmount,
//                     amountPaise: order.amount,
//                     currency: order.currency,
//                     razorpay_order_id: order.id,
//                     razorpay_payment_id: null,
//                     razorpay_signature: null,
//                     status: "unpaid",
//                     receipt: order.receipt,
//                     items: safeItems,
//                     items_json: JSON.stringify(safeItems),
//                     verification_raw: null,
//                     createdAt: new Date().toISOString(),
//                 }
//             )
//             .then(() => log("✅ Order saved in DB"))
//             .catch((err) => error("DB save failed: " + (err.message || err)));

//         // Respond immediately with the order required by frontend
//         return res.json({
//             success: true,
//             orderId: order.id,
//             amount: order.amount,
//             currency: order.currency,
//         });
//     } catch (err) {
//         error("Unexpected error: " + (err.message || err));
//         return res.json({ success: false, error: err.message || String(err) }, 500);
//     }
// };
// createOrder_debug.js (temporary – awaits DB save & returns saved doc)
import Razorpay from "razorpay";
import { Client, Databases, ID } from "node-appwrite";

const promiseWithTimeout = (p, ms, timeoutMessage = "Operation timed out") =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
        p.then(r => { clearTimeout(timer); resolve(r); })
            .catch(e => { clearTimeout(timer); reject(e); });
    });

export default async ({ req, res, log, error }) => {
    try {
        log("⚡ Razorpay Create-Order (DEBUG) started");

        const client = new Client()
            .setEndpoint("https://fra.cloud.appwrite.io/v1")
            .setProject("684c05fe002863accd73")
            .setKey(req.headers["x-appwrite-key"] || "");

        const databases = new Databases(client);

        const razorpay = new Razorpay({
            key_id: process.env.RAZORPAY_KEY_ID,
            key_secret: process.env.RAZORPAY_KEY_SECRET,
        });

        if (req.method !== "POST") {
            if (req.method === "GET") return res.text("🚀 Razorpay Appwrite Function is live (DEBUG)");
            return res.json({ success: false, message: `Method ${req.method} not allowed` }, 405);
        }

        log("📩 POST received - parsing payload (DEBUG)");

        // --- Defensive parse (same as before) ---
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
                        const p = JSON.parse(raw);
                        bodyData = (p && typeof p === "object") ? p : {};
                    } catch {
                        bodyData = {};
                    }
                }
            } else if (typeof raw === "object" && raw !== null) {
                bodyData = raw;
            } else {
                bodyData = {};
            }

            if (typeof bodyData.body === "string") {
                try { Object.assign(bodyData, JSON.parse(bodyData.body)); } catch { }
            }
            if (typeof bodyData.data === "string") {
                try { Object.assign(bodyData, JSON.parse(bodyData.data)); } catch { }
            }
        } catch (parseErr) {
            error("Parsing error (DEBUG): " + (parseErr.message || parseErr));
            return res.json({ success: false, message: "Invalid JSON or payload" }, 400);
        }

        log("🔎 Parsed payload (DEBUG):", JSON.stringify(bodyData).slice(0, 800));

        const { userId, items = [], amount, currency = "INR" } = bodyData || {};

        if (!userId || typeof amount === "undefined" || amount === null) {
            return res.json({ success: false, message: "userId and amount required" }, 400);
        }

        const intAmount = parseInt(amount, 10);
        if (isNaN(intAmount) || intAmount <= 0) {
            return res.json({ success: false, message: "Amount must be a positive number" }, 400);
        }

        // Create Razorpay order (bounded timeout)
        let order;
        try {
            order = await promiseWithTimeout(
                razorpay.orders.create({
                    amount: intAmount * 100,
                    currency,
                    receipt: `order_rcpt_${Date.now()}`,
                }),
                10000,
                "Razorpay order creation timed out (DEBUG)"
            );
        } catch (e) {
            error("Razorpay create error (DEBUG): " + (e.message || e));
            return res.json({ success: false, message: "Payment gateway unavailable. Try again." }, 503);
        }

        log("✅ Razorpay order created (DEBUG):", order?.id || "(no id)");

        // Normalize items into safeItems (array)
        let safeItems = [];
        if (Array.isArray(items)) safeItems = items;
        else if (typeof items === "string") {
            try { safeItems = JSON.parse(items); } catch { safeItems = []; }
        } else if (items && typeof items === "object") {
            // maybe a single item object — wrap it
            safeItems = [items];
        } else {
            safeItems = [];
        }

        log("📦 safeItems that will be saved (DEBUG):", JSON.stringify(safeItems).slice(0, 1000));

        // ===== AWAIT the DB save so we can detect errors =====
        try {
            const created = await databases.createDocument(
                "68c414290032f31187eb",
                "68c58bfe0001e9581bd4",
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
            );

            log("✅ Order saved in DB (DEBUG). Document ID:", created.$id);

            // Return the created document to frontend for immediate verification
            return res.json({
                success: true,
                orderId: order.id,
                amount: order.amount,
                currency: order.currency,
                savedDocument: created,
            });
        } catch (dbErr) {
            error("❌ DB save failed (DEBUG): " + (dbErr.message || dbErr));
            // return the order info but indicate DB failure
            return res.json({
                success: false,
                message: "Order created in Razorpay but failed to save in DB",
                order: { id: order.id, amount: order.amount, currency: order.currency },
                dbError: (dbErr.message || String(dbErr)),
            }, 500);
        }
    } catch (err) {
        error("Unexpected error (DEBUG): " + (err.message || err));
        return res.json({ success: false, error: err.message || String(err) }, 500);
    }
};
