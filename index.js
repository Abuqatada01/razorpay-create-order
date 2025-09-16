const Razorpay = require("razorpay");
const { Client, Databases, ID } = require("node-appwrite");

module.exports = async function (req, res) {
    try {
        const razorpay = new Razorpay({
            key_id: process.env.RAZORPAY_KEY_ID,
            key_secret: process.env.RAZORPAY_KEY_SECRET,
        });

        const payload = JSON.parse(req.bodyRaw || "{}");
        const { amount, currency = "INR", userId } = payload;

        if (!amount || !userId) {
            return res.json({ success: false, message: "amount and userId required" });
        }

        // 1. Create Razorpay Order
        const order = await razorpay.orders.create({
            amount: amount * 100, // paise
            currency,
            receipt: `rcpt_${Date.now()}`,
            notes: { userId },
        });

        // 2. Appwrite DB (using Dynamic API Key)
        const client = new Client()
            .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT)
            .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
            .setKey(req.headers['x-appwrite-key']); // Dynamic Key

        const databases = new Databases(client);

        await databases.createDocument(
            process.env.APPWRITE_DATABASE_ID,
            process.env.APPWRITE_ORDERS_COLLECTION_ID,
            ID.unique(),
            {
                userId,
                amount,
                currency,
                razorpay_order_id: order.id,
                status: "created",
            }
        );

        return res.json({ success: true, order });
    } catch (err) {
        return res.json({ success: false, message: err.message });
    }
};
