// createOrder.js (Appwrite Function) - Only create Razorpay order
import Razorpay from "razorpay";

const createRazorpayClient = () =>
    new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

export default async ({ req, res, log, error }) => {
    try {
        log("⚡ Create-Order started");

        if (req.method !== "POST") {
            if (req.method === "GET")
                return res.text("🚀 Razorpay Appwrite Function is live");
            return res.json(
                { success: false, message: `Method ${req.method} not allowed` },
                405
            );
        }

        const bodyData = (() => {
            try {
                return JSON.parse(req.bodyRaw || "{}");
            } catch {
                return {};
            }
        })();

        const { amount, currency = "INR" } = bodyData || {};

        if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
            return res.json(
                { success: false, message: "Valid amount required" },
                400
            );
        }

        const razorpay = createRazorpayClient();
        const order = await razorpay.orders.create({
            amount: Number(amount) * 100, // paise
            currency,
            receipt: `order_rcpt_${Date.now()}`,
        });

        log("✅ Razorpay order created:", order.id);

        return res.json({
            success: true,
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
        });
    } catch (err) {
        error("Critical error: " + (err.message || err));
        return res.json(
            { success: false, error: err.message || String(err) },
            500
        );
    }
};